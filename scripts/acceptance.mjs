import ExcelJS from "exceljs";

const baseUrl = process.env.ACCEPTANCE_BASE_URL || "http://127.0.0.1:13280";
const username = process.env.ACCEPTANCE_USERNAME || process.env.ADMIN_USERNAME || "admin";
const password = process.env.ACCEPTANCE_PASSWORD || process.env.ADMIN_PASSWORD;
if (!password) throw new Error("缺少 ACCEPTANCE_PASSWORD");

let cookie = "";
async function request(path, options = {}) {
  const { binary = false, ...fetchOptions } = options;
  const isForm = fetchOptions.body instanceof FormData;
  const response = await fetch(baseUrl + path, {
    ...fetchOptions,
    headers: {
      ...(fetchOptions.body && !isForm ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...fetchOptions.headers,
    },
    body: fetchOptions.body && !isForm && typeof fetchOptions.body !== "string"
      ? JSON.stringify(fetchOptions.body)
      : fetchOptions.body,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const type = response.headers.get("content-type") || "";
  const result = response.status === 204
    ? null
    : binary ? Buffer.from(await response.arrayBuffer())
      : type.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path}: ${response.status} ${JSON.stringify(result)}`);
  }
  return result;
}

async function requestFailure(path, options = {}, expectedStatus = 400) {
  const isForm = options.body instanceof FormData;
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: {
      ...(options.body && !isForm ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...options.headers,
    },
    body: options.body && !isForm && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  const result = await response.json().catch(() => null);
  if (response.status !== expectedStatus) throw new Error(`${options.method || "GET"} ${path}: expected ${expectedStatus}, received ${response.status}`);
  return result;
}

async function findImportedRecord(tableId, fieldId, value) {
  const filters = encodeURIComponent(JSON.stringify([{ fieldId, operator: "eq", value }]));
  const page = await request(`/api/tables/${tableId}/records?limit=10&after=0&filters=${filters}`);
  if (page.records.length !== 1) throw new Error(`导入记录回读失败: ${value}`);
  return page.records[0];
}

const health = await request("/api/health");
if (!health.ok || health.database !== "connected") throw new Error("健康检查失败");
const unauth = await fetch(baseUrl + "/api/bases");
if (unauth.status !== 401) throw new Error(`未登录接口应返回 401，实际 ${unauth.status}`);

await request("/api/auth/login", { method: "POST", body: { username, password } });
const bases = await request("/api/bases");
if (!bases.length) throw new Error("没有演示项目");
const tables = await request(`/api/bases/${bases[0].id}/tables`);
if (!tables.length) throw new Error("没有演示数据表");
const schema = await request(`/api/tables/${tables[0].id}/schema`);
for (const type of ["text", "number", "date", "select"]) {
  if (!schema.fields.some((field) => field.type === type)) throw new Error(`缺少 ${type} 字段`);
}

const originalBaseName = bases[0].name;
const renamedBaseName = `${originalBaseName}-验收`;
await request(`/api/bases/${bases[0].id}`, { method: "PATCH", body: { name: renamedBaseName } });
let renamedBases = await request("/api/bases");
if (!renamedBases.some((base) => base.id === bases[0].id && base.name === renamedBaseName)) throw new Error("项目重命名回读失败");
await request(`/api/bases/${bases[0].id}`, { method: "PATCH", body: { name: originalBaseName } });

const originalTableName = tables[0].name;
const renamedTableName = `${originalTableName}-验收`;
await request(`/api/tables/${tables[0].id}`, { method: "PATCH", body: { name: renamedTableName } });
let renamedTables = await request(`/api/bases/${bases[0].id}/tables`);
if (!renamedTables.some((table) => table.id === tables[0].id && table.name === renamedTableName)) throw new Error("数据表重命名回读失败");
await request(`/api/tables/${tables[0].id}`, { method: "PATCH", body: { name: originalTableName } });

const samplePage = await request(`/api/tables/${tables[0].id}/records?limit=10&after=0`);
const viewField = schema.fields.find((field) => field.type === "text" && samplePage.records.some((record) => record.values?.[field.id]));
if (!viewField) throw new Error("找不到可用于视图验收的文本字段");
const viewValue = samplePage.records.find((record) => record.values?.[viewField.id]).values[viewField.id];
const savedView = await request(`/api/tables/${tables[0].id}/views`, {
  method: "POST",
  body: {
    name: `验收视图-${Date.now()}`,
    config: { filters: [{ fieldId: viewField.id, operator: "eq", value: viewValue }], columnWidths: { [viewField.id]: 286 } },
  },
});
if (savedView.config?.filters?.length !== 1 || Number(savedView.config?.columnWidths?.[viewField.id]) !== 286) {
  throw new Error("新视图筛选或列宽保存失败");
}
const updatedView = await request(`/api/views/${savedView.id}`, {
  method: "PATCH",
  body: { config: { filters: savedView.config.filters, columnWidths: { [viewField.id]: 312 } } },
});
if (Number(updatedView.config?.columnWidths?.[viewField.id]) !== 312) throw new Error("列宽更新失败");
await request(`/api/views/${savedView.id}`, { method: "DELETE" });

const targetTable = tables.at(-1);
const targetSchema = await request(`/api/tables/${targetTable.id}/schema`);
const relationField = await request(`/api/tables/${tables[0].id}/fields`, {
  method: "POST",
  body: {
    name: "验收临时关联",
    type: "relation",
    config: {
      targetTableId: targetTable.id,
      matchFieldId: targetSchema.fields[0].id,
      returnFieldId: targetSchema.fields[0].id,
      multiple: true,
    },
  },
});
const lookupField = await request(`/api/tables/${tables[0].id}/fields`, {
  method: "POST",
  body: {
    name: "验收临时引用",
    type: "lookup",
    config: { relationFieldId: relationField.id, targetFieldId: targetSchema.fields[1].id, aggregation: "sum" },
  },
});
if (relationField.type !== "relation" || lookupField.type !== "lookup") {
  throw new Error("关联或查找引用字段创建失败");
}
await request(`/api/fields/${lookupField.id}`, { method: "DELETE" });
await request(`/api/fields/${relationField.id}`, { method: "DELETE" });

const managedField = await request(`/api/tables/${tables[0].id}/fields`, {
  method: "POST",
  body: { name: `验收字段-${Date.now()}`, type: "text", config: {} },
});
const managedFieldName = `${managedField.name}-已重命名`;
const renamedField = await request(`/api/fields/${managedField.id}`, {
  method: "PATCH",
  body: { name: managedFieldName },
});
if (renamedField.name !== managedFieldName) throw new Error("字段重命名失败");
await request(`/api/fields/${managedField.id}`, { method: "DELETE" });
const schemaAfterFieldDelete = await request(`/api/tables/${tables[0].id}/schema`);
if (schemaAfterFieldDelete.fields.some((field) => field.id === managedField.id)) throw new Error("字段删除后仍出现在数据表中");

const csvName = `验收CSV-${Date.now()}`;
const csvForm = new FormData();
csvForm.append(
  "file",
  new Blob([`${schema.fields[0].name}\n${csvName}\n`], { type: "text/csv" }),
  "acceptance.csv",
);
const csvImported = await request(`/api/tables/${tables[0].id}/import`, { method: "POST", body: csvForm });
if (csvImported.successRows !== 1 || csvImported.errorRows !== 0) throw new Error("CSV 导入失败");
const csvRecord = await findImportedRecord(tables[0].id, schema.fields[0].id, csvName);
await request(`/api/records/${csvRecord.id}`, { method: "DELETE" });

const xlsxName = `验收XLSX-${Date.now()}`;
const workbook = new ExcelJS.Workbook();
const worksheet = workbook.addWorksheet("数据");
worksheet.addRow([schema.fields[0].name]);
worksheet.addRow([xlsxName]);
const xlsxBuffer = await workbook.xlsx.writeBuffer();
const xlsxForm = new FormData();
xlsxForm.append(
  "file",
  new Blob([xlsxBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  "acceptance.xlsx",
);
const xlsxImported = await request(`/api/tables/${tables[0].id}/import`, { method: "POST", body: xlsxForm });
if (xlsxImported.successRows !== 1 || xlsxImported.errorRows !== 0) throw new Error("XLSX 导入失败");
const xlsxRecord = await findImportedRecord(tables[0].id, schema.fields[0].id, xlsxName);
await request(`/api/records/${xlsxRecord.id}`, { method: "DELETE" });

const templateInfo = await request(`/api/tables/${tables[0].id}/import-template`);
if (!/^IMP-[0-9]{8}-[0-9A-F]{10}$/.test(templateInfo.importId) || templateInfo.tableId !== tables[0].id) {
  throw new Error("导入模板唯一 ID 无效");
}
const templateBuffer = await request(templateInfo.downloadUrl, { binary: true });
const templateWorkbook = new ExcelJS.Workbook();
await templateWorkbook.xlsx.load(templateBuffer);
const templateMeta = templateWorkbook.getWorksheet("_multibase_meta");
const templateSheet = templateWorkbook.getWorksheet("数据导入");
if (!templateMeta || templateMeta.state !== "veryHidden" || String(templateMeta.getCell("B1").value) !== templateInfo.importId || !templateSheet) {
  throw new Error("导入模板元数据或数据工作表无效");
}
const emptyTemplateForm = new FormData();
emptyTemplateForm.append(
  "file",
  new Blob([templateBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  "acceptance-empty-template.xlsx",
);
const emptyTemplateFailure = await requestFailure(`/api/tables/${tables[0].id}/import`, { method: "POST", body: emptyTemplateForm });
if (emptyTemplateFailure?.code !== "IMPORT_EMPTY") throw new Error("空模板没有返回明确错误");
const failedImportJobs = await request(`/api/bases/${bases[0].id}/imports`);
const failedImportJob = failedImportJobs.find((job) => job.filename === "acceptance-empty-template.xlsx");
if (failedImportJob?.status !== "failed" || failedImportJob.details?.code !== "IMPORT_EMPTY") {
  throw new Error("导入失败没有写入最近导入任务");
}
const templateField = schema.fields.find((field) => field.type === "text");
const headerCells = [];
templateSheet.getRow(1).eachCell({ includeEmpty: true }, (cell, column) => {
  headerCells[column] = String(cell.value || "");
});
const templateColumn = headerCells.findIndex((name) => name === templateField.name);
if (templateColumn < 1) throw new Error("导入模板缺少文本字段");
const templateName = `验收模板-${Date.now()}`;
templateSheet.getRow(2).getCell(templateColumn).value = templateName;
const filledTemplate = await templateWorkbook.xlsx.writeBuffer();
const templateForm = new FormData();
templateForm.append(
  "file",
  new Blob([filledTemplate], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  "acceptance-template.xlsx",
);
const templateImported = await request(`/api/tables/${tables[0].id}/import`, { method: "POST", body: templateForm });
if (templateImported.successRows !== 1 || templateImported.errorRows !== 0) throw new Error("专属模板回导失败");
const templateRecord = await findImportedRecord(tables[0].id, templateField.id, templateName);
await request(`/api/records/${templateRecord.id}`, { method: "DELETE" });

const created = await request(`/api/tables/${tables[0].id}/records`, {
  method: "POST",
  body: { values: { [schema.fields[0].id]: "验收临时记录" } },
});
const updated = await request(`/api/records/${created.id}`, {
  method: "PATCH",
  body: { values: { [schema.fields[0].id]: "验收临时记录-已修改" }, version: created.version },
});
if (updated.version !== created.version + 1) throw new Error("乐观锁版本未更新");

const page = await request(`/api/tables/${tables[0].id}/records?limit=100&after=0`);
if (!Array.isArray(page.records) || Number(page.total) < 1) throw new Error("记录分页失败");
await request(`/api/records/${created.id}`, { method: "DELETE" });
const recycle = await request(`/api/bases/${bases[0].id}/recycle-bin`);
if (!recycle.some((item) => item.type === "record" && String(item.id) === String(created.id))) {
  throw new Error("软删除记录未进入回收站");
}
await request(`/api/recycle-bin/record/${created.id}/restore`, { method: "POST" });
await request(`/api/records/${created.id}`, { method: "DELETE" });

const exportedCsv = await request(`/api/tables/${targetTable.id}/export.csv`);
const exportLines = exportedCsv.trim().split(/\r?\n/).length;
if (exportLines !== Number(targetTable.record_count) + 1) {
  throw new Error(`CSV 导出行数不符: ${exportLines}`);
}

const exportSample = await request(`/api/tables/${targetTable.id}/records?limit=10&after=0`);
const exportField = targetSchema.fields.find((field) => field.type === "text" && exportSample.records.some((record) => record.values?.[field.id]));
if (!exportField) throw new Error("找不到可用于筛选导出的文本字段");
const exportValue = exportSample.records.find((record) => record.values?.[exportField.id]).values[exportField.id];
const exportFilters = [{ fieldId: exportField.id, operator: "eq", value: exportValue }];
const exportEstimate = await request(`/api/tables/${targetTable.id}/export-estimate`, {
  method: "POST",
  body: { filters: exportFilters },
});
if (Number(exportEstimate.totalRows) < 1 || Number(exportEstimate.estimatedBytes) < 1) throw new Error("筛选导出预估失败");
const filteredCsv = await request(`/api/tables/${targetTable.id}/export.csv?filters=${encodeURIComponent(JSON.stringify(exportFilters))}`);
const filteredExportLines = filteredCsv.trim().split(/\r?\n/).length;
if (filteredExportLines !== Number(exportEstimate.totalRows) + 1) {
  throw new Error(`筛选导出与预估行数不一致: ${filteredExportLines}`);
}

const system = await request("/api/system/status");
console.log(JSON.stringify({
  ok: true,
  health,
  base: bases[0].name,
  tables: tables.length,
  fields: schema.fields.length,
  totalRecords: page.total,
  csvImport: csvImported.successRows,
  xlsxImport: xlsxImported.successRows,
  templateImport: templateImported.successRows,
  exportLines,
  filteredExportRows: exportEstimate.totalRows,
  estimatedBytes: exportEstimate.estimatedBytes,
  system,
}, null, 2));
