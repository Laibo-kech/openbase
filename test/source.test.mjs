import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("production files exist and do not contain temporary secrets", () => {
  for (const file of ["Dockerfile","docker-compose.yml","server/index.mjs","server/db.mjs","src/App.jsx","src/styles.css"]) {
    assert.equal(fs.existsSync(new URL(`../${file}`, import.meta.url)), true, `${file} missing`);
  }
  const source = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  for (const marker of ["BEGIN PRIVATE KEY", "POSTGRES_PASSWORD=postgres", "ADMIN_PASSWORD=admin"]) {
    assert.equal(source.includes(marker), false, marker);
  }
});

test("API implements auth, cursor pagination, soft delete and streaming export", () => {
  const source = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  for (const marker of ["/api/auth/login","id>${afterParam}","deleted_at=now()","export.csv","resolveLookups"]) assert.equal(source.includes(marker), true, marker);
});

test("soft-deleted field names can be reused without weakening active uniqueness", () => {
  const source = fs.readFileSync(new URL("../server/db.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("DROP CONSTRAINT IF EXISTS fields_table_id_name_key"), true);
  assert.equal(source.includes("fields_table_name_active_unique ON fields(table_id, name) WHERE deleted_at IS NULL"), true);
});

test("frontend supports the direct-IP subpath without breaking the domain root", () => {
  const apiSource = fs.readFileSync(new URL("../src/api.js", import.meta.url), "utf8");
  const viteSource = fs.readFileSync(new URL("../vite.config.js", import.meta.url), "utf8");
  assert.equal(apiSource.includes('startsWith("/multibase-v1/")'), true);
  assert.equal(apiSource.includes("publicPath(`/api${path}`)"), true);
  assert.equal(viteSource.includes('base: "./"'), true);
});

test("expected 4xx responses do not pollute server error logs", () => {
  const source = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("if (status >= 500) console.error(error)"), true);
});

test("rename, saved views and draggable column widths are implemented", () => {
  const server = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  for (const marker of ['app.patch("/api/tables/:tableId"', 'app.post("/api/tables/:tableId/views"', "normalizeColumnWidths"]) {
    assert.equal(server.includes(marker), true, marker);
  }
  for (const marker of ["onContextMenu", "新建视图", "column-resizer", "拖拽调整列宽"]) {
    assert.equal(app.includes(marker), true, marker);
  }
  assert.equal(styles.includes(".column-resizer"), true);
});

test("table-scoped import templates and filtered export estimates are implemented", () => {
  const server = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  for (const marker of ["import-template.xlsx", "_multibase_meta", "export-estimate", "readFilters(req.query.filters)"]) {
    assert.equal(server.includes(marker), true, marker);
  }
  for (const marker of ["导入数据", "导出数据", "唯一导入 ID", "预计文件大小", "只导出这张数据表"]) {
    assert.equal(app.includes(marker), true, marker);
  }
  assert.equal(app.includes("导入中心"), false);
  assert.equal(app.includes("导出任务中心"), false);
});

test("multi-user isolation, registration and separate admin console are implemented", () => {
  const server = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const database = fs.readFileSync(new URL("../server/db.mjs", import.meta.url), "utf8");
  const admin = fs.readFileSync(new URL("../server/admin.mjs", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  for (const marker of ["/api/auth/register", "requireResourceAccess", "b.owner_user_id=$2", "user_id=$1"]) {
    assert.equal(server.includes(marker), true, marker);
  }
  for (const marker of ["CREATE TABLE IF NOT EXISTS users", "users_username_ci_unique", "owner_user_id uuid", "CREATE TABLE IF NOT EXISTS admin_sessions"]) {
    assert.equal(database.includes(marker), true, marker);
  }
  for (const marker of ["ADMIN_CONSOLE_PASSWORD_HASH_B64", "/api/dashboard", "/api/users", "/api/projects"]) {
    assert.equal(admin.includes(marker), true, marker);
  }
  for (const marker of ['changeMode("register")', "注册并进入", "账号数据彼此隔离"]) assert.equal(app.includes(marker), true, marker);
});

test("view rename, exact small column widths and table drag ordering are implemented", () => {
  const server = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  for (const marker of ["/tables/reorder", "Math.max(28", "Math.min(2400"]) assert.equal(server.includes(marker), true, marker);
  for (const marker of ["GripVertical", "onReorderTables", "gridWidth", 'window.prompt("重命名视图"']) assert.equal(app.includes(marker), true, marker);
  assert.equal(styles.includes(".data-grid { min-width: 0; width: max-content"), true);
  assert.equal(styles.includes(".table-nav-item .drag-handle"), true);
  assert.equal(styles.includes("@media (max-width: 760px)"), true);
});

test("hidden admin dialogs cannot intercept the login page", () => {
  const styles = fs.readFileSync(new URL("../admin/admin.css", import.meta.url), "utf8");
  assert.equal(styles.includes("[hidden] { display: none !important; }"), true);
});

test("lookup enhancement has stable IDs, dependencies, indexed batches and retries", () => {
  const database = fs.readFileSync(new URL("../server/db.mjs", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const lookup = fs.readFileSync(new URL("../server/lookup-service.mjs", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  for (const marker of [
    "CREATE TABLE IF NOT EXISTS record_relations",
    "record_relations_target_idx",
    "CREATE TABLE IF NOT EXISTS lookup_dependencies",
    "CREATE TABLE IF NOT EXISTS lookup_values",
    "CREATE TABLE IF NOT EXISTS lookup_jobs",
    "CREATE TABLE IF NOT EXISTS lookup_job_failures",
  ]) assert.equal(database.includes(marker), true, marker);
  for (const marker of [
    "syncRecordRelations",
    "markLookupsDirtyForSource",
    "markLookupsDirtyForTarget",
    "assertNoLookupCycle",
    "batch_size integer NOT NULL DEFAULT 1000",
    "retry_failed",
    "lookup_jobs_one_active_mode_idx",
    "ON CONFLICT(lookup_field_id,mode) WHERE status IN ('pending','computing') DO NOTHING",
  ]) assert.equal(`${database}\n${lookup}`.includes(marker), true, marker);
  for (const marker of [
    "/record-options",
    "/dependencies",
    "/recalculate",
    "FIELD_IMPACT_CONFIRMATION_REQUIRED",
    "confirmImpact=true",
    "LOOKUP_READ_ONLY",
  ]) assert.equal(`${server}\n${app}`.includes(marker), true, marker);
  for (const marker of [
    "目标数据表",
    "匹配字段",
    "返回字段",
    "去重拼接",
    "显示未匹配",
    "重新计算",
    "重试失败记录",
    "只读结果，请修改关联记录或来源数据",
  ]) assert.equal(app.includes(marker), true, marker);
});
