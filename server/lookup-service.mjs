import { pool } from "./db.mjs";

export const LOOKUP_RETURN_TYPES = new Set(["text", "number", "date", "select"]);
export const LOOKUP_AGGREGATIONS = new Set([
  "first", "last", "unique_concat", "count", "sum", "average", "max", "min",
]);

function serviceError(message, code = "LOOKUP_FAILED") {
  return Object.assign(new Error(message), { code, status: 400 });
}

function emptyLookupValue(config = {}) {
  if (config.emptyPolicy === "default") return config.defaultValue ?? null;
  if (config.emptyPolicy === "unmatched") return "未匹配";
  return null;
}

function comparable(value, returnType) {
  if (returnType === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw serviceError("引用值不是有效数字", "LOOKUP_VALUE_NOT_NUMBER");
    return number;
  }
  if (returnType === "date") {
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) throw serviceError("引用值不是有效日期", "LOOKUP_VALUE_NOT_DATE");
    return time;
  }
  return String(value);
}

export function aggregateLookupValues(items, config = {}, returnType = "text") {
  const ordered = [...items].sort((a, b) => Number(a.ordinal || 0) - Number(b.ordinal || 0));
  if (ordered.some((item) => item.deleted)) return "来源记录已删除";
  const values = ordered
    .map((item) => item.value)
    .filter((value) => value !== undefined && value !== null && value !== "");
  if (!values.length) return emptyLookupValue(config);

  const aggregation = config.aggregation || "first";
  if (aggregation === "first") return values[0];
  if (aggregation === "last") return values.at(-1);
  if (aggregation === "unique_concat") {
    return [...new Set(values.map((value) => String(value)))].join(config.separator || "、");
  }
  if (aggregation === "count") return values.length;
  const comparableValues = values.map((value) => comparable(value, returnType));
  if (aggregation === "sum") return comparableValues.reduce((sum, value) => sum + value, 0);
  if (aggregation === "average") {
    return comparableValues.reduce((sum, value) => sum + value, 0) / comparableValues.length;
  }
  const selected = aggregation === "max"
    ? Math.max(...comparableValues)
    : Math.min(...comparableValues);
  if (returnType === "date") return values[comparableValues.indexOf(selected)];
  return selected;
}

export function validateAggregation(returnType, aggregation) {
  if (!LOOKUP_RETURN_TYPES.has(returnType)) {
    throw serviceError("查找引用只支持文本、数字、日期和单选字段", "LOOKUP_RETURN_TYPE_INVALID");
  }
  if (!LOOKUP_AGGREGATIONS.has(aggregation)) {
    throw serviceError("查找引用的汇总方式无效", "LOOKUP_AGGREGATION_INVALID");
  }
  if (["sum", "average"].includes(aggregation) && returnType !== "number") {
    throw serviceError("求和与平均值只能用于数字字段", "LOOKUP_AGGREGATION_INCOMPATIBLE");
  }
  if (["max", "min"].includes(aggregation) && !["number", "date"].includes(returnType)) {
    throw serviceError("最大值与最小值只能用于数字或日期字段", "LOOKUP_AGGREGATION_INCOMPATIBLE");
  }
}

export async function syncRecordRelations(client, { recordId, tableId, values, fields }) {
  const relationFields = fields.filter((field) => field.type === "relation" && Object.hasOwn(values, field.id));
  for (const field of relationFields) {
    const targetTableId = field.config?.targetTableId;
    const ids = [...new Set((Array.isArray(values[field.id]) ? values[field.id] : [values[field.id]])
      .filter((value) => value !== null && value !== undefined && value !== "")
      .map(String))];
    if (!targetTableId) throw serviceError(`字段“${field.name}”尚未配置目标数据表`, "RELATION_CONFIG_INVALID");
    if (field.config?.multiple === false && ids.length > 1) {
      throw serviceError(`字段“${field.name}”只能关联一条记录`, "RELATION_CARDINALITY_INVALID");
    }
    if (ids.length) {
      const existing = (await client.query(
        "SELECT id FROM records WHERE table_id=$1 AND id=ANY($2::bigint[]) AND deleted_at IS NULL",
        [targetTableId, ids],
      )).rows.map((row) => String(row.id));
      const missing = ids.filter((id) => !existing.includes(id));
      if (missing.length) throw serviceError(`字段“${field.name}”包含不存在或已删除的目标记录`, "RELATION_TARGET_NOT_FOUND");
    }
    await client.query(
      "DELETE FROM record_relations WHERE source_record_id=$1 AND relation_field_id=$2",
      [recordId, field.id],
    );
    if (ids.length) {
      await client.query(
        `INSERT INTO record_relations(
           source_record_id,source_table_id,relation_field_id,target_table_id,target_record_id,ordinal
         ) SELECT $1,$2,$3,$4,value::bigint,ordinality-1
           FROM unnest($5::text[]) WITH ORDINALITY AS targets(value,ordinality)`,
        [recordId, tableId, field.id, targetTableId, ids],
      );
    }
  }
}

async function markDirtyValues(client, lookupFieldIds) {
  if (!lookupFieldIds.length) return;
  await client.query(
    `INSERT INTO lookup_values(lookup_field_id,source_record_id,status,updated_at)
     SELECT d.lookup_field_id,d.source_record_id,'pending',now()
     FROM lookup_dirty_records d WHERE d.lookup_field_id=ANY($1::uuid[])
     ON CONFLICT(lookup_field_id,source_record_id) DO UPDATE
       SET status='pending',error_code=NULL,error_message=NULL,updated_at=now()`,
    [lookupFieldIds],
  );
}

export async function markLookupsDirtyForSource(client, tableId, recordIds, reason = "source_changed") {
  if (!recordIds.length) return [];
  const { rows } = await client.query(
    `INSERT INTO lookup_dirty_records(lookup_field_id,source_record_id,reason)
     SELECT d.lookup_field_id,r.id,$3
     FROM lookup_dependencies d JOIN records r ON r.table_id=d.source_table_id
     WHERE d.source_table_id=$1 AND r.id=ANY($2::bigint[]) AND r.deleted_at IS NULL
     ON CONFLICT(lookup_field_id,source_record_id) DO UPDATE SET reason=EXCLUDED.reason,created_at=now()
     RETURNING lookup_field_id`,
    [tableId, recordIds, reason],
  );
  const fieldIds = [...new Set(rows.map((row) => row.lookup_field_id))];
  await markDirtyValues(client, fieldIds);
  return fieldIds;
}

export async function markLookupsDirtyForTarget(client, tableId, recordIds, reason = "target_changed") {
  if (!recordIds.length) return [];
  const { rows } = await client.query(
    `INSERT INTO lookup_dirty_records(lookup_field_id,source_record_id,reason)
     SELECT DISTINCT d.lookup_field_id,rr.source_record_id,$3
     FROM lookup_dependencies d
     JOIN record_relations rr ON rr.relation_field_id=d.relation_field_id
       AND rr.target_table_id=d.target_table_id
     JOIN records source_record ON source_record.id=rr.source_record_id AND source_record.deleted_at IS NULL
     WHERE d.target_table_id=$1 AND rr.target_record_id=ANY($2::bigint[])
     ON CONFLICT(lookup_field_id,source_record_id) DO UPDATE SET reason=EXCLUDED.reason,created_at=now()
     RETURNING lookup_field_id`,
    [tableId, recordIds, reason],
  );
  const fieldIds = [...new Set(rows.map((row) => row.lookup_field_id))];
  await markDirtyValues(client, fieldIds);
  return fieldIds;
}

export async function enqueueLookupJob({ lookupFieldId, mode = "incremental", user, client = pool }) {
  let totalQuery;
  if (mode === "full") {
    totalQuery = `SELECT count(*)::bigint total FROM records r
      JOIN lookup_dependencies d ON d.source_table_id=r.table_id
      WHERE d.lookup_field_id=$1 AND r.deleted_at IS NULL`;
  } else if (mode === "retry_failed") {
    totalQuery = "SELECT count(*)::bigint total FROM lookup_values WHERE lookup_field_id=$1 AND status='failed'";
  } else {
    totalQuery = "SELECT count(*)::bigint total FROM lookup_dirty_records WHERE lookup_field_id=$1";
  }
  const total = (await client.query(totalQuery, [lookupFieldId])).rows[0]?.total || 0;
  try {
    return (await client.query(
      `INSERT INTO lookup_jobs(lookup_field_id,requested_by_user_id,requested_by,mode,total_records)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [lookupFieldId, user?.id || null, user?.username || "system", mode, total],
    )).rows[0];
  } catch (error) {
    if (error.code !== "23505") throw error;
    return (await client.query(
      "SELECT * FROM lookup_jobs WHERE lookup_field_id=$1 AND status IN ('pending','computing') ORDER BY created_at DESC LIMIT 1",
      [lookupFieldId],
    )).rows[0];
  }
}

export async function enqueueDirtyLookupJobs(client, lookupFieldIds, user) {
  const jobs = [];
  for (const lookupFieldId of lookupFieldIds) {
    jobs.push(await enqueueLookupJob({ lookupFieldId, mode: "incremental", user, client }));
  }
  return jobs;
}

export async function saveLookupDependency(client, field) {
  const relation = (await client.query(
    "SELECT id,table_id,config FROM fields WHERE id=$1 AND type='relation' AND deleted_at IS NULL",
    [field.config.relationFieldId],
  )).rows[0];
  if (!relation) throw serviceError("关联字段不存在或已删除", "LOOKUP_RELATION_NOT_FOUND");
  const targetTableId = relation.config?.targetTableId;
  const target = (await client.query(
    "SELECT id,type FROM fields WHERE id=$1 AND table_id=$2 AND deleted_at IS NULL",
    [field.config.targetFieldId, targetTableId],
  )).rows[0];
  if (!target) throw serviceError("返回字段不存在或已删除", "LOOKUP_TARGET_FIELD_NOT_FOUND");
  validateAggregation(target.type, field.config.aggregation || "first");
  await client.query(
    `INSERT INTO lookup_dependencies(
       lookup_field_id,source_table_id,relation_field_id,target_table_id,target_field_id
     ) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(lookup_field_id) DO UPDATE SET
       source_table_id=EXCLUDED.source_table_id,relation_field_id=EXCLUDED.relation_field_id,
       target_table_id=EXCLUDED.target_table_id,target_field_id=EXCLUDED.target_field_id,updated_at=now()`,
    [field.id, field.table_id, relation.id, targetTableId, target.id],
  );
  return { relation, target, targetTableId };
}

export async function removeLookupDependency(client, fieldId) {
  await client.query("DELETE FROM lookup_dependencies WHERE lookup_field_id=$1", [fieldId]);
}

export async function assertNoLookupCycle(client, sourceTableId, targetTableId, excludeFieldId = null) {
  if (sourceTableId === targetTableId) throw serviceError("查找引用不能依赖当前数据表", "LOOKUP_CYCLE");
  const { rows } = await client.query(
    `WITH RECURSIVE graph(source_table_id,target_table_id) AS (
       SELECT source_table_id,target_table_id FROM lookup_dependencies
       WHERE ($3::uuid IS NULL OR lookup_field_id<>$3)
     ), reachable(table_id) AS (
       SELECT $2::uuid
       UNION
       SELECT graph.target_table_id FROM graph JOIN reachable ON graph.source_table_id=reachable.table_id
     ) SELECT 1 FROM reachable WHERE table_id=$1 LIMIT 1`,
    [sourceTableId, targetTableId, excludeFieldId],
  );
  if (rows.length) throw serviceError("该配置会形成循环引用，请调整关联方向", "LOOKUP_CYCLE");
}

export async function resolveStoredLookups(records, fields, client = pool) {
  const lookupFields = fields.filter((field) => field.type === "lookup");
  if (!records.length || !lookupFields.length) return records;
  const { rows } = await client.query(
    `SELECT lookup_field_id,source_record_id,value,status,error_code,error_message,calculated_at
     FROM lookup_values WHERE lookup_field_id=ANY($1::uuid[]) AND source_record_id=ANY($2::bigint[])`,
    [lookupFields.map((field) => field.id), records.map((record) => record.id)],
  );
  const values = new Map(rows.map((row) => [`${row.source_record_id}:${row.lookup_field_id}`, row]));
  for (const record of records) {
    record.lookupStatuses = {};
    for (const field of lookupFields) {
      const result = values.get(`${record.id}:${field.id}`);
      if (result?.status === "completed") record.values[field.id] = result.value;
      else record.values[field.id] = null;
      record.lookupStatuses[field.id] = result || { status: "pending", error_message: null };
    }
  }
  return records;
}

export async function resolveRelationLabels(records, fields, client = pool) {
  const relationFields = fields.filter((field) => field.type === "relation");
  if (!records.length || !relationFields.length) return records;
  for (const field of relationFields) {
    const returnFieldId = field.config?.returnFieldId || field.config?.matchFieldId;
    const { rows } = await client.query(
      `SELECT rr.source_record_id,rr.target_record_id,rr.ordinal,target.values,target.deleted_at
       FROM record_relations rr JOIN records target ON target.id=rr.target_record_id
       WHERE rr.relation_field_id=$1 AND rr.source_record_id=ANY($2::bigint[])
       ORDER BY rr.source_record_id,rr.ordinal`,
      [field.id, records.map((record) => record.id)],
    );
    const grouped = new Map();
    for (const row of rows) {
      const label = row.deleted_at
        ? "来源记录已删除"
        : row.values?.[returnFieldId] ?? `记录 #${row.target_record_id}`;
      const item = { id: String(row.target_record_id), label: String(label), deleted: Boolean(row.deleted_at) };
      grouped.set(String(row.source_record_id), [...(grouped.get(String(row.source_record_id)) || []), item]);
    }
    for (const record of records) {
      record.relationLabels ||= {};
      record.relationLabels[field.id] = grouped.get(String(record.id)) || [];
      record.values[field.id] = record.relationLabels[field.id].map((item) => item.id);
    }
  }
  return records;
}

export async function fieldRuntimeMetadata(tableId, client = pool) {
  const dependencies = await client.query(
    `SELECT d.lookup_field_id,d.source_table_id,d.relation_field_id,d.target_table_id,d.target_field_id,
       source_table.name source_table_name,relation_field.name relation_field_name,
       target_table.name target_table_name,target_field.name target_field_name,target_field.type target_field_type,
       target_field.deleted_at target_field_deleted_at
     FROM lookup_dependencies d
     JOIN data_tables source_table ON source_table.id=d.source_table_id
     JOIN fields relation_field ON relation_field.id=d.relation_field_id
     JOIN data_tables target_table ON target_table.id=d.target_table_id
     JOIN fields target_field ON target_field.id=d.target_field_id
     WHERE d.source_table_id=$1`,
    [tableId],
  );
  const latestJobs = await client.query(
    `SELECT DISTINCT ON (j.lookup_field_id) j.* FROM lookup_jobs j
     JOIN fields f ON f.id=j.lookup_field_id WHERE f.table_id=$1
     ORDER BY j.lookup_field_id,j.created_at DESC`,
    [tableId],
  );
  return {
    dependencies: new Map(dependencies.rows.map((row) => [row.lookup_field_id, row])),
    jobs: new Map(latestJobs.rows.map((row) => [row.lookup_field_id, row])),
  };
}

export async function getFieldImpact(fieldId, client = pool) {
  const field = (await client.query(
    `SELECT f.*,t.name table_name FROM fields f JOIN data_tables t ON t.id=f.table_id
     WHERE f.id=$1 AND f.deleted_at IS NULL`,
    [fieldId],
  )).rows[0];
  if (!field) throw serviceError("字段不存在", "FIELD_NOT_FOUND");
  const { rows } = await client.query(
    `SELECT d.lookup_field_id,lookup_field.name lookup_field_name,source_table.id source_table_id,
       source_table.name source_table_name,count(DISTINCT rr.source_record_id)::bigint affected_records
     FROM lookup_dependencies d
     JOIN fields lookup_field ON lookup_field.id=d.lookup_field_id AND lookup_field.deleted_at IS NULL
     JOIN data_tables source_table ON source_table.id=d.source_table_id
     LEFT JOIN record_relations rr ON rr.relation_field_id=d.relation_field_id
     WHERE d.relation_field_id=$1 OR d.target_field_id=$1
     GROUP BY d.lookup_field_id,lookup_field.name,source_table.id,source_table.name
     ORDER BY source_table.name,lookup_field.name`,
    [fieldId],
  );
  return {
    field: { id: field.id, name: field.name, type: field.type, tableId: field.table_id, tableName: field.table_name },
    affectedTables: new Set(rows.map((row) => row.source_table_id)).size,
    affectedFields: rows.length,
    affectedRecords: rows.reduce((sum, row) => sum + Number(row.affected_records), 0),
    dependents: rows,
  };
}

async function loadDefinition(lookupFieldId) {
  const { rows } = await pool.query(
    `SELECT lookup_field.id lookup_field_id,lookup_field.config,lookup_field.deleted_at,
       d.source_table_id,d.relation_field_id,d.target_table_id,d.target_field_id,
       target_field.type target_field_type,target_field.deleted_at target_field_deleted_at
     FROM lookup_dependencies d
     JOIN fields lookup_field ON lookup_field.id=d.lookup_field_id
     JOIN fields target_field ON target_field.id=d.target_field_id
     WHERE d.lookup_field_id=$1`,
    [lookupFieldId],
  );
  const definition = rows[0];
  if (!definition || definition.deleted_at) throw serviceError("查找引用字段不存在或已删除", "LOOKUP_FIELD_NOT_FOUND");
  if (definition.target_field_deleted_at) throw serviceError("目标字段已删除", "LOOKUP_TARGET_FIELD_DELETED");
  validateAggregation(definition.target_field_type, definition.config?.aggregation || "first");
  return definition;
}

async function claimJob() {
  return (await pool.query(
    `UPDATE lookup_jobs SET status='computing',started_at=COALESCE(started_at,now())
     WHERE id=(SELECT id FROM lookup_jobs WHERE status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING *`,
  )).rows[0];
}

async function nextSourceIds(job, definition) {
  if (job.mode === "incremental") {
    return (await pool.query(
      "SELECT source_record_id id FROM lookup_dirty_records WHERE lookup_field_id=$1 ORDER BY created_at,source_record_id LIMIT $2",
      [job.lookup_field_id, job.batch_size],
    )).rows.map((row) => String(row.id));
  }
  if (job.mode === "retry_failed") {
    return (await pool.query(
      `SELECT source_record_id id FROM lookup_values
       WHERE lookup_field_id=$1 AND status='failed' AND source_record_id>$2 ORDER BY source_record_id LIMIT $3`,
      [job.lookup_field_id, job.last_record_id, job.batch_size],
    )).rows.map((row) => String(row.id));
  }
  return (await pool.query(
    `SELECT id FROM records WHERE table_id=$1 AND deleted_at IS NULL AND id>$2 ORDER BY id LIMIT $3`,
    [definition.source_table_id, job.last_record_id, job.batch_size],
  )).rows.map((row) => String(row.id));
}

async function calculateBatch(job, definition, sourceIds) {
  const targetRows = await pool.query(
    `SELECT rr.source_record_id,rr.ordinal,target.values->d.target_field_id::text value,target.deleted_at
     FROM lookup_dependencies d
     JOIN record_relations rr ON rr.relation_field_id=d.relation_field_id
     JOIN records target ON target.id=rr.target_record_id
     WHERE d.lookup_field_id=$1 AND rr.source_record_id=ANY($2::bigint[])
     ORDER BY rr.source_record_id,rr.ordinal`,
    [job.lookup_field_id, sourceIds],
  );
  const grouped = new Map();
  for (const row of targetRows.rows) {
    const key = String(row.source_record_id);
    grouped.set(key, [...(grouped.get(key) || []), {
      value: row.value,
      deleted: Boolean(row.deleted_at),
      ordinal: row.ordinal,
    }]);
  }
  const results = [];
  for (const sourceRecordId of sourceIds) {
    try {
      const value = aggregateLookupValues(grouped.get(sourceRecordId) || [], definition.config, definition.target_field_type);
      results.push({ source_record_id: sourceRecordId, value, status: "completed", error_code: null, error_message: null });
    } catch (error) {
      results.push({
        source_record_id: sourceRecordId,
        value: null,
        status: "failed",
        error_code: error.code || "LOOKUP_RECORD_FAILED",
        error_message: error.message,
      });
    }
  }
  await pool.query(
    `INSERT INTO lookup_values(lookup_field_id,source_record_id,value,status,error_code,error_message,calculated_at,updated_at)
     SELECT $1,x.source_record_id,x.value,x.status,x.error_code,x.error_message,now(),now()
     FROM jsonb_to_recordset($2::jsonb) AS x(
       source_record_id bigint,value jsonb,status text,error_code text,error_message text
     ) ON CONFLICT(lookup_field_id,source_record_id) DO UPDATE SET
       value=EXCLUDED.value,status=EXCLUDED.status,error_code=EXCLUDED.error_code,
       error_message=EXCLUDED.error_message,calculated_at=now(),updated_at=now()`,
    [job.lookup_field_id, JSON.stringify(results)],
  );
  const failures = results.filter((result) => result.status === "failed");
  if (failures.length) {
    await pool.query(
      `INSERT INTO lookup_job_failures(job_id,lookup_field_id,source_record_id,error_code,error_message)
       SELECT $1,$2,x.source_record_id,x.error_code,x.error_message
       FROM jsonb_to_recordset($3::jsonb) AS x(source_record_id bigint,error_code text,error_message text)
       ON CONFLICT(job_id,source_record_id) DO UPDATE SET
         error_code=EXCLUDED.error_code,error_message=EXCLUDED.error_message,created_at=now()`,
      [job.id, job.lookup_field_id, JSON.stringify(failures)],
    );
  }
  if (job.mode === "incremental") {
    await pool.query(
      "DELETE FROM lookup_dirty_records WHERE lookup_field_id=$1 AND source_record_id=ANY($2::bigint[])",
      [job.lookup_field_id, sourceIds],
    );
  }
  return { success: results.length - failures.length, failed: failures.length };
}

async function processJob(job) {
  try {
    const definition = await loadDefinition(job.lookup_field_id);
    let processed = Number(job.processed_records || 0);
    let success = Number(job.success_records || 0);
    let failed = Number(job.failed_records || 0);
    let lastRecordId = Number(job.last_record_id || 0);
    while (true) {
      const sourceIds = await nextSourceIds({ ...job, last_record_id: lastRecordId }, definition);
      if (!sourceIds.length) break;
      const batch = await calculateBatch(job, definition, sourceIds);
      processed += sourceIds.length;
      success += batch.success;
      failed += batch.failed;
      if (job.mode !== "incremental") lastRecordId = Number(sourceIds.at(-1));
      await pool.query(
        `UPDATE lookup_jobs SET processed_records=$2,success_records=$3,failed_records=$4,last_record_id=$5
         WHERE id=$1`,
        [job.id, processed, success, failed, lastRecordId],
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    const status = failed && success ? "partial" : failed ? "failed" : "completed";
    await pool.query(
      `UPDATE lookup_jobs SET status=$2,processed_records=$3,success_records=$4,failed_records=$5,
       completed_at=now() WHERE id=$1`,
      [job.id, status, processed, success, failed],
    );
    if (job.mode !== "incremental") {
      const dirty = Number((await pool.query(
        "SELECT count(*) value FROM lookup_dirty_records WHERE lookup_field_id=$1",
        [job.lookup_field_id],
      )).rows[0].value);
      if (dirty) {
        await enqueueLookupJob({
          lookupFieldId: job.lookup_field_id,
          mode: "incremental",
          user: { id: job.requested_by_user_id, username: job.requested_by },
        });
      }
    }
  } catch (error) {
    await pool.query(
      "UPDATE lookup_jobs SET status='failed',error_message=$2,completed_at=now() WHERE id=$1",
      [job.id, error.message],
    );
  }
}

let workerBusy = false;
async function workerTick() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const job = await claimJob();
    if (job) await processJob(job);
  } catch (error) {
    console.error("lookup worker", error);
  } finally {
    workerBusy = false;
  }
}

export async function startLookupWorker() {
  await pool.query(
    `UPDATE lookup_jobs SET status='failed',error_message='服务重启导致任务中断，可重新执行',completed_at=now()
     WHERE status='computing'`,
  );
  const timer = setInterval(workerTick, Number(process.env.LOOKUP_WORKER_INTERVAL_MS || 700));
  timer.unref();
  workerTick();
}
