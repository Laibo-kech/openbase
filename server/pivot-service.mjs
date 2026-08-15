import crypto from "node:crypto";
import { pool, withTransaction } from "./db.mjs";

const AGGREGATIONS = new Set(["count", "distinct_count", "sum", "average", "max", "min"]);
const DATE_GROUPS = new Set(["year", "quarter", "month", "week", "day"]);
const FILTER_OPERATORS = new Set(["eq", "neq", "contains", "gt", "gte", "lt", "lte", "empty", "not_empty", "in"]);

function pivotError(message, code = "PIVOT_FAILED", status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function getFields(tableId, client = pool) {
  return (await client.query(
    "SELECT id,name,type,config FROM fields WHERE table_id=$1 AND deleted_at IS NULL ORDER BY position,created_at",
    [tableId],
  )).rows;
}

function normalizeDimension(item = {}, fieldMap) {
  const fieldId = String(item.fieldId || "");
  const field = fieldMap.get(fieldId);
  if (!field) throw pivotError("数据透视包含不存在或已删除的分组字段", "PIVOT_FIELD_INVALID");
  const grouping = field.type === "date" && DATE_GROUPS.has(item.grouping) ? item.grouping
    : field.type === "number" && Number(item.interval) > 0 ? "interval"
      : "value";
  return {
    fieldId,
    grouping,
    interval: grouping === "interval" ? Number(item.interval) : null,
  };
}

export function normalizePivotConfig(input = {}, fields = []) {
  const fieldMap = new Map(fields.map((field) => [field.id, field]));
  const rows = (Array.isArray(input.rows) ? input.rows : []).slice(0, 5).map((item) => normalizeDimension(item, fieldMap));
  const columns = (Array.isArray(input.columns) ? input.columns : []).slice(0, 3).map((item) => normalizeDimension(item, fieldMap));
  const measures = (Array.isArray(input.measures) ? input.measures : []).slice(0, 10).map((item, index) => {
    const aggregation = AGGREGATIONS.has(item.aggregation) ? item.aggregation : "count";
    const fieldId = item.fieldId ? String(item.fieldId) : null;
    const field = fieldId ? fieldMap.get(fieldId) : null;
    if (aggregation !== "count" && !field) throw pivotError("数据透视指标字段不存在", "PIVOT_MEASURE_FIELD_INVALID");
    if (["sum", "average", "max", "min"].includes(aggregation) && field?.type !== "number") {
      throw pivotError("求和、平均值、最大值和最小值只能使用数字字段", "PIVOT_MEASURE_TYPE_INVALID");
    }
    return {
      id: /^[A-Za-z0-9_-]{1,64}$/.test(String(item.id || "")) ? String(item.id) : `measure_${index + 1}`,
      fieldId,
      aggregation,
      label: String(item.label || `${field?.name || "记录"} ${aggregation}`).slice(0, 80),
    };
  });
  if (!measures.length) measures.push({ id: "measure_1", fieldId: null, aggregation: "count", label: "记录数" });
  const filters = (Array.isArray(input.filters) ? input.filters : []).slice(0, 12).map((item) => {
    const fieldId = String(item.fieldId || "");
    if (!fieldMap.has(fieldId)) throw pivotError("数据透视筛选字段不存在", "PIVOT_FILTER_FIELD_INVALID");
    return {
      fieldId,
      operator: FILTER_OPERATORS.has(item.operator) ? item.operator : "eq",
      value: item.value ?? "",
    };
  });
  const emptyMode = ["separate", "ignore", "custom"].includes(input.empty?.mode) ? input.empty.mode : "separate";
  const sortDirection = input.sort?.direction === "desc" ? "desc" : "asc";
  return {
    rows,
    columns,
    measures,
    filters,
    filterMode: input.filterMode === "any" ? "any" : "all",
    totals: {
      rows: input.totals?.rows !== false,
      columns: input.totals?.columns !== false,
      grand: input.totals?.grand !== false,
      subtotals: input.totals?.subtotals !== false,
    },
    empty: {
      mode: emptyMode,
      label: String(input.empty?.label || "(空值)").slice(0, 40),
    },
    sort: {
      by: String(input.sort?.by || "name"),
      direction: sortDirection,
    },
  };
}

export async function getPivotSourceVersion(tableId, client = pool) {
  const row = (await client.query(
    `SELECT count(*)::bigint records,COALESCE(max(updated_at),to_timestamp(0)) updated_at,
      COALESCE(max(id),0)::bigint max_id FROM records WHERE table_id=$1 AND deleted_at IS NULL`,
    [tableId],
  )).rows[0];
  return {
    value: `${row.records}:${new Date(row.updated_at).toISOString()}:${row.max_id}`,
    records: String(row.records),
  };
}

export async function validatePivotConfig(tableId, input, client = pool) {
  const fields = await getFields(tableId, client);
  const config = normalizePivotConfig(input, fields);
  return { config, fields };
}

function createSqlBuilder(config, fields) {
  const params = [];
  const fieldMap = new Map(fields.map((field) => [field.id, field]));
  const param = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const raw = (fieldId) => `NULLIF(r.values->>${param(fieldId)},'')`;
  const dimension = (item) => {
    const field = fieldMap.get(item.fieldId);
    const base = raw(item.fieldId);
    let expression = base;
    if (field.type === "date") {
      if (item.grouping === "year") expression = `to_char((${base})::date,'YYYY')`;
      else if (item.grouping === "quarter") expression = `to_char((${base})::date,'YYYY') || '-Q' || extract(quarter from (${base})::date)::int`;
      else if (item.grouping === "month") expression = `to_char((${base})::date,'YYYY-MM')`;
      else if (item.grouping === "week") expression = `to_char((${base})::date,'IYYY-"W"IW')`;
      else if (item.grouping === "day") expression = `to_char((${base})::date,'YYYY-MM-DD')`;
    } else if (field.type === "number" && item.grouping === "interval") {
      const interval = param(item.interval);
      expression = `(floor((${base})::numeric / ${interval}) * ${interval})::text`;
    }
    if (config.empty.mode === "custom") expression = `COALESCE(${expression},${param(config.empty.label)})`;
    return { expression, raw: base, field };
  };
  return { params, param, raw, dimension, fieldMap };
}

function buildFilterSql(config, builder) {
  const clauses = [];
  for (const filter of config.filters) {
    const field = builder.fieldMap.get(filter.fieldId);
    const base = builder.raw(filter.fieldId);
    if (filter.operator === "empty") clauses.push(`${base} IS NULL`);
    else if (filter.operator === "not_empty") clauses.push(`${base} IS NOT NULL`);
    else if (filter.operator === "contains") clauses.push(`COALESCE(${base},'') ILIKE '%' || ${builder.param(String(filter.value))} || '%'`);
    else if (filter.operator === "in") {
      const values = Array.isArray(filter.value) ? filter.value.map(String) : String(filter.value).split(",").map((item) => item.trim()).filter(Boolean);
      clauses.push(`${base}=ANY(${builder.param(values)}::text[])`);
    } else {
      const operators = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
      let left = base;
      let value = filter.value;
      if (field.type === "number") {
        left = `(${base})::numeric`;
        value = Number(value);
        if (!Number.isFinite(value)) throw pivotError("数字筛选值无效", "PIVOT_FILTER_VALUE_INVALID");
      } else if (field.type === "date") left = `(${base})::date`;
      clauses.push(`${left} ${operators[filter.operator] || "="} ${builder.param(value)}`);
    }
  }
  if (!clauses.length) return "";
  return `(${clauses.join(config.filterMode === "any" ? " OR " : " AND ")})`;
}

function bitCount(value) {
  let number = Number(value) >>> 0;
  let count = 0;
  while (number) { count += number & 1; number >>>= 1; }
  return count;
}

function shouldKeepTotal(rowMask, columnMask, rowCount, columnCount, totals) {
  if (rowMask === 0 && columnMask === 0) return true;
  const allRows = rowCount ? (2 ** rowCount) - 1 : 0;
  const allColumns = columnCount ? (2 ** columnCount) - 1 : 0;
  if (rowMask === allRows && columnMask === allColumns) return totals.grand;
  if (rowMask === 0 && columnMask === allColumns && columnCount) return totals.rows;
  if (rowMask === allRows && columnMask === 0 && rowCount) return totals.columns;
  return totals.subtotals;
}

function buildPivotQuery(tableId, config, fields, maxRows) {
  const builder = createSqlBuilder(config, fields);
  const tableParam = builder.param(tableId);
  const rowDimensions = config.rows.map((item) => builder.dimension(item));
  const columnDimensions = config.columns.map((item) => builder.dimension(item));
  const dimensions = [...rowDimensions, ...columnDimensions];
  const selections = dimensions.map((item, index) => `${item.expression} AS d${index}`);
  const measureSelections = config.measures.map((measure, index) => {
    if (measure.aggregation === "count") return `count(*)::bigint AS m${index}`;
    const base = builder.raw(measure.fieldId);
    if (measure.aggregation === "distinct_count") return `count(DISTINCT ${base})::bigint AS m${index}`;
    const aggregate = measure.aggregation === "average" ? "avg" : measure.aggregation;
    return `${aggregate}((${base})::numeric) AS m${index}`;
  });
  const rowExpressions = rowDimensions.map((item) => item.expression);
  const columnExpressions = columnDimensions.map((item) => item.expression);
  const rowGrouping = rowExpressions.length ? `GROUPING(${rowExpressions.join(",")})::int` : "0";
  const columnGrouping = columnExpressions.length ? `GROUPING(${columnExpressions.join(",")})::int` : "0";
  const where = [`r.table_id=${tableParam}`, "r.deleted_at IS NULL"];
  const filterSql = buildFilterSql(config, builder);
  if (filterSql) where.push(filterSql);
  if (config.empty.mode === "ignore") {
    for (const item of dimensions) where.push(`${item.raw} IS NOT NULL`);
  }
  const groups = [];
  if (rowExpressions.length) groups.push(`ROLLUP(${rowExpressions.join(",")})`);
  if (columnExpressions.length) groups.push(`ROLLUP(${columnExpressions.join(",")})`);
  const limit = builder.param(maxRows + 1);
  const selectList = [...selections, ...measureSelections, `${rowGrouping} row_grouping`, `${columnGrouping} column_grouping`];
  const sql = `SELECT ${selectList.join(",")} FROM records r WHERE ${where.join(" AND ")}
    ${groups.length ? `GROUP BY ${groups.join(",")}` : ""}
    ORDER BY row_grouping DESC,column_grouping DESC${dimensions.length ? `,${dimensions.map((_, index) => `d${index} NULLS LAST`).join(",")}` : ""}
    LIMIT ${limit}`;
  return { sql, params: builder.params };
}

export async function enqueuePivotJob({ pivotConfigId, user }) {
  const pivotConfig = (await pool.query(
    `SELECT p.*,t.name table_name FROM pivot_configs p JOIN data_tables t ON t.id=p.table_id AND t.deleted_at IS NULL
     WHERE p.id=$1`,
    [pivotConfigId],
  )).rows[0];
  if (!pivotConfig) throw pivotError("数据透视方案不存在", "PIVOT_CONFIG_NOT_FOUND", 404);
  const { config } = await validatePivotConfig(pivotConfig.table_id, pivotConfig.config);
  const source = await getPivotSourceVersion(pivotConfig.table_id);
  const configHash = stableHash({ tableId: pivotConfig.table_id, config });
  const cached = (await pool.query(
    `SELECT * FROM pivot_jobs WHERE pivot_config_id=$1 AND config_hash=$2 AND source_version=$3
     AND status='completed' AND completed_at>now()-interval '10 minutes'
     ORDER BY completed_at DESC LIMIT 1`,
    [pivotConfigId, configHash, source.value],
  )).rows[0];
  if (cached) {
    await pool.query(
      `UPDATE pivot_configs SET last_job_id=$2,last_calculated_source_version=$3,updated_at=now() WHERE id=$1`,
      [pivotConfigId, cached.id, source.value],
    );
    return { ...cached, cached: true };
  }
  const { rows } = await pool.query(
    `INSERT INTO pivot_jobs(pivot_config_id,requested_by_user_id,requested_by,config_hash,config_snapshot,
       source_version,source_records)
     VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
     ON CONFLICT(pivot_config_id) WHERE status IN ('pending','computing') DO NOTHING RETURNING *`,
    [pivotConfigId, user?.id || null, user?.username || "system", configHash, JSON.stringify(config), source.value, source.records],
  );
  if (rows[0]) return rows[0];
  return (await pool.query(
    "SELECT * FROM pivot_jobs WHERE pivot_config_id=$1 AND status IN ('pending','computing') ORDER BY created_at DESC LIMIT 1",
    [pivotConfigId],
  )).rows[0];
}

async function claimPivotJob() {
  return withTransaction(async (client) => (await client.query(
    `UPDATE pivot_jobs SET status='computing',started_at=COALESCE(started_at,now()),progress=5
     WHERE id=(SELECT id FROM pivot_jobs WHERE status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING *`,
  )).rows[0]);
}

async function insertPivotRows(job, rows, config) {
  const rowCount = config.rows.length;
  const columnCount = config.columns.length;
  const dimensionCount = rowCount + columnCount;
  const filtered = rows.filter((row) => shouldKeepTotal(
    Number(row.row_grouping), Number(row.column_grouping), rowCount, columnCount, config.totals,
  ));
  for (let start = 0; start < filtered.length; start += 500) {
    const batch = filtered.slice(start, start + 500);
    const params = [];
    const tuples = batch.map((row, index) => {
      const rowMask = Number(row.row_grouping);
      const columnMask = Number(row.column_grouping);
      const rowLevel = rowCount - bitCount(rowMask);
      const columnLevel = columnCount - bitCount(columnMask);
      const rowKey = Array.from({ length: rowCount }, (_, dimensionIndex) => row[`d${dimensionIndex}`]);
      const columnKey = Array.from({ length: columnCount }, (_, dimensionIndex) => row[`d${rowCount + dimensionIndex}`]);
      const values = Object.fromEntries(config.measures.map((measure, measureIndex) => [measure.id, row[`m${measureIndex}`]]));
      const offset = index * 7;
      params.push(job.id, start + index, JSON.stringify(rowKey), JSON.stringify(columnKey), JSON.stringify(values), rowLevel, columnLevel);
      return `($${offset + 1},$${offset + 2},$${offset + 3}::jsonb,$${offset + 4}::jsonb,$${offset + 5}::jsonb,$${offset + 6},$${offset + 7},${rowMask || columnMask ? "true" : "false"})`;
    });
    await pool.query(
      `INSERT INTO pivot_job_rows(job_id,row_index,row_key,column_key,values,row_level,column_level,is_total)
       VALUES ${tuples.join(",")}`,
      params,
    );
    await pool.query(
      "UPDATE pivot_jobs SET progress=$2,result_rows=$3 WHERE id=$1",
      [job.id, Math.min(96, 80 + Math.round(((start + batch.length) / Math.max(filtered.length, 1)) * 16)), start + batch.length],
    );
  }
  return filtered.length;
}

async function processPivotJob(job) {
  const pivotConfig = (await pool.query("SELECT * FROM pivot_configs WHERE id=$1", [job.pivot_config_id])).rows[0];
  if (!pivotConfig) throw pivotError("数据透视方案不存在", "PIVOT_CONFIG_NOT_FOUND", 404);
  const fields = await getFields(pivotConfig.table_id);
  const config = normalizePivotConfig(job.config_snapshot, fields);
  const maxRows = Number(process.env.PIVOT_MAX_RESULT_ROWS || 100000);
  const query = buildPivotQuery(pivotConfig.table_id, config, fields, maxRows);
  const client = await pool.connect();
  let result;
  try {
    const pid = (await client.query("SELECT pg_backend_pid() value")).rows[0].value;
    await pool.query("UPDATE pivot_jobs SET backend_pid=$2,progress=10 WHERE id=$1", [job.id, pid]);
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout='${Number(process.env.PIVOT_STATEMENT_TIMEOUT_MS || 300000)}ms'`);
    result = await client.query(query.sql, query.params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (result.rows.length > maxRows) {
    throw pivotError(`数据透视结果超过 ${maxRows} 行，请增加筛选或减少分组层级`, "PIVOT_RESULT_TOO_LARGE", 409);
  }
  await pool.query("DELETE FROM pivot_job_rows WHERE job_id=$1", [job.id]);
  await pool.query("UPDATE pivot_jobs SET progress=80,processed_records=source_records WHERE id=$1", [job.id]);
  const rowCount = await insertPivotRows(job, result.rows, config);
  const current = (await pool.query("SELECT status FROM pivot_jobs WHERE id=$1", [job.id])).rows[0];
  if (current?.status === "cancelled") return;
  await withTransaction(async (transaction) => {
    await transaction.query(
      `UPDATE pivot_jobs SET status='completed',progress=100,result_rows=$2,backend_pid=NULL,completed_at=now() WHERE id=$1`,
      [job.id, rowCount],
    );
    await transaction.query(
      `UPDATE pivot_configs SET last_job_id=$2,last_calculated_source_version=$3,updated_at=now()
       WHERE id=$1`,
      [job.pivot_config_id, job.id, job.source_version],
    );
  });
}

let workerBusy = false;
async function pivotWorkerTick() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const job = await claimPivotJob();
    if (job) await processPivotJob(job);
  } catch (error) {
    console.error("pivot worker", error);
    const active = (await pool.query("SELECT id,status FROM pivot_jobs WHERE status='computing' ORDER BY started_at LIMIT 1")).rows[0];
    if (active) await pool.query(
      `UPDATE pivot_jobs SET status='failed',backend_pid=NULL,error_message=$2,completed_at=now() WHERE id=$1 AND status<>'cancelled'`,
      [active.id, String(error.message || error).slice(0, 1000)],
    );
  } finally {
    workerBusy = false;
  }
}

export async function startPivotWorker() {
  await pool.query(
    `UPDATE pivot_jobs SET status='failed',backend_pid=NULL,error_message='服务重启导致任务中断，可重新计算',completed_at=now()
     WHERE status='computing'`,
  );
  const timer = setInterval(pivotWorkerTick, Number(process.env.PIVOT_WORKER_INTERVAL_MS || 700));
  timer.unref();
  pivotWorkerTick();
}

export async function cancelPivotJob(jobId) {
  const job = (await pool.query("SELECT * FROM pivot_jobs WHERE id=$1", [jobId])).rows[0];
  if (!job || !["pending", "computing"].includes(job.status)) {
    throw pivotError("当前数据透视任务不能取消", "PIVOT_JOB_STATE_INVALID", 409);
  }
  await pool.query("UPDATE pivot_jobs SET status='cancelled',completed_at=now(),progress=0 WHERE id=$1", [jobId]);
  if (job.backend_pid) await pool.query("SELECT pg_cancel_backend($1)", [job.backend_pid]);
  return { ...job, status: "cancelled" };
}

export async function getPivotRows(jobId, { offset = 0, limit = 200 } = {}) {
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  const job = (await pool.query(
    `SELECT j.*,p.name,p.table_id,p.base_id FROM pivot_jobs j JOIN pivot_configs p ON p.id=j.pivot_config_id WHERE j.id=$1`,
    [jobId],
  )).rows[0];
  if (!job) throw pivotError("数据透视任务不存在", "PIVOT_JOB_NOT_FOUND", 404);
  const rows = (await pool.query(
    `SELECT row_index,row_key,column_key,values,row_level,column_level,is_total
     FROM pivot_job_rows WHERE job_id=$1 AND row_index>=$2 ORDER BY row_index LIMIT $3`,
    [jobId, safeOffset, safeLimit],
  )).rows;
  return { job, rows, offset: safeOffset, limit: safeLimit, hasMore: safeOffset + rows.length < Number(job.result_rows) };
}

function buildDrilldownWhere(tableId, config, fields, resultRow) {
  const builder = createSqlBuilder(config, fields);
  const clauses = [`r.table_id=${builder.param(tableId)}`, "r.deleted_at IS NULL"];
  const filterSql = buildFilterSql(config, builder);
  if (filterSql) clauses.push(filterSql);
  const dimensions = [...config.rows.slice(0, resultRow.row_level), ...config.columns.slice(0, resultRow.column_level)];
  const values = [...resultRow.row_key.slice(0, resultRow.row_level), ...resultRow.column_key.slice(0, resultRow.column_level)];
  for (const [index, item] of dimensions.entries()) {
    const expression = builder.dimension(item).expression;
    const value = values[index];
    clauses.push(value === null ? `${expression} IS NULL` : `${expression}=${builder.param(value)}`);
  }
  return { sql: clauses.join(" AND "), params: builder.params };
}

export async function getPivotDrilldown(jobId, rowIndex, { offset = 0, limit = 100 } = {}) {
  const job = (await pool.query(
    `SELECT j.*,p.table_id,p.base_id FROM pivot_jobs j JOIN pivot_configs p ON p.id=j.pivot_config_id WHERE j.id=$1`,
    [jobId],
  )).rows[0];
  if (!job) throw pivotError("数据透视任务不存在", "PIVOT_JOB_NOT_FOUND", 404);
  const resultRow = (await pool.query(
    "SELECT * FROM pivot_job_rows WHERE job_id=$1 AND row_index=$2",
    [jobId, rowIndex],
  )).rows[0];
  if (!resultRow) throw pivotError("数据透视汇总单元格不存在", "PIVOT_ROW_NOT_FOUND", 404);
  const fields = await getFields(job.table_id);
  const config = normalizePivotConfig(job.config_snapshot, fields);
  const where = buildDrilldownWhere(job.table_id, config, fields, resultRow);
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
  const params = [...where.params, safeOffset, safeLimit];
  const offsetParam = `$${where.params.length + 1}`;
  const limitParam = `$${where.params.length + 2}`;
  const [records, count] = await Promise.all([
    pool.query(
      `SELECT id,values,version,created_at,updated_at FROM records r WHERE ${where.sql}
       ORDER BY id LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    ),
    pool.query(`SELECT count(*)::bigint total FROM records r WHERE ${where.sql}`, where.params),
  ]);
  return { records: records.rows, fields, total: count.rows[0].total, offset: safeOffset, limit: safeLimit, config };
}

export async function getPivotConfigState(pivotConfig) {
  const fields = await getFields(pivotConfig.table_id);
  let config;
  let invalidFields = [];
  try {
    config = normalizePivotConfig(pivotConfig.config, fields);
  } catch (error) {
    const available = new Set(fields.map((field) => field.id));
    const referenced = [
      ...(pivotConfig.config?.rows || []), ...(pivotConfig.config?.columns || []),
      ...(pivotConfig.config?.measures || []), ...(pivotConfig.config?.filters || []),
    ].map((item) => item.fieldId).filter(Boolean);
    invalidFields = [...new Set(referenced.filter((fieldId) => !available.has(fieldId)))];
    config = pivotConfig.config;
  }
  const source = await getPivotSourceVersion(pivotConfig.table_id);
  return {
    ...pivotConfig,
    config,
    invalidFields,
    dataUpdated: Boolean(pivotConfig.last_calculated_source_version && pivotConfig.last_calculated_source_version !== source.value),
    sourceRecords: source.records,
  };
}

export async function pivotFieldImpact(fieldId) {
  const { rows } = await pool.query(
    `SELECT p.id,p.name,p.table_id,t.name table_name,p.config FROM pivot_configs p
     JOIN data_tables t ON t.id=p.table_id AND t.deleted_at IS NULL
     WHERE p.config::text LIKE '%' || $1 || '%'`,
    [fieldId],
  );
  const configs = rows.filter((row) => {
    const items = [...(row.config.rows || []), ...(row.config.columns || []), ...(row.config.measures || []), ...(row.config.filters || [])];
    return items.some((item) => item.fieldId === fieldId);
  });
  const recordCount = configs.length ? (await pool.query(
    "SELECT count(*)::bigint value FROM records WHERE table_id=ANY($1::uuid[]) AND deleted_at IS NULL",
    [[...new Set(configs.map((row) => row.table_id))]],
  )).rows[0].value : 0;
  return { configs: configs.map(({ config, ...row }) => row), affectedRecords: String(recordCount) };
}

export function estimatePivotExport(job, format = "xlsx") {
  const rows = Number(job.result_rows || 0);
  const bytesPerRow = format === "csv" ? 90 : 140;
  return { rows, estimatedBytes: Math.max(512, rows * bytesPerRow) };
}
