import crypto from "node:crypto";
import { pool } from "../server/db.mjs";
import {
  cancelBackgroundTask,
  claimBackgroundTask,
  ensureFieldPerformanceIndexes,
  estimateFieldIndexes,
  recoverBackgroundTasks,
  registerBackgroundTask,
  retryBackgroundTask,
  syncBackgroundTask,
} from "../server/background-task-service.mjs";

const marker = `acceptance-${Date.now()}`;
const createdTaskIds = [];
let insertedRecordId = null;

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function createTask(context, sourceJobType, taskType) {
  const task = await registerBackgroundTask({
    baseId: context.base_id,
    tableId: context.table_id,
    taskType,
    sourceJobType,
    sourceJobId: crypto.randomUUID(),
    user: { id: context.user_id, username: context.username },
    totalRecords: 100,
    metadata: { acceptanceMarker: marker, tableName: context.table_name },
  });
  createdTaskIds.push(task.id);
  return task;
}

try {
  const context = (await pool.query(
    `SELECT b.id base_id,b.owner_user_id user_id,u.username,t.id table_id,t.name table_name
     FROM bases b JOIN users u ON u.id=b.owner_user_id JOIN data_tables t ON t.base_id=b.id
     WHERE b.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY t.created_at LIMIT 1`,
  )).rows[0];
  assert(context, "A candidate table is required");
  const field = (await pool.query(
    "SELECT id FROM fields WHERE table_id=$1 AND deleted_at IS NULL AND type IN ('text','number','date','select') ORDER BY position LIMIT 1",
    [context.table_id],
  )).rows[0];
  assert(field, "A candidate field is required");

  const lookup = await createTask(context, "lookup", "lookup_recalculation");
  const pivot = await createTask(context, "pivot", "pivot_calculation");
  const claimedLookup = await claimBackgroundTask("lookup");
  assert(claimedLookup?.id === lookup.id && claimedLookup.status === "running", "First same-table task was not claimed");
  const blockedPivot = await claimBackgroundTask("pivot");
  assert(blockedPivot === null, "Conflicting same-table task did not wait");
  await syncBackgroundTask("lookup", lookup.source_job_id, { status: "completed", processedRecords: 100, totalRecords: 100 });
  const claimedPivot = await claimBackgroundTask("pivot");
  assert(claimedPivot?.id === pivot.id, "Queued task was not released after the conflict completed");
  await syncBackgroundTask("pivot", pivot.source_job_id, { status: "completed", processedRecords: 100, totalRecords: 100 });

  const cancellable = await createTask(context, "lookup", "lookup_recalculation");
  const cancelled = await cancelBackgroundTask(cancellable.id);
  assert(cancelled.status === "cancelled", "Waiting task was not cancelled");
  await pool.query("UPDATE background_tasks SET status='failed',error_message='acceptance failure' WHERE id=$1", [cancellable.id]);
  const retried = await retryBackgroundTask(cancellable.id);
  assert(retried.status === "waiting" && Number(retried.attempt) === 2, "Failed task was not reset for retry");
  const retriedClaim = await claimBackgroundTask("lookup");
  assert(retriedClaim?.id === cancellable.id, "Retried task was not claimable");
  await syncBackgroundTask("lookup", cancellable.source_job_id, { status: "completed", processedRecords: 100, totalRecords: 100 });

  const recoverable = await createTask(context, "catalog", "catalog_match");
  const claimedRecoverable = await claimBackgroundTask("catalog");
  assert(claimedRecoverable?.id === recoverable.id, "Recoverable task was not claimed");
  const recoveredCount = await recoverBackgroundTasks();
  const recovered = (await pool.query("SELECT * FROM background_tasks WHERE id=$1", [recoverable.id])).rows[0];
  assert(recoveredCount >= 1 && recovered.status === "waiting" && Number(recovered.recovery_count) >= 1, "Running task did not recover after restart simulation");
  await syncBackgroundTask("catalog", recoverable.source_job_id, { status: "completed", processedRecords: 100, totalRecords: 100 });

  const estimate = await estimateFieldIndexes(context.table_id, [field.id]);
  assert(estimate.buildMode === "concurrent" && estimate.blocksWrites === false, "Index estimate did not select concurrent build mode");
  await ensureFieldPerformanceIndexes(context.table_id, [field.id], "pivot");
  const index = (await pool.query(
    "SELECT * FROM field_performance_indexes WHERE table_id=$1 AND field_id=$2 AND purpose='pivot'",
    [context.table_id, field.id],
  )).rows[0];
  assert(index?.status === "ready", "Concurrent field index was not completed");

  const active = await createTask(context, "lookup", "lookup_recalculation");
  await claimBackgroundTask("lookup");
  const writeStarted = Date.now();
  insertedRecordId = (await pool.query(
    "INSERT INTO records(table_id,values) VALUES($1,$2::jsonb) RETURNING id",
    [context.table_id, JSON.stringify({ [field.id]: marker })],
  )).rows[0].id;
  const writeMs = Date.now() - writeStarted;
  assert(writeMs < 1000, `Normal record write was blocked for ${writeMs}ms`);
  await syncBackgroundTask("lookup", active.source_job_id, { status: "completed", processedRecords: 100, totalRecords: 100 });

  const metrics = Number((await pool.query(
    "SELECT count(*) value FROM performance_events WHERE background_task_id=ANY($1::uuid[])",
    [createdTaskIds],
  )).rows[0].value);
  assert(metrics >= createdTaskIds.length, "Task execution timing records are incomplete");

  console.log(JSON.stringify({
    ok: true,
    sameTableConflictQueued: true,
    cancelAndRetry: true,
    restartRecovery: true,
    recoveryCount: Number(recovered.recovery_count),
    index: { mode: estimate.buildMode, estimatedBytes: estimate.estimatedBytes, actualBytes: String(index.actual_bytes) },
    normalWriteMs: writeMs,
    performanceEvents: metrics,
  }));
} finally {
  if (insertedRecordId) await pool.query("DELETE FROM records WHERE id=$1", [insertedRecordId]).catch(() => {});
  if (createdTaskIds.length) await pool.query("DELETE FROM background_tasks WHERE id=ANY($1::uuid[])", [createdTaskIds]).catch(() => {});
  await pool.end();
}
