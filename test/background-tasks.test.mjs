import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("unified background tasks cover queueing, recovery, cancellation and retry", () => {
  const schema = read("server/db.mjs");
  const service = read("server/background-task-service.mjs");
  for (const marker of [
    "CREATE TABLE IF NOT EXISTS background_tasks", "partial_success", "conflict_key",
    "performance_events", "field_performance_indexes",
  ]) assert.match(schema, new RegExp(marker));
  for (const marker of [
    "claimBackgroundTask", "FOR UPDATE SKIP LOCKED", "active.conflict_key=candidate.conflict_key",
    "recoverBackgroundTasks", "服务重启后自动恢复", "cancelBackgroundTask", "retryBackgroundTask",
  ]) assert.match(service, new RegExp(marker));
});

test("lookup, catalog and pivot workers report to the unified task table", () => {
  for (const path of ["server/lookup-service.mjs", "server/catalog-service.mjs", "server/pivot-service.mjs"]) {
    const source = read(path);
    assert.match(source, /registerBackgroundTask/);
    assert.match(source, /claimBackgroundTask/);
    assert.match(source, /syncBackgroundTask/);
  }
});

test("performance controls and monitoring endpoints are present", () => {
  const service = read("server/background-task-service.mjs");
  const app = read("server/index.mjs");
  const admin = read("server/admin.mjs");
  const pivot = read("server/pivot-service.mjs");
  assert.match(service, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  assert.match(app, /index-estimate/);
  assert.match(pivot, /statement_timeout/);
  assert.match(admin, /database-monitor/);
  assert.match(admin, /slow-tasks/);
  assert.match(admin, /pg_stat_activity/);
});

test("user and admin interfaces expose task monitoring", () => {
  const app = read("src/App.jsx");
  const taskCenter = read("src/BackgroundTaskCenter.jsx");
  const admin = read("admin/admin.js");
  assert.match(app, /任务中心/);
  for (const marker of ["创建账号", "开始时间", "完成时间", "处理数量", "失败重试", "关闭页面不会中断任务"]) {
    assert.match(taskCenter, new RegExp(marker));
  }
  assert.match(admin, /任务监控/);
  assert.match(admin, /慢任务统计/);
  assert.match(admin, /数据库监控/);
});
