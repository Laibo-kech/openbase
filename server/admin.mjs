import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import compression from "compression";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import { initializeDatabase, pool, writeAudit } from "./db.mjs";
import { cancelBackgroundTask, retryBackgroundTask } from "./background-task-service.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminPath = path.resolve(__dirname, "../admin");
const app = express();
const port = Number(process.env.ADMIN_PORT || 13281);
const sessionTtl = Number(process.env.ADMIN_SESSION_TTL_SECONDS || 28_800);
const attempts = new Map();

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "1mb" }));

function httpError(status, message, code = "REQUEST_FAILED") {
  return Object.assign(new Error(message), { status, code });
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [decodeURIComponent(part.slice(0, index).trim()), decodeURIComponent(part.slice(index + 1).trim())];
  }));
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeUsername(value) {
  const username = String(value || "").trim();
  if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(username)) throw httpError(400, "用户名格式不正确", "USERNAME_INVALID");
  return username;
}

function normalizePassword(value) {
  const password = String(value || "");
  if (password.length < 8 || password.length > 128) throw httpError(400, "密码长度需为 8-128 位", "PASSWORD_INVALID");
  return password;
}

async function requireAdmin(req, _res, next) {
  try {
    const token = cookies(req).mb_admin_session;
    if (!token) throw httpError(401, "请先登录管理后台", "AUTH_REQUIRED");
    const session = (await pool.query(
      "SELECT username FROM admin_sessions WHERE token_hash=$1 AND expires_at > now()",
      [hashToken(token)],
    )).rows[0];
    if (!session) throw httpError(401, "管理会话已过期", "SESSION_EXPIRED");
    req.admin = session;
    next();
  } catch (error) { next(error); }
}

app.get("/api/health", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "multibase-admin", database: "connected" });
  } catch (error) { next(error); }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const key = req.ip;
    const state = attempts.get(key) || { count: 0, blockedUntil: 0 };
    if (state.blockedUntil > Date.now()) throw httpError(429, "登录失败次数过多，请稍后再试", "LOGIN_LOCKED");
    const username = String(req.body?.username || "");
    const expectedUsername = process.env.ADMIN_CONSOLE_USERNAME || "";
    const hash = process.env.ADMIN_CONSOLE_PASSWORD_HASH_B64
      ? Buffer.from(process.env.ADMIN_CONSOLE_PASSWORD_HASH_B64, "base64").toString("utf8")
      : "";
    const valid = username === expectedUsername && hash && await bcrypt.compare(String(req.body?.password || ""), hash);
    if (!valid) {
      state.count += 1;
      if (state.count >= 5) { state.blockedUntil = Date.now() + 15 * 60_000; state.count = 0; }
      attempts.set(key, state);
      throw httpError(401, "管理员账号或密码不正确", "LOGIN_FAILED");
    }
    attempts.delete(key);
    const token = crypto.randomBytes(32).toString("base64url");
    await pool.query("DELETE FROM admin_sessions WHERE expires_at <= now()");
    await pool.query(
      "INSERT INTO admin_sessions(token_hash,username,expires_at) VALUES($1,$2,now()+($3 || ' seconds')::interval)",
      [hashToken(token), expectedUsername, String(sessionTtl)],
    );
    const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `mb_admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionTtl}${secure}`);
    res.json({ username: expectedUsername });
  } catch (error) { next(error); }
});

app.use("/api", requireAdmin);

app.get("/api/auth/me", (req, res) => res.json({ username: req.admin.username }));
app.post("/api/auth/logout", async (req, res, next) => {
  try {
    const token = cookies(req).mb_admin_session;
    if (token) await pool.query("DELETE FROM admin_sessions WHERE token_hash=$1", [hashToken(token)]);
    res.setHeader("Set-Cookie", "mb_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get("/api/dashboard", async (_req, res, next) => {
  try {
    const [counts, database, connections, taskCounts] = await Promise.all([
      pool.query(`SELECT
        (SELECT count(*) FROM users)::int users,
        (SELECT count(*) FROM users WHERE status='active')::int active_users,
        (SELECT count(*) FROM users WHERE status='disabled')::int disabled_users,
        (SELECT count(*) FROM bases WHERE deleted_at IS NULL)::int bases,
        (SELECT count(*) FROM data_tables WHERE deleted_at IS NULL)::int tables,
        (SELECT count(*) FROM records WHERE deleted_at IS NULL)::bigint records`),
      pool.query("SELECT pg_database_size(current_database())::bigint bytes"),
      pool.query("SELECT count(*)::int value FROM pg_stat_activity WHERE datname=current_database()"),
      pool.query(`SELECT count(*) FILTER (WHERE status='running')::int running_tasks,
        count(*) FILTER (WHERE status='waiting')::int waiting_tasks,
        count(*) FILTER (WHERE status='failed')::int failed_tasks FROM background_tasks`),
    ]);
    const disk = fs.statfsSync("/");
    res.json({
      ...counts.rows[0],
      databaseBytes: database.rows[0].bytes,
      databaseConnections: connections.rows[0].value,
      processUptimeSeconds: Math.floor(process.uptime()),
      hostUptimeSeconds: Math.floor(os.uptime()),
      memoryTotalBytes: os.totalmem(),
      memoryFreeBytes: os.freemem(),
      diskTotalBytes: disk.blocks * disk.bsize,
      diskFreeBytes: disk.bavail * disk.bsize,
      loadAverage: os.loadavg(),
      ...taskCounts.rows[0],
    });
  } catch (error) { next(error); }
});

app.get("/api/users", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT u.id,u.username,u.status,u.created_at,u.updated_at,u.last_login_at,
      count(DISTINCT b.id)::int base_count,count(DISTINCT t.id)::int table_count,count(r.id)::bigint record_count
      FROM users u
      LEFT JOIN bases b ON b.owner_user_id=u.id AND b.deleted_at IS NULL
      LEFT JOIN data_tables t ON t.base_id=b.id AND t.deleted_at IS NULL
      LEFT JOIN records r ON r.table_id=t.id AND r.deleted_at IS NULL
      GROUP BY u.id ORDER BY u.created_at`);
    res.json(rows);
  } catch (error) { next(error); }
});

app.post("/api/users", async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const passwordHash = await bcrypt.hash(normalizePassword(req.body?.password), 12);
    const user = (await pool.query(
      "INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id,username,status,created_at",
      [username, passwordHash],
    )).rows[0];
    await writeAudit({ actor: req.admin.username, action: "admin_create_user", objectType: "user", objectId: user.id, details: { username }, ip: req.ip });
    res.status(201).json(user);
  } catch (error) {
    if (error.code === "23505") next(httpError(409, "用户名已存在", "USERNAME_EXISTS"));
    else next(error);
  }
});

app.patch("/api/users/:userId", async (req, res, next) => {
  try {
    const username = req.body?.username === undefined ? null : normalizeUsername(req.body.username);
    const status = req.body?.status === undefined ? null : String(req.body.status);
    if (status && !["active", "disabled"].includes(status)) throw httpError(400, "账号状态无效", "STATUS_INVALID");
    const user = (await pool.query(
      "UPDATE users SET username=COALESCE($2,username),status=COALESCE($3,status),updated_at=now() WHERE id=$1 RETURNING id,username,status,created_at,updated_at,last_login_at",
      [req.params.userId, username, status],
    )).rows[0];
    if (!user) throw httpError(404, "用户不存在", "USER_NOT_FOUND");
    if (status === "disabled") await pool.query("DELETE FROM sessions WHERE user_id=$1", [req.params.userId]);
    else if (username) await pool.query("UPDATE sessions SET username=$2 WHERE user_id=$1", [req.params.userId, username]);
    await writeAudit({ actor: req.admin.username, action: "admin_update_user", objectType: "user", objectId: user.id, details: { username, status }, ip: req.ip });
    res.json(user);
  } catch (error) {
    if (error.code === "23505") next(httpError(409, "用户名已存在", "USERNAME_EXISTS"));
    else next(error);
  }
});

app.post("/api/users/:userId/reset-password", async (req, res, next) => {
  try {
    const passwordHash = await bcrypt.hash(normalizePassword(req.body?.password), 12);
    const user = (await pool.query(
      "UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1 RETURNING id,username",
      [req.params.userId, passwordHash],
    )).rows[0];
    if (!user) throw httpError(404, "用户不存在", "USER_NOT_FOUND");
    await pool.query("DELETE FROM sessions WHERE user_id=$1", [req.params.userId]);
    await writeAudit({ actor: req.admin.username, action: "admin_reset_password", objectType: "user", objectId: user.id, details: { username: user.username }, ip: req.ip });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get("/api/projects", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT b.id,b.name,b.created_at,b.updated_at,u.username owner_username,
      count(DISTINCT t.id)::int table_count,count(r.id)::bigint record_count
      FROM bases b JOIN users u ON u.id=b.owner_user_id
      LEFT JOIN data_tables t ON t.base_id=b.id AND t.deleted_at IS NULL
      LEFT JOIN records r ON r.table_id=t.id AND r.deleted_at IS NULL
      WHERE b.deleted_at IS NULL GROUP BY b.id,u.username ORDER BY b.updated_at DESC`);
    res.json(rows);
  } catch (error) { next(error); }
});

app.get("/api/audit", async (_req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200");
    res.json(rows);
  } catch (error) { next(error); }
});

app.get("/api/tasks", async (req, res, next) => {
  try {
    const statuses = String(req.query.status || "").split(",").filter(Boolean);
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    const { rows } = await pool.query(
      `SELECT task.*,b.name base_name,t.name table_name,u.username account_name
       FROM background_tasks task JOIN bases b ON b.id=task.base_id
       JOIN data_tables t ON t.id=task.table_id
       LEFT JOIN users u ON u.id=task.requested_by_user_id
       WHERE ($1::text[]='{}' OR task.status=ANY($1::text[]))
       ORDER BY task.created_at DESC LIMIT $2`,
      [statuses, limit],
    );
    res.json(rows);
  } catch (error) { next(error); }
});

app.post("/api/tasks/:taskId/cancel", async (req, res, next) => {
  try {
    const task = await cancelBackgroundTask(req.params.taskId);
    await writeAudit({ actor: req.admin.username, action: "admin_cancel", objectType: "background_task", objectId: task.id, ip: req.ip });
    res.json(task);
  } catch (error) { next(error); }
});

app.post("/api/tasks/:taskId/retry", async (req, res, next) => {
  try {
    const task = await retryBackgroundTask(req.params.taskId);
    await writeAudit({ actor: req.admin.username, action: "admin_retry", objectType: "background_task", objectId: task.id, ip: req.ip });
    res.status(202).json(task);
  } catch (error) { next(error); }
});

app.get("/api/slow-tasks", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT task.*,b.name base_name,t.name table_name
       FROM background_tasks task JOIN bases b ON b.id=task.base_id JOIN data_tables t ON t.id=task.table_id
       WHERE task.task_type IN ('catalog_match','pivot_calculation') AND task.duration_ms IS NOT NULL
       ORDER BY task.duration_ms DESC LIMIT 100`,
    );
    res.json(rows);
  } catch (error) { next(error); }
});

app.get("/api/database-monitor", async (_req, res, next) => {
  try {
    const [connections, slowQueries, taskCounts, indexStates, database] = await Promise.all([
      pool.query(`SELECT COALESCE(state,'unknown') state,count(*)::int count
        FROM pg_stat_activity WHERE datname=current_database() GROUP BY state ORDER BY count(*) DESC`),
      pool.query(`SELECT pid,usename,COALESCE(state,'unknown') state,
        extract(epoch FROM (clock_timestamp()-query_start))::numeric(12,2) duration_seconds,
        left(regexp_replace(query,'[[:space:]]+',' ','g'),240) query
        FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND state<>'idle' AND query_start<clock_timestamp()-interval '1 second'
        ORDER BY query_start LIMIT 50`),
      pool.query(`SELECT status,count(*)::int count FROM background_tasks GROUP BY status ORDER BY status`),
      pool.query(`SELECT status,count(*)::int count,COALESCE(sum(actual_bytes),0)::bigint bytes
        FROM field_performance_indexes GROUP BY status ORDER BY status`),
      pool.query(`SELECT pg_database_size(current_database())::bigint database_bytes,
        (SELECT count(*) FROM records WHERE deleted_at IS NULL)::bigint records`),
    ]);
    const disk = fs.statfsSync("/");
    res.json({
      ...database.rows[0], connections: connections.rows, slowQueries: slowQueries.rows,
      tasks: taskCounts.rows, indexes: indexStates.rows,
      diskTotalBytes: disk.blocks * disk.bsize, diskFreeBytes: disk.bavail * disk.bsize,
    });
  } catch (error) { next(error); }
});

app.use(express.static(adminPath, { maxAge: "1h", etag: true }));
app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(adminPath, "index.html")));

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.status ? error.message : "服务器暂时无法处理请求", code: error.code || "INTERNAL_ERROR" });
});

await initializeDatabase();
const server = app.listen(port, "0.0.0.0", () => console.log(`multibase-admin listening on ${port}`));

async function shutdown() {
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
