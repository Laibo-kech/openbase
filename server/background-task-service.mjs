import crypto from "node:crypto";
import { pool, withTransaction } from "./db.mjs";

const SOURCE_TYPES = new Set(["lookup", "catalog", "pivot"]);
const TERMINAL_STATUSES = new Set(["completed", "partial_success", "failed", "cancelled", "interrupted"]);

function taskError(message, code = "BACKGROUND_TASK_FAILED", status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export async function registerBackgroundTask({
  baseId, tableId, taskType, sourceJobType, sourceJobId, user, totalRecords = 0, metadata = {}, client = pool,
}) {
  if (!SOURCE_TYPES.has(sourceJobType)) throw taskError("后台任务来源类型无效");
  return (await client.query(
    `INSERT INTO background_tasks(base_id,table_id,task_type,source_job_type,source_job_id,conflict_key,
       requested_by_user_id,requested_by,total_records,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT(source_job_type,source_job_id) DO UPDATE SET
       total_records=GREATEST(background_tasks.total_records,EXCLUDED.total_records),
       metadata=background_tasks.metadata || EXCLUDED.metadata
     RETURNING *`,
    [baseId, tableId, taskType, sourceJobType, sourceJobId, `table:${tableId}`,
      user?.id || null, user?.username || "system", totalRecords, JSON.stringify(metadata)],
  )).rows[0];
}

export async function claimBackgroundTask(sourceJobType) {
  if (!SOURCE_TYPES.has(sourceJobType)) throw taskError("后台任务来源类型无效");
  return withTransaction(async (client) => {
    const task = (await client.query(
      `SELECT candidate.* FROM background_tasks candidate
       WHERE candidate.source_job_type=$1 AND candidate.status IN ('running','waiting')
         AND (candidate.status='running' OR NOT EXISTS (
           SELECT 1 FROM background_tasks active
           WHERE active.conflict_key=candidate.conflict_key AND active.status='running'
         ))
       ORDER BY CASE WHEN candidate.status='running' THEN 0 ELSE 1 END,candidate.created_at
       FOR UPDATE SKIP LOCKED LIMIT 1`,
      [sourceJobType],
    )).rows[0];
    if (!task) return null;
    return (await client.query(
      `UPDATE background_tasks SET status='running',started_at=COALESCE(started_at,now()),
         heartbeat_at=now(),error_message=NULL WHERE id=$1 RETURNING *`,
      [task.id],
    )).rows[0];
  });
}

export async function syncBackgroundTask(sourceJobType, sourceJobId, update = {}) {
  const statusMap = {
    pending: "waiting", computing: "running", paused: "waiting", completed: "completed",
    partial: "partial_success", failed: "failed", cancelled: "cancelled", reverted: "completed",
  };
  return withTransaction(async (client) => {
    const current = (await client.query(
      "SELECT * FROM background_tasks WHERE source_job_type=$1 AND source_job_id=$2 FOR UPDATE",
      [sourceJobType, sourceJobId],
    )).rows[0];
    if (!current) return null;
    const nextStatus = statusMap[update.status] || update.status || current.status;
    const total = update.totalRecords === undefined ? Number(current.total_records) : Number(update.totalRecords || 0);
    const processed = update.processedRecords === undefined ? Number(current.processed_records) : Number(update.processedRecords || 0);
    const failed = update.failedRecords === undefined ? Number(current.failed_records) : Number(update.failedRecords || 0);
    const progress = update.progress === undefined
      ? (TERMINAL_STATUSES.has(nextStatus) ? 100 : total ? Math.min(99, Math.round(processed / total * 100)) : 0)
      : Math.max(0, Math.min(100, Number(update.progress || 0)));
    const terminal = TERMINAL_STATUSES.has(nextStatus);
    const row = (await client.query(
      `UPDATE background_tasks SET status=$2,total_records=$3,processed_records=$4,failed_records=$5,
         progress=$6,heartbeat_at=now(),error_message=$7,
         completed_at=CASE WHEN $8 THEN COALESCE(completed_at,now()) ELSE NULL END,
         duration_ms=CASE WHEN $8 THEN (extract(epoch FROM (COALESCE(completed_at,now())-COALESCE(started_at,created_at)))*1000)::bigint ELSE NULL END
       WHERE id=$1 RETURNING *`,
      [current.id, nextStatus, total, processed, failed, terminal ? 100 : progress,
        update.errorMessage === undefined ? current.error_message : update.errorMessage, terminal],
    )).rows[0];
    if (terminal && !TERMINAL_STATUSES.has(current.status)) {
      await client.query(
        `INSERT INTO performance_events(background_task_id,operation,base_id,table_id,duration_ms,processed_records,success,details)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [row.id, row.task_type, row.base_id, row.table_id, row.duration_ms || 0, row.processed_records,
          ["completed", "partial_success"].includes(row.status), JSON.stringify({ sourceJobType, sourceJobId, attempt: row.attempt })],
      );
    }
    return row;
  });
}

export async function recoverBackgroundTasks() {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO background_tasks(base_id,table_id,task_type,source_job_type,source_job_id,conflict_key,
         requested_by_user_id,requested_by,total_records,processed_records,failed_records,metadata)
       SELECT t.base_id,d.source_table_id,'lookup_recalculation','lookup',j.id,'table:'||d.source_table_id,
         j.requested_by_user_id,j.requested_by,j.total_records,j.processed_records,j.failed_records,
         jsonb_build_object('mode',j.mode,'fieldId',j.lookup_field_id,'fieldName',f.name,'tableName',t.name)
       FROM lookup_jobs j JOIN lookup_dependencies d ON d.lookup_field_id=j.lookup_field_id
       JOIN fields f ON f.id=j.lookup_field_id JOIN data_tables t ON t.id=d.source_table_id
       WHERE j.status IN ('pending','computing') ON CONFLICT(source_job_type,source_job_id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO background_tasks(base_id,table_id,task_type,source_job_type,source_job_id,conflict_key,
         requested_by_user_id,requested_by,total_records,processed_records,metadata)
       SELECT c.base_id,c.source_table_id,'catalog_match','catalog',j.id,'table:'||c.source_table_id,
         j.requested_by_user_id,j.requested_by,j.total_records,j.processed_records,
         jsonb_build_object('mode',j.mode,'stage',j.stage,'configId',c.id,'configName',c.name,'tableName',t.name)
       FROM catalog_match_jobs j JOIN catalog_match_configs c ON c.id=j.config_id
       JOIN data_tables t ON t.id=c.source_table_id WHERE j.status IN ('pending','computing','paused')
       ON CONFLICT(source_job_type,source_job_id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO background_tasks(base_id,table_id,task_type,source_job_type,source_job_id,conflict_key,
         requested_by_user_id,requested_by,total_records,processed_records,progress,metadata)
       SELECT p.base_id,p.table_id,'pivot_calculation','pivot',j.id,'table:'||p.table_id,
         j.requested_by_user_id,j.requested_by,j.source_records,j.processed_records,j.progress,
         jsonb_build_object('pivotConfigId',p.id,'configName',p.name,'tableName',t.name)
       FROM pivot_jobs j JOIN pivot_configs p ON p.id=j.pivot_config_id JOIN data_tables t ON t.id=p.table_id
       WHERE j.status IN ('pending','computing') ON CONFLICT(source_job_type,source_job_id) DO NOTHING`,
    );
    const interrupted = (await client.query(
      "SELECT source_job_type,source_job_id FROM background_tasks WHERE status='running' FOR UPDATE",
    )).rows;
    await client.query(
      `UPDATE lookup_jobs SET status='pending',error_message='服务重启后自动恢复',completed_at=NULL
       WHERE status='computing'`,
    );
    await client.query(
      `UPDATE catalog_match_jobs SET status='pending',error_message='服务重启后自动恢复',completed_at=NULL
       WHERE status='computing'`,
    );
    await client.query(
      `DELETE FROM pivot_job_rows WHERE job_id IN (SELECT id FROM pivot_jobs WHERE status='computing')`,
    );
    await client.query(
      `UPDATE pivot_jobs SET status='pending',backend_pid=NULL,processed_records=0,result_rows=0,progress=0,
         error_message='服务重启后自动恢复',completed_at=NULL WHERE status='computing'`,
    );
    await client.query(
      `UPDATE background_tasks SET status='waiting',recovery_count=recovery_count+1,started_at=NULL,
         heartbeat_at=NULL,completed_at=NULL,duration_ms=NULL,error_message='服务重启后自动恢复',
         metadata=metadata || jsonb_build_object('lastRecoveryAt',now()) WHERE status='running'`,
    );
    return interrupted.length;
  });
}

export async function cancelBackgroundTask(taskId) {
  return withTransaction(async (client) => {
    const task = (await client.query("SELECT * FROM background_tasks WHERE id=$1 FOR UPDATE", [taskId])).rows[0];
    if (!task || !["waiting", "running"].includes(task.status)) {
      throw taskError("当前任务不能取消", "BACKGROUND_TASK_STATE_INVALID", 409);
    }
    if (task.source_job_type === "lookup") {
      await client.query("UPDATE lookup_jobs SET status='cancelled',completed_at=now() WHERE id=$1 AND status IN ('pending','computing')", [task.source_job_id]);
    } else if (task.source_job_type === "catalog") {
      await client.query("UPDATE catalog_match_jobs SET status='cancelled',completed_at=now() WHERE id=$1 AND status IN ('pending','computing','paused')", [task.source_job_id]);
    } else {
      const job = (await client.query("SELECT backend_pid FROM pivot_jobs WHERE id=$1", [task.source_job_id])).rows[0];
      await client.query("UPDATE pivot_jobs SET status='cancelled',backend_pid=NULL,completed_at=now(),progress=0 WHERE id=$1 AND status IN ('pending','computing')", [task.source_job_id]);
      if (job?.backend_pid) await client.query("SELECT pg_cancel_backend($1)", [job.backend_pid]);
    }
    const cancelled = (await client.query(
      `UPDATE background_tasks SET status='cancelled',cancel_requested=true,completed_at=now(),progress=100,
         duration_ms=(extract(epoch FROM (now()-COALESCE(started_at,created_at)))*1000)::bigint WHERE id=$1 RETURNING *`,
      [task.id],
    )).rows[0];
    await client.query(
      `INSERT INTO performance_events(background_task_id,operation,base_id,table_id,duration_ms,processed_records,success,details)
       VALUES($1,$2,$3,$4,$5,$6,false,$7::jsonb)`,
      [cancelled.id, cancelled.task_type, cancelled.base_id, cancelled.table_id, cancelled.duration_ms || 0,
        cancelled.processed_records, JSON.stringify({ cancelled: true, attempt: cancelled.attempt })],
    );
    return cancelled;
  });
}

export async function retryBackgroundTask(taskId) {
  return withTransaction(async (client) => {
    const task = (await client.query("SELECT * FROM background_tasks WHERE id=$1 FOR UPDATE", [taskId])).rows[0];
    if (!task || !["failed", "interrupted"].includes(task.status)) {
      throw taskError("只有失败或中断的任务可以重试", "BACKGROUND_TASK_STATE_INVALID", 409);
    }
    if (task.source_job_type === "lookup") {
      await client.query("UPDATE lookup_jobs SET status='pending',error_message=NULL,completed_at=NULL WHERE id=$1", [task.source_job_id]);
    } else if (task.source_job_type === "catalog") {
      await client.query("UPDATE catalog_match_jobs SET status='pending',error_message=NULL,completed_at=NULL WHERE id=$1", [task.source_job_id]);
    } else {
      await client.query("DELETE FROM pivot_job_rows WHERE job_id=$1", [task.source_job_id]);
      await client.query(
        "UPDATE pivot_jobs SET status='pending',processed_records=0,result_rows=0,progress=0,backend_pid=NULL,error_message=NULL,completed_at=NULL WHERE id=$1",
        [task.source_job_id],
      );
    }
    return (await client.query(
      `UPDATE background_tasks SET status='waiting',attempt=attempt+1,cancel_requested=false,error_message=NULL,
         started_at=NULL,heartbeat_at=NULL,completed_at=NULL,duration_ms=NULL,progress=0 WHERE id=$1 RETURNING *`,
      [task.id],
    )).rows[0];
  });
}

export async function estimateFieldIndexes(tableId, fieldIds) {
  const ids = [...new Set((fieldIds || []).map(String))];
  const fields = (await pool.query(
    "SELECT id,name,type FROM fields WHERE table_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL",
    [tableId, ids],
  )).rows;
  if (!ids.length || fields.length !== ids.length) throw taskError("索引字段无效", "INDEX_FIELD_INVALID");
  const stats = (await pool.query(
    `SELECT count(*)::bigint records,COALESCE(avg(pg_column_size(values)),0)::bigint average_row_bytes
     FROM records WHERE table_id=$1 AND deleted_at IS NULL`,
    [tableId],
  )).rows[0];
  const records = Number(stats.records || 0);
  const averageKeyBytes = Math.max(24, Math.min(256, Math.round(Number(stats.average_row_bytes || 0) / Math.max(fields.length, 1))));
  const estimatedBytes = Math.ceil(records * (averageKeyBytes + 40) * 1.2 * fields.length);
  return {
    tableId, fields, records: String(records), estimatedBytes: String(estimatedBytes),
    estimatedSeconds: Math.max(1, Math.ceil(records * fields.length / 75000)),
    buildMode: "concurrent", blocksWrites: false,
  };
}

export async function ensureFieldPerformanceIndexes(tableId, fieldIds, purpose) {
  if (!["catalog", "pivot", "relation"].includes(purpose)) throw taskError("索引用途无效", "INDEX_PURPOSE_INVALID");
  const estimate = await estimateFieldIndexes(tableId, fieldIds);
  for (const field of estimate.fields) {
    const suffix = crypto.createHash("sha1").update(`${tableId}:${field.id}:${purpose}`).digest("hex").slice(0, 16);
    const indexName = `records_${purpose}_${suffix}_idx`;
    await pool.query(
      `INSERT INTO field_performance_indexes(table_id,field_id,purpose,index_name,status,estimated_bytes,estimated_seconds)
       VALUES($1,$2,$3,$4,'building',$5,$6)
       ON CONFLICT(table_id,field_id,purpose) DO UPDATE SET status='building',estimated_bytes=EXCLUDED.estimated_bytes,
         estimated_seconds=EXCLUDED.estimated_seconds,error_message=NULL,completed_at=NULL`,
      [tableId, field.id, purpose, indexName, estimate.estimatedBytes, estimate.estimatedSeconds],
    );
    try {
      await pool.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName}
         ON records(table_id,((values->>'${field.id}'))) WHERE deleted_at IS NULL`,
      );
      const bytes = (await pool.query("SELECT COALESCE(pg_relation_size(to_regclass($1)),0)::bigint bytes", [indexName])).rows[0].bytes;
      await pool.query(
        "UPDATE field_performance_indexes SET status='ready',actual_bytes=$2,completed_at=now() WHERE index_name=$1",
        [indexName, bytes],
      );
    } catch (error) {
      await pool.query(
        "UPDATE field_performance_indexes SET status='failed',error_message=$2,completed_at=now() WHERE index_name=$1",
        [indexName, String(error.message || error).slice(0, 1000)],
      );
      throw error;
    }
  }
  return estimate;
}

export async function ensureCorePerformanceIndexes() {
  const statements = [
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS lookup_values_source_field_idx ON lookup_values(source_record_id,lookup_field_id)",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_match_results_target_idx ON catalog_match_results(target_record_id,updated_at DESC) WHERE target_record_id IS NOT NULL",
  ];
  for (const statement of statements) await pool.query(statement);
}
