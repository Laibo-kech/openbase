import crypto from "node:crypto";
import { pool } from "../server/db.mjs";

const baseUrl = process.env.ACCEPTANCE_BASE_URL || "http://127.0.0.1:14280";
const suffix = Date.now().toString(36);
const username = process.env.ACCEPTANCE_USERNAME || `catalog_pivot_${suffix}`;
const password = process.env.ACCEPTANCE_PASSWORD || crypto.randomBytes(24).toString("base64url");
const keepFixture = process.env.KEEP_ACCEPTANCE_DATA === "true";
const existingUser = process.env.ACCEPTANCE_EXISTING_USER === "true";
let cookie = "";
let fixtureBaseId = null;

async function request(path, options = {}, expectedStatus = null) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...options.headers,
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const contentType = response.headers.get("content-type") || "";
  const result = response.status === 204 ? null
    : contentType.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer());
  if (expectedStatus !== null) {
    if (response.status !== expectedStatus) throw new Error(`${path} expected ${expectedStatus}, received ${response.status}: ${JSON.stringify(result)}`);
    return result;
  }
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

async function waitFor(path, completed = ["completed"], timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await request(path);
    const status = value.status || value.job?.status || value.calculation?.status;
    if (completed.includes(status)) return value;
    if (["failed", "cancelled"].includes(status)) {
      throw new Error(`${path} stopped: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${path} timed out`);
}

async function createField(tableId, name, type, config = {}) {
  return request(`/api/tables/${tableId}/fields`, { method: "POST", body: { name, type, config } });
}

async function createRecord(tableId, values) {
  return request(`/api/tables/${tableId}/records`, { method: "POST", body: { values } });
}

try {
  if (existingUser) await request("/api/auth/login", { method: "POST", body: { username, password } }, 200);
  else await request("/api/auth/register", { method: "POST", body: { username, password } }, 201);
  const base = await request("/api/bases", { method: "POST", body: { name: `目录透视验收-${suffix}` } }, 201);
  fixtureBaseId = base.id;
  let tables = await request(`/api/bases/${base.id}/tables`);
  const sourceTable = tables[0];
  await request(`/api/tables/${sourceTable.id}`, { method: "PATCH", body: { name: "业务订单" } });
  const catalogTable = await request(`/api/bases/${base.id}/tables`, { method: "POST", body: { name: "商品目录" } }, 201);

  const sourceCode = await createField(sourceTable.id, "源商品编码", "text");
  const sourceName = await createField(sourceTable.id, "源商品名称", "text");
  const sourceSpec = await createField(sourceTable.id, "源规格", "text");
  const sourceAmount = await createField(sourceTable.id, "订单金额", "number", { decimals: 2 });
  const sourceDate = await createField(sourceTable.id, "订单日期", "date");
  const sourceRegion = await createField(sourceTable.id, "地区", "select", { options: [{ label: "华东" }, { label: "华南" }] });
  const targetCode = await createField(catalogTable.id, "商品编码", "text");
  const targetName = await createField(catalogTable.id, "标准名称", "text");
  const targetSpec = await createField(catalogTable.id, "标准规格", "text");
  const targetCategory = await createField(catalogTable.id, "商品分类", "text");

  const products = [];
  products.push(await createRecord(catalogTable.id, { [targetCode.id]: "P001", [targetName.id]: "Alpha Widget", [targetSpec.id]: "Standard", [targetCategory.id]: "工具" }));
  products.push(await createRecord(catalogTable.id, { [targetCode.id]: "P002", [targetName.id]: "Beta Phone", [targetSpec.id]: "256GB", [targetCategory.id]: "数码" }));
  products.push(await createRecord(catalogTable.id, { [targetCode.id]: "P003", [targetName.id]: "Gamma Widget", [targetSpec.id]: "Pro", [targetCategory.id]: "工具" }));
  products.push(await createRecord(catalogTable.id, { [targetCode.id]: "P004", [targetName.id]: "Delta Lamp", [targetSpec.id]: "Warm", [targetCategory.id]: "家居" }));
  const duplicate = await createRecord(catalogTable.id, { [targetCode.id]: "p001", [targetName.id]: "Duplicate Alpha", [targetSpec.id]: "Other", [targetCategory.id]: "重复" });

  const sourceRecords = [];
  sourceRecords.push(await createRecord(sourceTable.id, { [sourceCode.id]: " Ｐ００１ ", [sourceName.id]: "Alpha Widget", [sourceSpec.id]: "Standard", [sourceAmount.id]: 120, [sourceDate.id]: "2026-01-05", [sourceRegion.id]: "华东" }));
  sourceRecords.push(await createRecord(sourceTable.id, { [sourceCode.id]: null, [sourceName.id]: "Beta Phone", [sourceSpec.id]: "256GB", [sourceAmount.id]: 260, [sourceDate.id]: "2026-01-08", [sourceRegion.id]: "华南" }));
  sourceRecords.push(await createRecord(sourceTable.id, { [sourceCode.id]: null, [sourceName.id]: "Gamma Widgt", [sourceSpec.id]: "Pro", [sourceAmount.id]: 380, [sourceDate.id]: "2026-02-11", [sourceRegion.id]: "华东" }));
  sourceRecords.push(await createRecord(sourceTable.id, { [sourceCode.id]: null, [sourceName.id]: "Unknown Product", [sourceSpec.id]: "None", [sourceAmount.id]: 75, [sourceDate.id]: "2026-02-15", [sourceRegion.id]: "华南" }));

  let definition = await request(`/api/bases/${base.id}/catalog-definitions`, {
    method: "POST",
    body: {
      tableId: catalogTable.id,
      uniqueFieldIds: [targetCode.id],
      normalization: { trim: true, collapseSpaces: true, caseInsensitive: true, fullWidth: true, typed: true },
    },
  }, 201);
  if (definition.index_status !== "duplicate" || Number(definition.duplicate_groups) !== 1) throw new Error("Duplicate catalog values were not blocked");
  const duplicatePreview = await request(`/api/catalog-definitions/${definition.id}/duplicates`);
  if (duplicatePreview.duplicateGroups !== 1 || duplicatePreview.groups[0].records.length !== 2) throw new Error("Duplicate details are incomplete");
  await request(`/api/records/${duplicate.id}`, { method: "DELETE" }, 204);
  const cleanPreview = await request(`/api/catalog-definitions/${definition.id}/duplicates`);
  if (cleanPreview.status !== "ready" || cleanPreview.duplicateGroups !== 0) throw new Error("Catalog duplicate cleanup was not reindexed");

  const matchConfig = await request(`/api/bases/${base.id}/catalog-configs`, {
    method: "POST",
    body: {
      name: "订单匹配商品目录",
      sourceTableId: sourceTable.id,
      definitionId: definition.id,
      rules: [
        {
          sourceFieldIds: [sourceCode.id], targetFieldIds: [targetCode.id],
          normalization: { trim: true, collapseSpaces: true, caseInsensitive: true, fullWidth: true, typed: true },
        },
        {
          sourceFieldIds: [sourceName.id, sourceSpec.id], targetFieldIds: [targetName.id, targetSpec.id],
          normalization: { trim: true, collapseSpaces: true, caseInsensitive: true, fullWidth: true, typed: true },
        },
        {
          sourceFieldIds: [sourceName.id], targetFieldIds: [targetName.id], fuzzy: true, fuzzyThreshold: 0.6,
          normalization: { trim: true, collapseSpaces: true, caseInsensitive: true, fullWidth: true, typed: true },
        },
      ],
    },
  }, 201);

  let previewJob = await request(`/api/catalog-configs/${matchConfig.id}/preview`, { method: "POST", body: { mode: "full" } }, 202);
  previewJob = await waitFor(`/api/catalog-jobs/${previewJob.id}`);
  if (Number(previewJob.matched_records) !== 2 || Number(previewJob.conflict_records) !== 1 || Number(previewJob.unmatched_records) !== 1) {
    throw new Error(`Unexpected preview metrics: ${JSON.stringify(previewJob)}`);
  }
  const conflicts = await request(`/api/catalog-jobs/${previewJob.id}/results?status=conflict`);
  if (conflicts.results.length !== 1 || !conflicts.results[0].candidates.length) throw new Error("Fuzzy candidate conflict is missing");
  await request(`/api/catalog-jobs/${previewJob.id}/results/${conflicts.results[0].source_record_id}/confirm`, {
    method: "POST", body: { targetRecordId: products[2].id, saveAlias: true },
  });
  previewJob = await request(`/api/catalog-jobs/${previewJob.id}`);
  const applyJob = await request(`/api/catalog-jobs/${previewJob.id}/apply`, { method: "POST", body: {} }, 202);
  const appliedJob = await waitFor(`/api/catalog-jobs/${applyJob.id}`);
  if (Number(appliedJob.applied_records) !== 3) throw new Error("Catalog apply count is incorrect");

  const sourceSchema = await request(`/api/tables/${sourceTable.id}/schema`);
  const relationField = sourceSchema.fields.find((field) => field.type === "relation" && field.config?.catalogConfigId === matchConfig.id);
  if (!relationField) throw new Error("Catalog relation field was not created");
  const lookupName = await createField(sourceTable.id, "标准商品名称", "lookup", {
    relationFieldId: relationField.id, targetFieldId: targetName.id, aggregation: "first", emptyPolicy: "unmatched",
  });
  const lookupCategory = await createField(sourceTable.id, "标准商品分类", "lookup", {
    relationFieldId: relationField.id, targetFieldId: targetCategory.id, aggregation: "first", emptyPolicy: "unmatched",
  });
  await waitFor(`/api/fields/${lookupName.id}/dependencies`, ["completed", "partial"]);
  await waitFor(`/api/fields/${lookupCategory.id}/dependencies`, ["completed", "partial"]);
  const matchedRecords = await request(`/api/tables/${sourceTable.id}/records?limit=20`);
  const linkedRecords = matchedRecords.records.filter((record) => record.values[relationField.id]?.length);
  if (linkedRecords.length !== 3) {
    throw new Error(`Applied relation values are incomplete: ${JSON.stringify({
      expected: 3,
      actual: linkedRecords.length,
      applied: appliedJob.applied_records,
      values: matchedRecords.records.map((record) => ({ id: record.id, relation: record.values[relationField.id] })),
    })}`);
  }
  if (!matchedRecords.records.some((record) => record.values[lookupName.id] === "Gamma Widget")) throw new Error("Lookup did not return the standard catalog name");

  const aliasPreview = await request(`/api/catalog-configs/${matchConfig.id}/preview`, { method: "POST", body: { mode: "full" } }, 202);
  const aliasJob = await waitFor(`/api/catalog-jobs/${aliasPreview.id}`);
  const aliasResults = await request(`/api/catalog-jobs/${aliasJob.id}/results?status=matched&limit=20`);
  if (!aliasResults.results.some((result) => result.match_method === "alias")) throw new Error("Saved alias did not auto-match on the next run");

  const newSource = await createRecord(sourceTable.id, { [sourceCode.id]: "P004", [sourceName.id]: "Delta Lamp", [sourceSpec.id]: "Warm", [sourceAmount.id]: 410, [sourceDate.id]: "2026-03-02", [sourceRegion.id]: "华东" });
  const incremental = await request(`/api/catalog-configs/${matchConfig.id}/preview`, { method: "POST", body: { mode: "incremental" } }, 202);
  const incrementalPreview = await waitFor(`/api/catalog-jobs/${incremental.id}`);
  if (Number(incrementalPreview.total_records) !== 1 || Number(incrementalPreview.matched_records) !== 1) throw new Error("Incremental matching did not limit itself to the changed record");
  await request(`/api/catalog-jobs/${incremental.id}/apply`, { method: "POST", body: {} }, 202);
  const incrementalApplied = await waitFor(`/api/catalog-jobs/${incremental.id}`);
  if (Number(incrementalApplied.applied_records) !== 1) throw new Error("Incremental match was not applied");

  const pivot = await request(`/api/bases/${base.id}/pivot-configs`, {
    method: "POST",
    body: {
      name: "地区月份销售透视",
      tableId: sourceTable.id,
      config: {
        rows: [{ fieldId: sourceRegion.id }],
        columns: [{ fieldId: sourceDate.id, grouping: "month" }],
        measures: [
          { id: "orders", aggregation: "count", label: "订单数" },
          { id: "amount", fieldId: sourceAmount.id, aggregation: "sum", label: "销售额" },
        ],
        filters: [{ fieldId: sourceAmount.id, operator: "gt", value: 0 }],
        filterMode: "all",
        totals: { rows: true, columns: true, grand: true, subtotals: true },
        empty: { mode: "separate" },
      },
    },
  }, 201);
  let pivotJob = await request(`/api/pivot-configs/${pivot.id}/calculate`, { method: "POST", body: {} }, 202);
  let pivotResult = await waitFor(`/api/pivot-jobs/${pivotJob.id}`);
  if (!pivotResult.rows.length || Number(pivotResult.job.result_rows) < 4) throw new Error("Pivot result rows are incomplete");
  const leaf = pivotResult.rows.find((row) => !row.is_total);
  if (!leaf) throw new Error("Pivot leaf result is missing");
  const drilldown = await request(`/api/pivot-jobs/${pivotJob.id}/drilldown/${leaf.row_index}`);
  if (!Number(drilldown.total) || !drilldown.records.length) throw new Error("Pivot drilldown returned no source records");
  const estimate = await request(`/api/pivot-jobs/${pivotJob.id}/export-estimate?format=xlsx`);
  if (estimate.rows !== Number(pivotResult.job.result_rows) || estimate.estimatedBytes < 512) throw new Error("Pivot export estimate is invalid");
  const csv = await request(`/api/pivot-jobs/${pivotJob.id}/export.csv`);
  const xlsx = await request(`/api/pivot-jobs/${pivotJob.id}/export.xlsx`);
  if (csv.length < 50 || xlsx.length < 1000) throw new Error("Pivot export files are empty");
  const cached = await request(`/api/pivot-configs/${pivot.id}/calculate`, { method: "POST", body: {} }, 200);
  if (!cached.cached || cached.id !== pivotJob.id) throw new Error("Repeated pivot query did not use the cache");

  await createRecord(sourceTable.id, { [sourceCode.id]: "P002", [sourceName.id]: "Beta Phone", [sourceSpec.id]: "256GB", [sourceAmount.id]: 99, [sourceDate.id]: "2026-03-06", [sourceRegion.id]: "华南" });
  const pivotsAfterChange = await request(`/api/bases/${base.id}/pivot-configs`);
  if (!pivotsAfterChange.find((item) => item.id === pivot.id)?.dataUpdated) throw new Error("Pivot did not report updated source data");

  const undo = await request(`/api/catalog-jobs/${previewJob.id}/undo`, { method: "POST", body: {} });
  if (undo.reverted !== 3) throw new Error("Catalog undo did not restore only the selected job results");
  const afterUndo = await request(`/api/tables/${sourceTable.id}/records?limit=20`);
  const originalIds = new Set(sourceRecords.map((record) => String(record.id)));
  if (afterUndo.records.filter((record) => originalIds.has(String(record.id)) && record.values[relationField.id]?.length).length !== 0) {
    throw new Error("Catalog undo left relation values from the reverted job");
  }
  const incrementalRecord = afterUndo.records.find((record) => String(record.id) === String(newSource.id));
  if (!incrementalRecord?.values[relationField.id]?.length) throw new Error("Catalog undo affected another job's relation result");

  console.log(JSON.stringify({
    ok: true,
    catalog: {
      duplicatesBlocked: 1,
      matched: Number(previewJob.matched_records),
      manual: 1,
      unmatched: Number(previewJob.unmatched_records),
      aliasMatched: true,
      incrementalRecords: Number(incrementalPreview.total_records),
      undone: undo.reverted,
    },
    pivot: {
      sourceRecords: pivotResult.job.source_records,
      resultRows: pivotResult.job.result_rows,
      drilldownRecords: drilldown.total,
      cached: true,
      exportCsvBytes: csv.length,
      exportXlsxBytes: xlsx.length,
      dataUpdated: true,
    },
    ...(keepFixture ? { fixture: { username, baseId: fixtureBaseId } } : {}),
  }));
} finally {
  const user = (await pool.query("SELECT id FROM users WHERE lower(username)=lower($1)", [username])).rows[0];
  if (user && !keepFixture) {
    if (existingUser) {
      if (fixtureBaseId) await pool.query("DELETE FROM bases WHERE id=$1 AND owner_user_id=$2", [fixtureBaseId, user.id]);
      try { await request("/api/auth/logout", { method: "POST", body: {} }, 204); } catch { /* Cleanup already completed. */ }
    } else {
      await pool.query("DELETE FROM bases WHERE owner_user_id=$1", [user.id]);
      await pool.query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
      await pool.query("DELETE FROM users WHERE id=$1", [user.id]);
    }
  }
  await pool.end();
}
