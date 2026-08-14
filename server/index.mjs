import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import compression from "compression";
import helmet from "helmet";
import multer from "multer";
import ExcelJS from "exceljs";
import bcrypt from "bcryptjs";
import { parse as parseCsv } from "csv-parse/sync";
import { initializeDatabase, pool, withTransaction, writeAudit } from "./db.mjs";
import {
  LOOKUP_RETURN_TYPES,
  assertNoLookupCycle,
  enqueueDirtyLookupJobs,
  enqueueLookupJob,
  fieldRuntimeMetadata,
  getFieldImpact,
  markLookupsDirtyForSource,
  markLookupsDirtyForTarget,
  removeLookupDependency,
  resolveRelationLabels,
  resolveStoredLookups,
  saveLookupDependency,
  startLookupWorker,
  syncRecordRelations,
  validateAggregation,
} from "./lookup-service.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "../dist");
const app = express();
const port = Number(process.env.PORT || 13280);
const sessionTtl = Number(process.env.SESSION_TTL_SECONDS || 43_200);
const loginAttempts = new Map();
const registrationAttempts = new Map();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "20mb" }));

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [decodeURIComponent(part.slice(0, index).trim()), decodeURIComponent(part.slice(index + 1).trim())];
  }));
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function httpError(status, message, code = "REQUEST_FAILED") {
  return Object.assign(new Error(message), { status, code });
}

async function requireAuth(req, _res, next) {
  try {
    const token = cookies(req).mb_session;
    if (!token) throw httpError(401, "请先登录", "AUTH_REQUIRED");
    const { rows } = await pool.query(
      `SELECT u.id,u.username,u.status FROM sessions s
       JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at > now() AND u.status='active'`,
      [hashToken(token)],
    );
    if (!rows.length) throw httpError(401, "登录状态已过期", "SESSION_EXPIRED");
    req.user = rows[0];
    next();
  } catch (error) {
    next(error);
  }
}

function normalizeUsername(value) {
  const username = String(value || "").trim();
  if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(username)) {
    throw httpError(400, "用户名需为 2-32 位文字、字母、数字、下划线或短横线", "USERNAME_INVALID");
  }
  return username;
}

function normalizePassword(value) {
  const password = String(value || "");
  if (password.length < 8 || password.length > 128) {
    throw httpError(400, "密码长度需为 8-128 位", "PASSWORD_INVALID");
  }
  return password;
}

async function issueSession(res, user) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query("DELETE FROM sessions WHERE expires_at <= now()");
  await pool.query(
    "INSERT INTO sessions(token_hash,user_id,username,expires_at) VALUES ($1,$2,$3,now()+($4 || ' seconds')::interval)",
    [hashToken(token), user.id, user.username, String(sessionTtl)],
  );
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `mb_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionTtl}${secure}`);
}

async function requireResourceAccess(req, _res, next) {
  try {
    const parts = req.path.split("/").filter(Boolean);
    let query;
    let id;
    if (parts[0] === "bases" && parts[1]) {
      id = parts[1];
      query = "SELECT b.id FROM bases b WHERE b.id=$1 AND b.owner_user_id=$2 AND b.deleted_at IS NULL";
    } else if (parts[0] === "tables" && parts[1]) {
      id = parts[1];
      query = `SELECT t.id FROM data_tables t JOIN bases b ON b.id=t.base_id
               WHERE t.id=$1 AND b.owner_user_id=$2 AND t.deleted_at IS NULL AND b.deleted_at IS NULL`;
    } else if (parts[0] === "views" && parts[1]) {
      id = parts[1];
      query = `SELECT v.id FROM views v JOIN data_tables t ON t.id=v.table_id JOIN bases b ON b.id=t.base_id
               WHERE v.id=$1 AND b.owner_user_id=$2 AND t.deleted_at IS NULL AND b.deleted_at IS NULL`;
    } else if (parts[0] === "fields" && parts[1]) {
      id = parts[1];
      query = `SELECT f.id FROM fields f JOIN data_tables t ON t.id=f.table_id JOIN bases b ON b.id=t.base_id
               WHERE f.id=$1 AND b.owner_user_id=$2 AND f.deleted_at IS NULL AND t.deleted_at IS NULL AND b.deleted_at IS NULL`;
    } else if (parts[0] === "records" && parts[1]) {
      id = parts[1];
      query = `SELECT r.id FROM records r JOIN data_tables t ON t.id=r.table_id JOIN bases b ON b.id=t.base_id
               WHERE r.id=$1 AND b.owner_user_id=$2 AND r.deleted_at IS NULL AND t.deleted_at IS NULL AND b.deleted_at IS NULL`;
    } else if (parts[0] === "recycle-bin" && parts[1] && parts[2]) {
      id = parts[2];
      if (parts[1] === "record") {
        query = `SELECT r.id FROM records r JOIN data_tables t ON t.id=r.table_id JOIN bases b ON b.id=t.base_id
                 WHERE r.id=$1 AND b.owner_user_id=$2 AND r.deleted_at IS NOT NULL`;
      } else if (parts[1] === "field") {
        query = `SELECT f.id FROM fields f JOIN data_tables t ON t.id=f.table_id JOIN bases b ON b.id=t.base_id
                 WHERE f.id=$1 AND b.owner_user_id=$2 AND f.deleted_at IS NOT NULL`;
      }
    }
    if (query && !(await pool.query(query, [id, req.user.id])).rows.length) {
      throw httpError(404, "资源不存在或无权访问", "RESOURCE_NOT_FOUND");
    }
    next();
  } catch (error) { next(error); }
}

function parseLimit(value, fallback = 100, max = 200) {
  const number = Number(value || fallback);
  return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback;
}

function readFilters(value) {
  if (!value) return [];
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw httpError(400, "筛选条件格式错误", "FILTERS_INVALID");
  }
  return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
}

function normalizeColumnWidths(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([fieldId, width]) => /^[0-9a-f-]{36}$/i.test(fieldId) && Number.isFinite(Number(width)))
    .map(([fieldId, width]) => [fieldId, Math.max(28, Math.min(2400, Math.round(Number(width))))]));
}

function appendRecordFilters(fields, filters, params, clauses) {
  const byId = new Map(fields.map((field) => [field.id, field]));
  for (const filter of filters) {
    const field = byId.get(String(filter.fieldId || ""));
    if (!field || filter.value === undefined || filter.value === null || filter.value === "") continue;
    params.push(field.id);
    const fieldParam = `$${params.length}`;
    if (["gt", "gte", "lt", "lte"].includes(filter.operator) && field.type === "number" && !Number.isFinite(Number(filter.value))) {
      throw httpError(400, `字段“${field.name}”的筛选值必须是数字`, "FILTER_VALUE_INVALID");
    }
    params.push(String(filter.value));
    const valueParam = `$${params.length}`;
    if (filter.operator === "contains" && field.type === "text") {
      clauses.push(`values->>${fieldParam} ILIKE '%' || ${valueParam} || '%'`);
    } else if (["gt", "gte", "lt", "lte"].includes(filter.operator) && field.type === "number") {
      const operator = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[filter.operator];
      clauses.push(`NULLIF(values->>${fieldParam},'')::numeric ${operator} ${valueParam}::numeric`);
    } else {
      clauses.push(`values->>${fieldParam} = ${valueParam}`);
    }
  }
}

function importId() {
  return `IMP-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

async function getFields(tableId, includeDeleted = false, client = pool) {
  const { rows } = await client.query(
    `SELECT id,name,type,config,position,created_at,updated_at,deleted_at
     FROM fields WHERE table_id=$1 ${includeDeleted ? "" : "AND deleted_at IS NULL"}
     ORDER BY position,id`,
    [tableId],
  );
  return rows;
}

async function normalizeFieldConfig(tableId, type, input, fieldId = null, client = pool) {
  const config = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (type === "relation") {
    const targetTableId = String(config.targetTableId || "");
    const matchFieldId = String(config.matchFieldId || "");
    const returnFieldId = String(config.returnFieldId || "");
    const target = (await client.query(
      `SELECT target.id FROM data_tables source
       JOIN data_tables target ON target.base_id=source.base_id
       WHERE source.id=$1 AND target.id=$2 AND source.deleted_at IS NULL AND target.deleted_at IS NULL`,
      [tableId, targetTableId],
    )).rows[0];
    if (!target) throw httpError(400, "目标数据表不存在或不属于当前项目", "RELATION_TARGET_TABLE_INVALID");
    const targetFields = (await client.query(
      `SELECT id,type FROM fields WHERE table_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL`,
      [targetTableId, [matchFieldId, returnFieldId]],
    )).rows;
    if (!targetFields.some((item) => item.id === matchFieldId)) {
      throw httpError(400, "请选择有效的匹配字段", "RELATION_MATCH_FIELD_INVALID");
    }
    if (!targetFields.some((item) => item.id === returnFieldId)) {
      throw httpError(400, "请选择有效的返回字段", "RELATION_RETURN_FIELD_INVALID");
    }
    return { targetTableId, matchFieldId, returnFieldId, multiple: config.multiple !== false };
  }
  if (type === "lookup") {
    const relationFieldId = String(config.relationFieldId || "");
    const targetFieldId = String(config.targetFieldId || "");
    const aggregation = String(config.aggregation || "first");
    const relation = (await client.query(
      "SELECT id,config FROM fields WHERE id=$1 AND table_id=$2 AND type='relation' AND deleted_at IS NULL",
      [relationFieldId, tableId],
    )).rows[0];
    if (!relation) throw httpError(400, "请先选择当前数据表中的关联字段", "LOOKUP_RELATION_INVALID");
    const targetTableId = relation.config?.targetTableId;
    const target = (await client.query(
      "SELECT id,type FROM fields WHERE id=$1 AND table_id=$2 AND deleted_at IS NULL",
      [targetFieldId, targetTableId],
    )).rows[0];
    if (!target || !LOOKUP_RETURN_TYPES.has(target.type)) {
      throw httpError(400, "返回字段只支持文本、数字、日期和单选", "LOOKUP_TARGET_FIELD_INVALID");
    }
    try {
      validateAggregation(target.type, aggregation);
      await assertNoLookupCycle(client, tableId, targetTableId, fieldId);
    } catch (error) {
      throw httpError(409, error.message, error.code || "LOOKUP_CONFIG_INVALID");
    }
    const emptyPolicy = ["empty", "default", "unmatched"].includes(config.emptyPolicy)
      ? config.emptyPolicy
      : "empty";
    return {
      relationFieldId,
      targetFieldId,
      targetTableId,
      returnType: target.type,
      aggregation,
      emptyPolicy,
      defaultValue: emptyPolicy === "default" ? config.defaultValue ?? "" : null,
      separator: String(config.separator || "、").slice(0, 8),
    };
  }
  if (type === "text") return { multiline: Boolean(config.multiline) };
  if (type === "number") return {
    decimals: Math.max(0, Math.min(8, Number(config.decimals ?? 2))),
    currency: config.currency === "CNY" ? "CNY" : null,
  };
  if (type === "date") return { includeTime: Boolean(config.includeTime) };
  if (type === "select") {
    const options = Array.isArray(config.options) ? config.options.slice(0, 500) : [];
    return { options: options.map((item) => ({ label: String(item?.label || item).trim() })).filter((item) => item.label) };
  }
  return {};
}

function normalizeValue(field, value) {
  if (value === null || value === undefined || value === "") return null;
  if (field.type === "text") return String(value);
  if (field.type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw httpError(400, `字段“${field.name}”必须是数字`, "FIELD_VALUE_INVALID");
    return number;
  }
  if (field.type === "date") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw httpError(400, `字段“${field.name}”日期格式无效`, "FIELD_VALUE_INVALID");
    return field.config?.includeTime ? date.toISOString() : String(value).slice(0, 10);
  }
  if (field.type === "select") {
    const options = (field.config?.options || []).map((item) => typeof item === "string" ? item : item.label);
    if (options.length && !options.includes(String(value))) throw httpError(400, `字段“${field.name}”选项无效`, "FIELD_VALUE_INVALID");
    return String(value);
  }
  if (field.type === "relation") {
    const ids = Array.isArray(value) ? value : String(value).split(/[,;，；]/).map((item) => item.trim()).filter(Boolean);
    if (!ids.every((id) => /^\d+$/.test(String(id)))) throw httpError(400, `字段“${field.name}”关联记录无效`, "FIELD_VALUE_INVALID");
    return ids.map(String);
  }
  return value;
}

async function validateValues(tableId, input, client = pool) {
  const fields = await getFields(tableId, false, client);
  const byId = new Map(fields.map((field) => [field.id, field]));
  const output = {};
  for (const [fieldId, value] of Object.entries(input || {})) {
    const field = byId.get(fieldId);
    if (!field) throw httpError(400, "包含不存在或已删除的字段", "FIELD_NOT_FOUND");
    if (field.type === "lookup") {
      throw httpError(400, `字段“${field.name}”是只读查找引用结果，不能直接修改`, "LOOKUP_READ_ONLY");
    }
    output[fieldId] = normalizeValue(field, value);
  }
  return output;
}

async function resolveLookups(tableId, records, fields) {
  await resolveRelationLabels(records, fields);
  await resolveStoredLookups(records, fields);
  return records;
}

app.get("/api/health", async (_req, res, next) => {
  try {
    const started = Date.now();
    const db = await pool.query("SELECT now() AS now");
    res.json({ ok: true, service: "multibase-v1", database: "connected", databaseTime: db.rows[0].now, latencyMs: Date.now() - started });
  } catch (error) { next(error); }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const ip = req.ip;
    const username = normalizeUsername(req.body?.username);
    const key = `${ip}:${username.toLocaleLowerCase()}`;
    const state = loginAttempts.get(key) || { count: 0, blockedUntil: 0 };
    if (state.blockedUntil > Date.now()) throw httpError(429, "登录失败次数过多，请稍后再试", "LOGIN_LOCKED");
    const user = (await pool.query("SELECT * FROM users WHERE lower(username)=lower($1)", [username])).rows[0];
    const valid = user?.status === "active" && await bcrypt.compare(String(req.body?.password || ""), user.password_hash);
    if (!valid) {
      state.count += 1;
      if (state.count >= 5) { state.blockedUntil = Date.now() + 15 * 60_000; state.count = 0; }
      loginAttempts.set(key, state);
      await writeAudit({ actor: username, action: "login_failed", objectType: "session", ip });
      throw httpError(401, "账号或密码不正确", "LOGIN_FAILED");
    }
    loginAttempts.delete(key);
    await issueSession(res, user);
    await pool.query("UPDATE users SET last_login_at=now(),updated_at=now() WHERE id=$1", [user.id]);
    await writeAudit({ actor: user.username, action: "login_success", objectType: "session", ip });
    res.json({ id: user.id, username: user.username });
  } catch (error) { next(error); }
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const ip = req.ip;
    const state = registrationAttempts.get(ip) || { count: 0, resetAt: Date.now() + 60 * 60_000 };
    if (state.resetAt <= Date.now()) { state.count = 0; state.resetAt = Date.now() + 60 * 60_000; }
    if (state.count >= 10) throw httpError(429, "注册请求过于频繁，请稍后再试", "REGISTER_LOCKED");
    state.count += 1;
    registrationAttempts.set(ip, state);
    const username = normalizeUsername(req.body?.username);
    const password = normalizePassword(req.body?.password);
    const passwordHash = await bcrypt.hash(password, 12);
    const user = (await pool.query(
      "INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id,username,status,created_at",
      [username, passwordHash],
    )).rows[0];
    await issueSession(res, user);
    await writeAudit({ actor: user.username, action: "register", objectType: "user", objectId: user.id, ip });
    res.status(201).json({ id: user.id, username: user.username });
  } catch (error) {
    if (error.code === "23505") next(httpError(409, "用户名已存在", "USERNAME_EXISTS"));
    else next(error);
  }
});

app.use("/api", requireAuth);
app.use("/api", requireResourceAccess);

app.get("/api/auth/me", (req, res) => res.json({ id: req.user.id, username: req.user.username }));
app.post("/api/auth/logout", async (req, res, next) => {
  try {
    const token = cookies(req).mb_session;
    if (token) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [hashToken(token)]);
    res.setHeader("Set-Cookie", "mb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get("/api/bases", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.id,b.name,b.description,b.created_at,b.updated_at,
        count(DISTINCT t.id)::int AS table_count,
        count(r.id)::bigint AS record_count
      FROM bases b
      LEFT JOIN data_tables t ON t.base_id=b.id AND t.deleted_at IS NULL
      LEFT JOIN records r ON r.table_id=t.id AND r.deleted_at IS NULL
      WHERE b.deleted_at IS NULL AND b.owner_user_id=$1 GROUP BY b.id ORDER BY b.updated_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (error) { next(error); }
});

app.post("/api/bases", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) throw httpError(400, "项目名称不能为空", "BASE_NAME_REQUIRED");
    const row = await withTransaction(async (client) => {
      const base = (await client.query("INSERT INTO bases(name,description,owner_user_id) VALUES($1,$2,$3) RETURNING *", [name, req.body?.description || "", req.user.id])).rows[0];
      const table = (await client.query("INSERT INTO data_tables(base_id,name) VALUES($1,'数据表 1') RETURNING *", [base.id])).rows[0];
      await client.query("INSERT INTO views(table_id,name) VALUES($1,'表格视图')", [table.id]);
      await client.query("INSERT INTO fields(table_id,name,type,position) VALUES($1,'名称','text',0)", [table.id]);
      await writeAudit({ actor: req.user.username, action: "create", objectType: "base", objectId: base.id, ip: req.ip }, client);
      return base;
    });
    res.status(201).json(row);
  } catch (error) { next(error); }
});

app.patch("/api/bases/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "UPDATE bases SET name=COALESCE($2,name),description=COALESCE($3,description),updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *",
      [req.params.id, req.body?.name || null, req.body?.description ?? null],
    );
    if (!rows.length) throw httpError(404, "项目不存在", "BASE_NOT_FOUND");
    await writeAudit({ actor: req.user.username, action: "update", objectType: "base", objectId: req.params.id, ip: req.ip });
    res.json(rows[0]);
  } catch (error) { next(error); }
});

app.get("/api/bases/:baseId/tables", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id,t.base_id,t.name,t.position,t.created_at,count(r.id)::bigint AS record_count
      FROM data_tables t LEFT JOIN records r ON r.table_id=t.id AND r.deleted_at IS NULL
      WHERE t.base_id=$1 AND t.deleted_at IS NULL GROUP BY t.id ORDER BY t.position,t.created_at`, [req.params.baseId]);
    res.json(rows);
  } catch (error) { next(error); }
});

app.post("/api/bases/:baseId/tables", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) throw httpError(400, "数据表名称不能为空", "TABLE_NAME_REQUIRED");
    const table = await withTransaction(async (client) => {
      const position = (await client.query("SELECT COALESCE(max(position),-1)+1 value FROM data_tables WHERE base_id=$1", [req.params.baseId])).rows[0].value;
      const row = (await client.query("INSERT INTO data_tables(base_id,name,position) VALUES($1,$2,$3) RETURNING *", [req.params.baseId,name,position])).rows[0];
      await client.query("INSERT INTO views(table_id,name) VALUES($1,'表格视图')", [row.id]);
      await client.query("INSERT INTO fields(table_id,name,type,position) VALUES($1,'名称','text',0)", [row.id]);
      await writeAudit({ actor: req.user.username, action: "create", objectType: "table", objectId: row.id, ip: req.ip }, client);
      return row;
    });
    res.status(201).json(table);
  } catch (error) { next(error); }
});

app.patch("/api/bases/:baseId/tables/reorder", async (req, res, next) => {
  try {
    const tableIds = Array.isArray(req.body?.tableIds) ? req.body.tableIds.map(String) : [];
    const current = (await pool.query(
      "SELECT id FROM data_tables WHERE base_id=$1 AND deleted_at IS NULL ORDER BY position,created_at",
      [req.params.baseId],
    )).rows.map((row) => row.id);
    if (tableIds.length !== current.length || new Set(tableIds).size !== current.length || current.some((id) => !tableIds.includes(id))) {
      throw httpError(400, "数据表排序列表不完整", "TABLE_ORDER_INVALID");
    }
    await withTransaction(async (client) => {
      for (const [position, tableId] of tableIds.entries()) {
        await client.query("UPDATE data_tables SET position=$2,updated_at=now() WHERE id=$1", [tableId, position]);
      }
      await writeAudit({ actor: req.user.username, action: "reorder", objectType: "table", objectId: req.params.baseId, details: { tableIds }, ip: req.ip }, client);
    });
    res.json({ tableIds });
  } catch (error) { next(error); }
});

app.patch("/api/tables/:tableId", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) throw httpError(400, "数据表名称不能为空", "TABLE_NAME_REQUIRED");
    const { rows } = await pool.query(
      "UPDATE data_tables SET name=$2,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *",
      [req.params.tableId, name],
    );
    if (!rows.length) throw httpError(404, "数据表不存在", "TABLE_NOT_FOUND");
    await writeAudit({ actor: req.user.username, action: "rename", objectType: "table", objectId: req.params.tableId, details: { name }, ip: req.ip });
    res.json(rows[0]);
  } catch (error) { next(error); }
});

app.get("/api/tables/:tableId/schema", async (req, res, next) => {
  try {
    const table = (await pool.query(`SELECT t.*,b.name base_name FROM data_tables t JOIN bases b ON b.id=t.base_id WHERE t.id=$1 AND t.deleted_at IS NULL`, [req.params.tableId])).rows[0];
    if (!table) throw httpError(404, "数据表不存在", "TABLE_NOT_FOUND");
    const fields = await getFields(req.params.tableId);
    const runtime = await fieldRuntimeMetadata(req.params.tableId);
    for (const field of fields) {
      field.dependency = runtime.dependencies.get(field.id) || null;
      field.calculation = runtime.jobs.get(field.id) || null;
    }
    const views = (await pool.query("SELECT * FROM views WHERE table_id=$1 ORDER BY created_at", [req.params.tableId])).rows;
    res.json({ table, fields, views });
  } catch (error) { next(error); }
});

app.get("/api/tables/:tableId/record-options", async (req, res, next) => {
  try {
    const matchFieldId = String(req.query.matchFieldId || "");
    const returnFieldId = String(req.query.returnFieldId || matchFieldId);
    const fields = await getFields(req.params.tableId);
    if (!fields.some((field) => field.id === matchFieldId) || !fields.some((field) => field.id === returnFieldId)) {
      throw httpError(400, "匹配字段或返回字段无效", "RELATION_OPTION_FIELDS_INVALID");
    }
    const search = String(req.query.search || "").trim().slice(0, 100);
    const params = [req.params.tableId, matchFieldId, returnFieldId];
    let clause = "";
    if (search) {
      params.push(search);
      clause = "AND COALESCE(values->>$2,'') ILIKE '%' || $4 || '%'";
    }
    const { rows } = await pool.query(
      `SELECT id,values->>$2 match_value,values->>$3 return_value
       FROM records WHERE table_id=$1 AND deleted_at IS NULL ${clause}
       ORDER BY id DESC LIMIT 50`,
      params,
    );
    res.json(rows.map((row) => ({
      id: String(row.id),
      matchValue: row.match_value ?? `记录 #${row.id}`,
      label: row.return_value ?? row.match_value ?? `记录 #${row.id}`,
    })));
  } catch (error) { next(error); }
});

app.post("/api/tables/:tableId/views", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) throw httpError(400, "视图名称不能为空", "VIEW_NAME_REQUIRED");
    const config = {
      filters: readFilters(req.body?.config?.filters),
      columnWidths: normalizeColumnWidths(req.body?.config?.columnWidths),
    };
    const { rows } = await pool.query(
      "INSERT INTO views(table_id,name,config) VALUES($1,$2,$3::jsonb) RETURNING *",
      [req.params.tableId, name, JSON.stringify(config)],
    );
    await writeAudit({ actor: req.user.username, action: "create", objectType: "view", objectId: rows[0].id, details: { tableId: req.params.tableId }, ip: req.ip });
    res.status(201).json(rows[0]);
  } catch (error) { next(error); }
});

app.patch("/api/views/:viewId", async (req, res, next) => {
  try {
    const name = req.body?.name === undefined ? null : String(req.body.name).trim();
    if (req.body?.name !== undefined && !name) throw httpError(400, "视图名称不能为空", "VIEW_NAME_REQUIRED");
    const config = req.body?.config === undefined ? null : JSON.stringify({
      filters: readFilters(req.body.config?.filters),
      columnWidths: normalizeColumnWidths(req.body.config?.columnWidths),
    });
    const { rows } = await pool.query(
      "UPDATE views SET name=COALESCE($2,name),config=COALESCE($3::jsonb,config),updated_at=now() WHERE id=$1 RETURNING *",
      [req.params.viewId, name, config],
    );
    if (!rows.length) throw httpError(404, "视图不存在", "VIEW_NOT_FOUND");
    await writeAudit({ actor: req.user.username, action: "update", objectType: "view", objectId: req.params.viewId, ip: req.ip });
    res.json(rows[0]);
  } catch (error) { next(error); }
});

app.delete("/api/views/:viewId", async (req, res, next) => {
  try {
    const view = (await pool.query("SELECT table_id FROM views WHERE id=$1", [req.params.viewId])).rows[0];
    if (!view) throw httpError(404, "视图不存在", "VIEW_NOT_FOUND");
    const count = Number((await pool.query("SELECT count(*) value FROM views WHERE table_id=$1", [view.table_id])).rows[0].value);
    if (count <= 1) throw httpError(409, "每张数据表至少保留一个视图", "LAST_VIEW_REQUIRED");
    await pool.query("DELETE FROM views WHERE id=$1", [req.params.viewId]);
    await writeAudit({ actor: req.user.username, action: "delete", objectType: "view", objectId: req.params.viewId, ip: req.ip });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.post("/api/tables/:tableId/fields", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    const type = String(req.body?.type || "");
    if (!name || !["text","number","date","select","relation","lookup"].includes(type)) throw httpError(400, "字段名称或类型无效", "FIELD_INVALID");
    const row = await withTransaction(async (client) => {
      const config = await normalizeFieldConfig(req.params.tableId, type, req.body?.config, null, client);
      const position = (await client.query("SELECT COALESCE(max(position),-1)+1 value FROM fields WHERE table_id=$1", [req.params.tableId])).rows[0].value;
      const field = (await client.query(
        "INSERT INTO fields(table_id,name,type,config,position) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *",
        [req.params.tableId,name,type,JSON.stringify(config),position],
      )).rows[0];
      if (type === "lookup") await saveLookupDependency(client, field);
      await writeAudit({ actor: req.user.username, action: "create", objectType: "field", objectId: field.id, details: { type }, ip: req.ip }, client);
      return field;
    });
    if (type === "lookup") row.calculation = await enqueueLookupJob({ lookupFieldId: row.id, mode: "full", user: req.user });
    res.status(201).json(row);
  } catch (error) { next(error); }
});

app.patch("/api/fields/:fieldId", async (req, res, next) => {
  try {
    const current = (await pool.query("SELECT * FROM fields WHERE id=$1 AND deleted_at IS NULL", [req.params.fieldId])).rows[0];
    if (!current) throw httpError(404, "字段不存在", "FIELD_NOT_FOUND");
    const type = req.body?.type === undefined ? current.type : String(req.body.type);
    if (!["text","number","date","select","relation","lookup"].includes(type)) throw httpError(400, "字段类型无效", "FIELD_TYPE_INVALID");
    if (type !== current.type && ["relation", "lookup"].includes(current.type)) {
      throw httpError(409, "关联记录和查找引用字段不能直接修改为其他类型，请新建字段后迁移", "RELATIONAL_TYPE_LOCKED");
    }
    const impact = await getFieldImpact(req.params.fieldId);
    if (type !== current.type && impact.affectedFields && req.body?.confirmImpact !== true) {
      throw Object.assign(
        httpError(409, "修改字段类型会影响现有查找引用，请确认影响范围", "FIELD_IMPACT_CONFIRMATION_REQUIRED"),
        { details: impact },
      );
    }
    if (type !== current.type && impact.affectedFields) {
      const dependents = await pool.query(
        `SELECT f.name,f.config FROM lookup_dependencies d JOIN fields f ON f.id=d.lookup_field_id
         WHERE d.target_field_id=$1 AND f.deleted_at IS NULL`,
        [req.params.fieldId],
      );
      for (const dependent of dependents.rows) {
        try { validateAggregation(type, dependent.config?.aggregation || "first"); }
        catch { throw httpError(409, `字段“${dependent.name}”的汇总方式与新类型不兼容，请先调整查找引用`, "LOOKUP_AGGREGATION_INCOMPATIBLE"); }
      }
    }
    const row = await withTransaction(async (client) => {
      const configInput = req.body?.config === undefined ? current.config : req.body.config;
      const config = await normalizeFieldConfig(current.table_id, type, configInput, current.id, client);
      const updated = (await client.query(
        "UPDATE fields SET name=COALESCE($2,name),type=$3,config=$4::jsonb,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *",
        [req.params.fieldId, req.body?.name || null, type, JSON.stringify(config)],
      )).rows[0];
      if (type === "lookup") await saveLookupDependency(client, updated);
      else await removeLookupDependency(client, updated.id);
      await writeAudit({ actor: req.user.username, action: "update", objectType: "field", objectId: req.params.fieldId, details: { previousType: current.type, type }, ip: req.ip }, client);
      return updated;
    });
    if (type === "lookup") row.calculation = await enqueueLookupJob({ lookupFieldId: row.id, mode: "full", user: req.user });
    if (type !== current.type && impact.affectedFields) {
      for (const dependent of impact.dependents) {
        await enqueueLookupJob({ lookupFieldId: dependent.lookup_field_id, mode: "full", user: req.user });
      }
    }
    res.json(row);
  } catch (error) { next(error); }
});

app.get("/api/fields/:fieldId/impact", async (req, res, next) => {
  try { res.json(await getFieldImpact(req.params.fieldId)); }
  catch (error) { next(error); }
});

app.get("/api/fields/:fieldId/dependencies", async (req, res, next) => {
  try {
    const field = (await pool.query("SELECT table_id,type FROM fields WHERE id=$1 AND deleted_at IS NULL", [req.params.fieldId])).rows[0];
    if (!field) throw httpError(404, "字段不存在", "FIELD_NOT_FOUND");
    const runtime = await fieldRuntimeMetadata(field.table_id);
    const failures = await pool.query(
      `SELECT source_record_id,error_code,error_message,created_at FROM lookup_job_failures
       WHERE lookup_field_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.fieldId],
    );
    res.json({ dependency: runtime.dependencies.get(req.params.fieldId) || null, calculation: runtime.jobs.get(req.params.fieldId) || null, failures: failures.rows });
  } catch (error) { next(error); }
});

app.post("/api/fields/:fieldId/recalculate", async (req, res, next) => {
  try {
    const field = (await pool.query("SELECT type FROM fields WHERE id=$1 AND deleted_at IS NULL", [req.params.fieldId])).rows[0];
    if (!field) throw httpError(404, "字段不存在", "FIELD_NOT_FOUND");
    if (field.type !== "lookup") throw httpError(400, "只有查找引用字段可以重新计算", "FIELD_NOT_LOOKUP");
    const mode = req.body?.retryFailed ? "retry_failed" : "full";
    const job = await enqueueLookupJob({ lookupFieldId: req.params.fieldId, mode, user: req.user });
    res.status(202).json(job);
  } catch (error) { next(error); }
});

app.delete("/api/fields/:fieldId", async (req, res, next) => {
  try {
    const impact = await getFieldImpact(req.params.fieldId);
    if (impact.affectedFields && req.query.confirmImpact !== "true") {
      throw Object.assign(
        httpError(409, "删除字段会导致现有查找引用失效，请确认影响范围", "FIELD_IMPACT_CONFIRMATION_REQUIRED"),
        { details: impact },
      );
    }
    const { rows } = await pool.query("UPDATE fields SET deleted_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *", [req.params.fieldId]);
    if (!rows.length) throw httpError(404, "字段不存在", "FIELD_NOT_FOUND");
    if (rows[0].type === "lookup") await removeLookupDependency(pool, rows[0].id);
    if (impact.affectedFields) {
      await pool.query(
        `UPDATE lookup_values SET status='failed',value=NULL,error_code='LOOKUP_DEPENDENCY_DELETED',
         error_message='目标字段或关联字段已删除',updated_at=now()
         WHERE lookup_field_id=ANY($1::uuid[])`,
        [impact.dependents.map((item) => item.lookup_field_id)],
      );
    }
    await writeAudit({ actor: req.user.username, action: "delete", objectType: "field", objectId: req.params.fieldId, ip: req.ip });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get("/api/tables/:tableId/records", async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit);
    const after = /^\d+$/.test(String(req.query.after || "")) ? String(req.query.after) : "0";
    const fields = await getFields(req.params.tableId);
    const filters = readFilters(req.query.filters);
    const filterParams = [req.params.tableId];
    const filterClauses = ["table_id=$1", "deleted_at IS NULL"];
    appendRecordFilters(fields, filters, filterParams, filterClauses);
    const params = [...filterParams, after, limit + 1];
    const afterParam = `$${filterParams.length + 1}`;
    const limitParam = `$${filterParams.length + 2}`;
    const { rows } = await pool.query(
      `SELECT id,values,version,created_at,updated_at FROM records WHERE ${filterClauses.join(" AND ")} AND id>${afterParam} ORDER BY id LIMIT ${limitParam}`,
      params,
    );
    const hasMore = rows.length > limit;
    const records = await resolveLookups(req.params.tableId, rows.slice(0, limit), fields);
    const count = (await pool.query(`SELECT count(*)::bigint total FROM records WHERE ${filterClauses.join(" AND ")}`, filterParams)).rows[0].total;
    res.json({ records, fields, total: count, hasMore, nextAfter: records.length ? String(records.at(-1).id) : null });
  } catch (error) { next(error); }
});

app.post("/api/tables/:tableId/records", async (req, res, next) => {
  try {
    const row = await withTransaction(async (client) => {
      const fields = await getFields(req.params.tableId, false, client);
      const values = await validateValues(req.params.tableId, req.body?.values || {}, client);
      const record = (await client.query("INSERT INTO records(table_id,values) VALUES($1,$2::jsonb) RETURNING *", [req.params.tableId,JSON.stringify(values)])).rows[0];
      await syncRecordRelations(client, { recordId: record.id, tableId: req.params.tableId, values, fields });
      const dirty = await markLookupsDirtyForSource(client, req.params.tableId, [record.id], "source_created");
      await enqueueDirtyLookupJobs(client, dirty, req.user);
      await writeAudit({ actor: req.user.username, action: "create", objectType: "record", objectId: record.id, details: { tableId: req.params.tableId }, ip: req.ip }, client);
      return record;
    });
    res.status(201).json(row);
  } catch (error) { next(error); }
});

app.post("/api/tables/:tableId/records/bulk", async (req, res, next) => {
  try {
    const input = Array.isArray(req.body?.records) ? req.body.records : [];
    if (!input.length || input.length > 5000) throw httpError(400, "每批必须包含 1–5000 条记录", "BULK_SIZE_INVALID");
    const result = await withTransaction(async (client) => {
      const fields = await getFields(req.params.tableId, false, client);
      const normalized = [];
      for (const item of input) normalized.push(await validateValues(req.params.tableId, item.values || item, client));
      const values = normalized.map((_, index) => `($1,$${index + 2}::jsonb)`).join(",");
      const rows = (await client.query(`INSERT INTO records(table_id,values) VALUES ${values} RETURNING id`, [req.params.tableId,...normalized.map(JSON.stringify)])).rows;
      for (const [index, row] of rows.entries()) {
        await syncRecordRelations(client, { recordId: row.id, tableId: req.params.tableId, values: normalized[index], fields });
      }
      const dirty = await markLookupsDirtyForSource(client, req.params.tableId, rows.map((row) => row.id), "source_bulk_created");
      await enqueueDirtyLookupJobs(client, dirty, req.user);
      await writeAudit({ actor: req.user.username, action: "bulk_create", objectType: "record", details: { tableId: req.params.tableId, count: rows.length }, ip: req.ip }, client);
      return rows;
    });
    res.status(201).json({ inserted: result.length, firstId: result[0].id, lastId: result.at(-1).id });
  } catch (error) { next(error); }
});

app.patch("/api/records/:recordId", async (req, res, next) => {
  try {
    const row = await withTransaction(async (client) => {
      const current = (await client.query("SELECT * FROM records WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [req.params.recordId])).rows[0];
      if (!current) throw httpError(404, "记录不存在", "RECORD_NOT_FOUND");
      const fields = await getFields(current.table_id, false, client);
      const patch = await validateValues(current.table_id, req.body?.values || {}, client);
      const expectedVersion = Number(req.body?.version || current.version);
      const rows = (await client.query(
        "UPDATE records SET values=values || $2::jsonb,version=version+1,updated_at=now() WHERE id=$1 AND version=$3 AND deleted_at IS NULL RETURNING *",
        [req.params.recordId,JSON.stringify(patch),expectedVersion],
      )).rows;
      if (!rows.length) throw httpError(409, "记录已被其他操作修改，请刷新后重试", "VERSION_CONFLICT");
      await syncRecordRelations(client, { recordId: current.id, tableId: current.table_id, values: patch, fields });
      const sourceDirty = await markLookupsDirtyForSource(client, current.table_id, [current.id], "source_changed");
      const targetDirty = await markLookupsDirtyForTarget(client, current.table_id, [current.id], "target_changed");
      await enqueueDirtyLookupJobs(client, [...new Set([...sourceDirty, ...targetDirty])], req.user);
      await writeAudit({ actor: req.user.username, action: "update", objectType: "record", objectId: req.params.recordId, ip: req.ip }, client);
      return rows[0];
    });
    res.json(row);
  } catch (error) { next(error); }
});

app.delete("/api/records/:recordId", async (req, res, next) => {
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query("UPDATE records SET deleted_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id,table_id", [req.params.recordId]);
      if (!rows.length) throw httpError(404, "记录不存在", "RECORD_NOT_FOUND");
      const dirty = await markLookupsDirtyForTarget(client, rows[0].table_id, [rows[0].id], "target_deleted");
      await enqueueDirtyLookupJobs(client, dirty, req.user);
      await writeAudit({ actor: req.user.username, action: "delete", objectType: "record", objectId: req.params.recordId, details: { tableId: rows[0].table_id }, ip: req.ip }, client);
    });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get("/api/bases/:baseId/imports", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT j.*,t.name table_name FROM import_jobs j JOIN data_tables t ON t.id=j.table_id WHERE t.base_id=$1 ORDER BY j.created_at DESC LIMIT 100`, [req.params.baseId]);
    res.json(rows);
  } catch (error) { next(error); }
});

async function ensureImportTemplate(tableId) {
  const existing = (await pool.query(
    `SELECT p.*,t.name table_name FROM import_templates p JOIN data_tables t ON t.id=p.table_id
     WHERE p.table_id=$1 AND t.deleted_at IS NULL`,
    [tableId],
  )).rows[0];
  if (existing) return existing;
  const table = (await pool.query("SELECT name FROM data_tables WHERE id=$1 AND deleted_at IS NULL", [tableId])).rows[0];
  if (!table) throw httpError(404, "数据表不存在", "TABLE_NOT_FOUND");
  return (await pool.query(
    `INSERT INTO import_templates(table_id,import_id) VALUES($1,$2)
     ON CONFLICT(table_id) DO UPDATE SET updated_at=import_templates.updated_at
     RETURNING *, $3::text table_name`,
    [tableId, importId(), table.name],
  )).rows[0];
}

app.get("/api/tables/:tableId/import-template", async (req, res, next) => {
  try {
    const template = await ensureImportTemplate(req.params.tableId);
    const fields = await getFields(req.params.tableId);
    res.json({
      importId: template.import_id,
      tableId: template.table_id,
      tableName: template.table_name,
      fieldCount: fields.filter((field) => field.type !== "lookup").length,
      downloadUrl: `/api/tables/${req.params.tableId}/import-template.xlsx`,
    });
  } catch (error) { next(error); }
});

app.get("/api/tables/:tableId/import-template.xlsx", async (req, res, next) => {
  try {
    const template = await ensureImportTemplate(req.params.tableId);
    const fields = (await getFields(req.params.tableId)).filter((field) => field.type !== "lookup");
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "多维数据库";
    workbook.created = new Date();
    const guide = workbook.addWorksheet("导入说明", { properties: { tabColor: { argb: "FF167D6B" } } });
    guide.columns = [{ width: 22 }, { width: 60 }];
    guide.addRows([
      ["专属导入 ID", template.import_id],
      ["目标数据表", template.table_name],
      ["使用说明", "请在“数据导入”工作表第 2 行开始填写数据，不要修改首行字段名称。"],
      ["注意", "本模板只适用于当前数据表，系统将使用隐藏字段 ID 精确匹配列。"],
    ]);
    guide.getRow(1).font = { bold: true, color: { argb: "FF167D6B" } };
    const data = workbook.addWorksheet("数据导入", { views: [{ state: "frozen", ySplit: 1 }] });
    data.columns = fields.map((field) => ({ header: field.name, key: field.id, width: Math.max(16, Math.min(32, field.name.length * 2 + 8)) }));
    data.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    data.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF167D6B" } };
    data.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(fields.length, 1) } };
    fields.forEach((field, index) => {
      if (field.type === "select" && field.config?.options?.length) {
        const values = field.config.options.map((option) => option.label || option).join(",").replaceAll('"', '""');
        for (let row = 2; row <= 500; row += 1) data.getCell(row, index + 1).dataValidation = { type: "list", allowBlank: true, formulae: [`"${values}"`] };
      }
    });
    const meta = workbook.addWorksheet("_multibase_meta");
    meta.state = "veryHidden";
    meta.addRow(["importId", template.import_id]);
    meta.addRow(["tableId", template.table_id]);
    meta.addRow(["fieldName", "fieldId", "fieldType"]);
    fields.forEach((field) => meta.addRow([field.name, field.id, field.type]));
    const filename = `${template.table_name}-导入模板-${template.import_id}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) { next(error); }
});

app.post("/api/tables/:tableId/import", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw httpError(400, "请选择文件", "FILE_REQUIRED");
    const parsed = await parseImportBuffer(req.file);
    const sourceRows = parsed.rows;
    if (!sourceRows.length) throw httpError(400, "文件中没有可导入的数据", "IMPORT_EMPTY");
    if (sourceRows.length > 50_000) throw httpError(400, "网页直接导入单次最多 5 万行；更大文件请使用分批导入", "IMPORT_TOO_LARGE");
    const fields = await getFields(req.params.tableId);
    const byName = new Map(fields.filter((field) => field.type !== "lookup").map((field) => [field.name, field]));
    const byId = new Map(fields.filter((field) => field.type !== "lookup").map((field) => [field.id, field]));
    if (parsed.importId) {
      const validTemplate = (await pool.query("SELECT 1 FROM import_templates WHERE table_id=$1 AND import_id=$2", [req.params.tableId, parsed.importId])).rowCount;
      if (!validTemplate || parsed.tableId !== req.params.tableId) throw httpError(400, "导入模板不属于当前数据表，请重新下载模板", "IMPORT_TEMPLATE_MISMATCH");
    }
    const job = (await pool.query("INSERT INTO import_jobs(table_id,filename,status,total_rows) VALUES($1,$2,'validating',$3) RETURNING *", [req.params.tableId,req.file.originalname,sourceRows.length])).rows[0];
    let success = 0; const errors = [];
    await withTransaction(async (client) => {
      const insertedIds = [];
      for (let offset = 0; offset < sourceRows.length; offset += 500) {
        const batch = [];
        for (let index = offset; index < Math.min(offset + 500, sourceRows.length); index += 1) {
          try {
            const raw = sourceRows[index]; const values = {};
            for (const [key, value] of Object.entries(raw)) {
              const field = parsed.importId ? byId.get(key) : byName.get(key);
              if (field) values[field.id] = normalizeValue(field, value);
            }
            batch.push(values);
          } catch (error) { errors.push({ row: index + 2, message: error.message }); }
        }
        if (batch.length) {
          const placeholders = batch.map((_, index) => `($1,$${index + 2}::jsonb)`).join(",");
          const inserted = (await client.query(
            `INSERT INTO records(table_id,values) VALUES ${placeholders} RETURNING id`,
            [req.params.tableId,...batch.map(JSON.stringify)],
          )).rows;
          for (const [index, row] of inserted.entries()) {
            await syncRecordRelations(client, { recordId: row.id, tableId: req.params.tableId, values: batch[index], fields });
            insertedIds.push(row.id);
          }
          success += batch.length;
        }
      }
      const dirty = await markLookupsDirtyForSource(client, req.params.tableId, insertedIds, "source_imported");
      await enqueueDirtyLookupJobs(client, dirty, req.user);
      await client.query("UPDATE import_jobs SET status=$2,success_rows=$3,error_rows=$4,details=$5::jsonb,completed_at=now() WHERE id=$1", [job.id, errors.length ? "completed_with_errors" : "completed", success, errors.length, JSON.stringify({ errors: errors.slice(0,200) })]);
      await writeAudit({ actor: req.user.username, action: "import", objectType: "import_job", objectId: job.id, details: { total: sourceRows.length, success, errors: errors.length, importId: parsed.importId || null }, ip: req.ip }, client);
    });
    res.status(201).json({ id: job.id, totalRows: sourceRows.length, successRows: success, errorRows: errors.length, errors: errors.slice(0,20) });
  } catch (error) { next(error); }
});

function csvCell(value) {
  const text = value === null || value === undefined ? "" : Array.isArray(value) ? value.join(";") : String(value);
  return `"${text.replaceAll('"','""')}"`;
}

function excelCellValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("result" in value) return excelCellValue(value.result);
    if ("text" in value) return value.text;
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
  }
  return value;
}

async function parseImportBuffer(file) {
  const lower = file.originalname.toLowerCase();
  if (lower.endsWith(".csv")) {
    return { rows: parseCsv(file.buffer, { bom: true, columns: true, skip_empty_lines: true, relax_column_count: true }), importId: null, tableId: null };
  }
  if (!lower.endsWith(".xlsx")) throw httpError(400, "仅支持 .xlsx 和 .csv 文件", "IMPORT_TYPE_INVALID");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  const meta = workbook.getWorksheet("_multibase_meta");
  const sheet = workbook.getWorksheet("数据导入") || workbook.worksheets.find((item) => item.name !== "_multibase_meta" && item.name !== "导入说明");
  if (!sheet) return { rows: [], importId: null, tableId: null };
  const importId = meta ? String(excelCellValue(meta.getCell("B1").value) || "") : null;
  const tableId = meta ? String(excelCellValue(meta.getCell("B2").value) || "") : null;
  const fieldIds = new Map();
  if (meta) {
    for (let row = 4; row <= meta.rowCount; row += 1) {
      const name = String(excelCellValue(meta.getCell(row, 1).value) || "").trim();
      const id = String(excelCellValue(meta.getCell(row, 2).value) || "").trim();
      if (name && id) fieldIds.set(name, id);
    }
  }
  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, column) => {
    headers[column - 1] = String(excelCellValue(cell.value) ?? "").trim();
  });
  const rows = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber); const output = {}; let hasValue = false;
    headers.forEach((header, index) => {
      if (!header) return;
      const value = excelCellValue(row.getCell(index + 1).value);
      output[fieldIds.get(header) || header] = value;
      if (value !== null && value !== "") hasValue = true;
    });
    if (hasValue) rows.push(output);
  }
  return { rows, importId: importId || null, tableId: tableId || null };
}

app.post("/api/tables/:tableId/export-estimate", async (req, res, next) => {
  try {
    const fields = await getFields(req.params.tableId);
    const params = [req.params.tableId];
    const clauses = ["table_id=$1", "deleted_at IS NULL"];
    const filters = readFilters(req.body?.filters);
    appendRecordFilters(fields, filters, params, clauses);
    const total = (await pool.query(`SELECT count(*)::bigint total FROM records WHERE ${clauses.join(" AND ")}`, params)).rows[0].total;
    const sample = (await pool.query(
      `SELECT COALESCE(avg(octet_length(values::text)),0)::numeric average_bytes FROM
       (SELECT values FROM records WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT 1000) sample`,
      params,
    )).rows[0].average_bytes;
    const headerBytes = Buffer.byteLength(fields.map((field) => field.name).join(",") + "\n", "utf8");
    const estimatedBytes = Math.ceil(headerBytes + Number(total) * (Number(sample) + fields.length * 3 + 2));
    res.json({ tableId: req.params.tableId, totalRows: total, estimatedBytes, filters });
  } catch (error) { next(error); }
});

app.get("/api/tables/:tableId/export.csv", async (req, res, next) => {
  try {
    const fields = await getFields(req.params.tableId);
    const table = (await pool.query("SELECT name FROM data_tables WHERE id=$1", [req.params.tableId])).rows[0];
    if (!table) throw httpError(404, "数据表不存在", "TABLE_NOT_FOUND");
    const filters = readFilters(req.query.filters);
    const filterParams = [req.params.tableId];
    const filterClauses = ["table_id=$1", "deleted_at IS NULL"];
    appendRecordFilters(fields, filters, filterParams, filterClauses);
    const total = (await pool.query(`SELECT count(*)::bigint total FROM records WHERE ${filterClauses.join(" AND ")}`, filterParams)).rows[0].total;
    const filename = `${table.name}-${new Date().toISOString().slice(0,10)}.csv`;
    await pool.query("INSERT INTO export_jobs(table_id,filename,total_rows) VALUES($1,$2,$3)", [req.params.tableId,filename,total]);
    await writeAudit({ actor: req.user.username, action: "export", objectType: "table", objectId: req.params.tableId, details: { total }, ip: req.ip });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.write("\uFEFF" + fields.map((field) => csvCell(field.name)).join(",") + "\n");
    let after = "0";
    while (true) {
      const params = [...filterParams, after];
      const { rows } = await pool.query(
        `SELECT id,values FROM records WHERE ${filterClauses.join(" AND ")} AND id>$${params.length} ORDER BY id LIMIT 2000`,
        params,
      );
      if (!rows.length) break;
      for (const row of rows) res.write(fields.map((field) => csvCell(row.values?.[field.id])).join(",") + "\n");
      after = String(rows.at(-1).id);
      if (rows.length < 2000) break;
    }
    res.end();
  } catch (error) { next(error); }
});

app.get("/api/bases/:baseId/exports", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT j.*,t.name table_name FROM export_jobs j JOIN data_tables t ON t.id=j.table_id WHERE t.base_id=$1 ORDER BY j.created_at DESC LIMIT 100`, [req.params.baseId]);
    res.json(rows);
  } catch (error) { next(error); }
});

app.get("/api/bases/:baseId/recycle-bin", async (req, res, next) => {
  try {
    const fields = await pool.query(`SELECT f.id,'field' type,f.name,t.name table_name,f.deleted_at FROM fields f JOIN data_tables t ON t.id=f.table_id WHERE t.base_id=$1 AND f.deleted_at IS NOT NULL ORDER BY f.deleted_at DESC LIMIT 100`, [req.params.baseId]);
    const records = await pool.query(`SELECT r.id,'record' type,COALESCE(r.values::text,'记录 #'||r.id) name,t.name table_name,r.deleted_at FROM records r JOIN data_tables t ON t.id=r.table_id WHERE t.base_id=$1 AND r.deleted_at IS NOT NULL ORDER BY r.deleted_at DESC LIMIT 100`, [req.params.baseId]);
    res.json([...fields.rows,...records.rows].sort((a,b) => new Date(b.deleted_at)-new Date(a.deleted_at)).slice(0,100));
  } catch (error) { next(error); }
});

app.post("/api/recycle-bin/:type/:id/restore", async (req, res, next) => {
  try {
    const table = req.params.type === "field" ? "fields" : req.params.type === "record" ? "records" : null;
    if (!table) throw httpError(400, "回收站类型无效", "RECYCLE_TYPE_INVALID");
    const row = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE ${table} SET deleted_at=NULL,updated_at=now() WHERE id=$1 AND deleted_at IS NOT NULL RETURNING *`,
        [req.params.id],
      );
      if (!rows.length) throw httpError(404, "回收站项目不存在", "RECYCLE_NOT_FOUND");
      if (req.params.type === "record") {
        const sourceDirty = await markLookupsDirtyForSource(client, rows[0].table_id, [rows[0].id], "source_restored");
        const targetDirty = await markLookupsDirtyForTarget(client, rows[0].table_id, [rows[0].id], "target_restored");
        await enqueueDirtyLookupJobs(client, [...new Set([...sourceDirty, ...targetDirty])], req.user);
      }
      await writeAudit({ actor: req.user.username, action: "restore", objectType: req.params.type, objectId: req.params.id, ip: req.ip }, client);
      return rows[0];
    });
    res.json(row);
  } catch (error) { next(error); }
});

app.get("/api/bases/:baseId/audit", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM audit_logs WHERE actor=$1 ORDER BY created_at DESC LIMIT 200", [req.user.username]);
    res.json(rows);
  } catch (error) { next(error); }
});

app.get("/api/system/status", async (req, res, next) => {
  try {
    const [size, counts, active] = await Promise.all([
      pool.query("SELECT pg_database_size(current_database())::bigint bytes"),
      pool.query(`SELECT
        (SELECT count(*) FROM bases WHERE deleted_at IS NULL AND owner_user_id=$1)::int bases,
        (SELECT count(*) FROM data_tables t JOIN bases b ON b.id=t.base_id WHERE t.deleted_at IS NULL AND b.deleted_at IS NULL AND b.owner_user_id=$1)::int tables,
        (SELECT count(*) FROM records r JOIN data_tables t ON t.id=r.table_id JOIN bases b ON b.id=t.base_id WHERE r.deleted_at IS NULL AND t.deleted_at IS NULL AND b.deleted_at IS NULL AND b.owner_user_id=$1)::bigint records`, [req.user.id]),
      pool.query("SELECT count(*)::int connections FROM pg_stat_activity WHERE datname=current_database()"),
    ]);
    res.json({ ok: true, database: "PostgreSQL 16", databaseBytes: size.rows[0].bytes, ...counts.rows[0], ...active.rows[0], uptimeSeconds: Math.floor(process.uptime()) });
  } catch (error) { next(error); }
});

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath, { maxAge: "1h", etag: true }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(distPath, "index.html")));
}

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.message, code: "UPLOAD_FAILED" });
  if (error instanceof SyntaxError && "body" in error) return res.status(400).json({ error: "请求内容格式错误", code: "JSON_INVALID" });
  if (error.code === "23505") return res.status(409).json({ error: "同一位置已存在相同名称", code: "NAME_CONFLICT" });
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({
    error: error.status ? error.message : "服务器暂时无法处理请求",
    code: error.code || "INTERNAL_ERROR",
    ...(error.details ? { details: error.details } : {}),
  });
});

await initializeDatabase();
await startLookupWorker();
const server = app.listen(port, "0.0.0.0", () => console.log(`multibase-v1 listening on ${port}`));

async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
