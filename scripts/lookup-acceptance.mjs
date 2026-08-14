import assert from "node:assert/strict";

const baseUrl = process.env.LOOKUP_ACCEPTANCE_BASE_URL || "http://127.0.0.1:14280";
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const username = `lookup-${suffix}`;
const password = `Lookup-${suffix}-A9!`;
let cookie = "";

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    method: options.method || "GET",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok && !options.allowError) {
    throw new Error(`${options.method || "GET"} ${path}: ${response.status} ${JSON.stringify(body)}`);
  }
  return options.allowError ? { status: response.status, body } : body;
}

async function poll(check, label, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} 超时`);
}

function afterId(id) {
  return (BigInt(id) - 1n).toString();
}

async function recordById(tableId, recordId) {
  const page = await request(`/api/tables/${tableId}/records?limit=2&after=${afterId(recordId)}`);
  return page.records.find((record) => String(record.id) === String(recordId));
}

async function waitForValues(tableId, recordId, expected) {
  return poll(async () => {
    const record = await recordById(tableId, recordId);
    if (!record) throw new Error(`找不到记录 ${recordId}`);
    const ready = Object.keys(expected).every((fieldId) => record.lookupStatuses?.[fieldId]?.status === "completed");
    if (!ready) return undefined;
    for (const [fieldId, value] of Object.entries(expected)) {
      assert.deepEqual(record.values[fieldId], value, `字段 ${fieldId} 结果不符`);
    }
    return record;
  }, `等待记录 ${recordId} 查找引用计算`);
}

function config(relationFieldId, targetFieldId, aggregation, extra = {}) {
  return { relationFieldId, targetFieldId, aggregation, emptyPolicy: "empty", ...extra };
}

const health = await request("/api/health");
assert.equal(health.ok, true);
assert.equal(health.database, "connected");

await request("/api/auth/register", { method: "POST", body: { username, password } });
const base = await request("/api/bases", { method: "POST", body: { name: `查找引用验收-${suffix}` } });
const initialTables = await request(`/api/bases/${base.id}/tables`);
const sourceTable = initialTables[0];
const targetTable = await request(`/api/bases/${base.id}/tables`, { method: "POST", body: { name: "目标目录" } });
const sourceInitial = await request(`/api/tables/${sourceTable.id}/schema`);
const targetInitial = await request(`/api/tables/${targetTable.id}/schema`);
const sourceName = sourceInitial.fields[0];
const targetName = targetInitial.fields[0];

async function addField(tableId, name, type, fieldConfig = {}) {
  return request(`/api/tables/${tableId}/fields`, { method: "POST", body: { name, type, config: fieldConfig } });
}

const codeField = await addField(targetTable.id, "目录编码", "text");
const amountField = await addField(targetTable.id, "金额", "number", { decimals: 2 });
const dateField = await addField(targetTable.id, "业务日期", "date");
const statusField = await addField(targetTable.id, "状态", "select", { options: ["启用", "关闭"] });

const targets = [];
for (const values of [
  { [targetName.id]: "目录 A1", [codeField.id]: "A", [amountField.id]: 10, [dateField.id]: "2026-01-03", [statusField.id]: "启用" },
  { [targetName.id]: "目录 B1", [codeField.id]: "B", [amountField.id]: 20, [dateField.id]: "2026-01-01", [statusField.id]: "关闭" },
  { [targetName.id]: "目录 A2", [codeField.id]: "A", [amountField.id]: 30, [dateField.id]: "2026-01-02", [statusField.id]: "启用" },
]) {
  targets.push(await request(`/api/tables/${targetTable.id}/records`, { method: "POST", body: { values } }));
}

const relation = await addField(sourceTable.id, "关联目录", "relation", {
  targetTableId: targetTable.id,
  matchFieldId: codeField.id,
  returnFieldId: targetName.id,
  multiple: true,
});
const singleRelation = await addField(sourceTable.id, "唯一目录", "relation", {
  targetTableId: targetTable.id,
  matchFieldId: codeField.id,
  returnFieldId: targetName.id,
  multiple: false,
});

const lookups = {};
for (const [key, name, targetField, aggregation, extra] of [
  ["first", "首个编码", codeField, "first"],
  ["last", "末个编码", codeField, "last"],
  ["unique", "去重编码", codeField, "unique_concat", { separator: "、" }],
  ["count", "编码计数", codeField, "count"],
  ["sum", "金额合计", amountField, "sum"],
  ["average", "金额平均", amountField, "average"],
  ["max", "最大金额", amountField, "max"],
  ["min", "最小金额", amountField, "min"],
  ["dateMin", "最早日期", dateField, "min"],
  ["selectLast", "末个状态", statusField, "last"],
  ["default", "默认编码", codeField, "first", { emptyPolicy: "default", defaultValue: "暂无" }],
  ["unmatched", "未匹配编码", codeField, "first", { emptyPolicy: "unmatched" }],
]) {
  lookups[key] = await addField(sourceTable.id, name, "lookup", config(relation.id, targetField.id, aggregation, extra));
}
lookups.single = await addField(sourceTable.id, "唯一目录编码", "lookup", config(singleRelation.id, codeField.id, "first"));

const options = await request(`/api/tables/${targetTable.id}/record-options?matchFieldId=${codeField.id}&returnFieldId=${targetName.id}&search=A`);
assert.equal(options.length, 2);
assert.equal(options.every((item) => /^\d+$/.test(item.id) && item.label.startsWith("目录 A")), true);

const source = await request(`/api/tables/${sourceTable.id}/records`, {
  method: "POST",
  body: {
    values: {
      [sourceName.id]: "多条关联",
      [relation.id]: targets.map((item) => String(item.id)),
      [singleRelation.id]: [String(targets[0].id)],
    },
  },
});

let sourceRead = await waitForValues(sourceTable.id, source.id, {
  [lookups.first.id]: "A",
  [lookups.last.id]: "A",
  [lookups.unique.id]: "A、B",
  [lookups.count.id]: 3,
  [lookups.sum.id]: 60,
  [lookups.average.id]: 20,
  [lookups.max.id]: 30,
  [lookups.min.id]: 10,
  [lookups.dateMin.id]: "2026-01-01",
  [lookups.selectLast.id]: "启用",
  [lookups.single.id]: "A",
});
assert.deepEqual(sourceRead.values[relation.id], targets.map((item) => String(item.id)));
assert.equal(sourceRead.relationLabels[relation.id][0].label, "目录 A1");

const emptySource = await request(`/api/tables/${sourceTable.id}/records`, {
  method: "POST",
  body: { values: { [sourceName.id]: "空关联", [relation.id]: [], [singleRelation.id]: [] } },
});
await waitForValues(sourceTable.id, emptySource.id, {
  [lookups.first.id]: null,
  [lookups.default.id]: "暂无",
  [lookups.unmatched.id]: "未匹配",
});

const cardinality = await request(`/api/records/${source.id}`, {
  method: "PATCH",
  body: { values: { [singleRelation.id]: [String(targets[0].id), String(targets[1].id)] }, version: sourceRead.version },
  allowError: true,
});
assert.equal(cardinality.status, 400);
assert.equal(cardinality.body.code, "RELATION_CARDINALITY_INVALID");

const readOnly = await request(`/api/records/${source.id}`, {
  method: "PATCH",
  body: { values: { [lookups.sum.id]: 999 }, version: sourceRead.version },
  allowError: true,
});
assert.equal(readOnly.status, 400);
assert.equal(readOnly.body.code, "LOOKUP_READ_ONLY");

const targetUpdated = await request(`/api/records/${targets[0].id}`, {
  method: "PATCH",
  body: { values: { [amountField.id]: 25 }, version: targets[0].version },
});
assert.equal(targetUpdated.version, targets[0].version + 1);
sourceRead = await waitForValues(sourceTable.id, source.id, { [lookups.sum.id]: 75, [lookups.average.id]: 25 });

const sourceUpdated = await request(`/api/records/${source.id}`, {
  method: "PATCH",
  body: { values: { [relation.id]: [String(targets[1].id)] }, version: sourceRead.version },
});
assert.equal(sourceUpdated.version, sourceRead.version + 1);
sourceRead = await waitForValues(sourceTable.id, source.id, {
  [lookups.first.id]: "B",
  [lookups.count.id]: 1,
  [lookups.sum.id]: 20,
});

const dependency = await request(`/api/fields/${lookups.sum.id}/dependencies`);
assert.equal(dependency.dependency.relation_field_id, relation.id);
assert.equal(dependency.dependency.target_field_id, amountField.id);
assert.equal(["completed", "partial"].includes(dependency.calculation.status), true);

const impact = await request(`/api/fields/${amountField.id}/impact`);
assert.equal(impact.affectedFields >= 4, true);
assert.equal(impact.affectedRecords >= 2, true);
const typeChange = await request(`/api/fields/${amountField.id}`, {
  method: "PATCH",
  body: { type: "text" },
  allowError: true,
});
assert.equal(typeChange.status, 409);
assert.equal(typeChange.body.code, "FIELD_IMPACT_CONFIRMATION_REQUIRED");
assert.equal(typeChange.body.details.affectedFields >= 4, true);
const deleteImpact = await request(`/api/fields/${dateField.id}`, { method: "DELETE", allowError: true });
assert.equal(deleteImpact.status, 409);
assert.equal(deleteImpact.body.code, "FIELD_IMPACT_CONFIRMATION_REQUIRED");

const reverseRelation = await addField(targetTable.id, "反向关联来源", "relation", {
  targetTableId: sourceTable.id,
  matchFieldId: sourceName.id,
  returnFieldId: sourceName.id,
  multiple: true,
});
const cycle = await request(`/api/tables/${targetTable.id}/fields`, {
  method: "POST",
  body: { name: "循环引用", type: "lookup", config: config(reverseRelation.id, sourceName.id, "first") },
  allowError: true,
});
assert.equal(cycle.status, 409);
assert.equal(cycle.body.code, "LOOKUP_CYCLE");

await request(`/api/records/${targets[1].id}`, { method: "DELETE" });
await waitForValues(sourceTable.id, source.id, {
  [lookups.first.id]: "来源记录已删除",
  [lookups.sum.id]: "来源记录已删除",
});

const retry = await request(`/api/fields/${lookups.sum.id}/recalculate`, {
  method: "POST",
  body: { retryFailed: true },
});
assert.equal(retry.mode, "retry_failed");
await poll(async () => {
  const status = await request(`/api/fields/${lookups.sum.id}/dependencies`);
  return ["completed", "partial", "failed"].includes(status.calculation?.status) ? status : undefined;
}, "重试任务状态");

console.log(JSON.stringify({
  ok: true,
  health,
  baseId: base.id,
  sourceTableId: sourceTable.id,
  targetTableId: targetTable.id,
  lookupFields: Object.keys(lookups).length,
  aggregations: ["first", "last", "unique_concat", "count", "sum", "average", "max", "min"],
  verified: [
    "stable_relation_ids",
    "three_step_relation_config",
    "one_and_many_relations",
    "text_number_date_select",
    "empty_default_unmatched",
    "source_and_target_auto_update",
    "deleted_source_marker",
    "impact_warning",
    "dependency_view",
    "cycle_prevention",
    "readonly_lookup",
    "job_status_and_retry",
  ],
}, null, 2));
