import crypto from "node:crypto";
import { pool } from "../server/db.mjs";

const appBaseUrl = process.env.RELEASE_APP_BASE_URL || "http://127.0.0.1:13280";
const adminBaseUrl = process.env.RELEASE_ADMIN_BASE_URL || "http://127.0.0.1:13281";
const adminUsername = process.env.ADMIN_CONSOLE_USERNAME;

if (!adminUsername) throw new Error("ADMIN_CONSOLE_USERNAME is required");

const sessionHashes = [];
const adminSessionHashes = [];

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function request(baseUrl, path, cookie = "", expectedStatus = null) {
  const response = await fetch(baseUrl + path, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  const result = await response.json().catch(() => null);
  if (expectedStatus !== null) {
    if (response.status !== expectedStatus) {
      throw new Error(`${path} expected ${expectedStatus}, received ${response.status}`);
    }
    return result;
  }
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return result;
}

async function issueUserSession(user) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  sessionHashes.push(tokenHash);
  await pool.query(
    "INSERT INTO sessions(token_hash,user_id,username,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
    [tokenHash, user.id, user.username],
  );
  return `mb_session=${token}`;
}

async function issueAdminSession() {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  adminSessionHashes.push(tokenHash);
  await pool.query(
    "INSERT INTO admin_sessions(token_hash,username,expires_at) VALUES($1,$2,now()+interval '10 minutes')",
    [tokenHash, adminUsername],
  );
  return `mb_admin_session=${token}`;
}

try {
  const users = (await pool.query(`
    SELECT u.id,u.username,u.status,count(b.id)::int base_count
    FROM users u
    LEFT JOIN bases b ON b.owner_user_id=u.id AND b.deleted_at IS NULL
    WHERE u.status='active'
    GROUP BY u.id
    ORDER BY count(b.id) DESC,u.created_at
  `)).rows;
  if (users.length < 2) throw new Error("At least two active users are required for isolation checks");

  const primary = users[0];
  const secondary = users.find((user) => user.id !== primary.id);
  if (!primary.base_count) throw new Error("Primary user has no project data");

  const before = (await pool.query(`SELECT
    (SELECT count(*) FROM users)::int users,
    (SELECT count(*) FROM bases WHERE deleted_at IS NULL)::int bases,
    (SELECT count(*) FROM data_tables WHERE deleted_at IS NULL)::int tables,
    (SELECT count(*) FROM records WHERE deleted_at IS NULL)::bigint records
  `)).rows[0];

  const health = await request(appBaseUrl, "/api/health");
  if (!health.ok || health.database !== "connected") throw new Error("Application health check failed");
  await request(appBaseUrl, "/api/bases", "", 401);

  const primaryCookie = await issueUserSession(primary);
  const secondaryCookie = await issueUserSession(secondary);
  const primaryMe = await request(appBaseUrl, "/api/auth/me", primaryCookie);
  if (primaryMe.id !== primary.id) throw new Error("Primary session identity mismatch");

  const primaryBases = await request(appBaseUrl, "/api/bases", primaryCookie);
  if (!primaryBases.length) throw new Error("Primary user cannot read existing projects");
  const primaryTables = await request(appBaseUrl, `/api/bases/${primaryBases[0].id}/tables`, primaryCookie);
  if (!primaryTables.length) throw new Error("Primary project has no readable tables");
  const recordPage = await request(appBaseUrl, `/api/tables/${primaryTables[0].id}/records?limit=1`, primaryCookie);
  if (!Array.isArray(recordPage.records) || !Array.isArray(recordPage.fields)) {
    throw new Error("Record API response is incomplete");
  }

  const secondaryBases = await request(appBaseUrl, "/api/bases", secondaryCookie);
  if (secondaryBases.some((base) => base.id === primaryBases[0].id)) {
    throw new Error("Secondary user can see the primary user's project");
  }
  await request(appBaseUrl, `/api/bases/${primaryBases[0].id}/tables`, secondaryCookie, 404);

  const adminHealth = await request(adminBaseUrl, "/api/health");
  if (!adminHealth.ok || adminHealth.database !== "connected") throw new Error("Admin health check failed");
  await request(adminBaseUrl, "/api/dashboard", "", 401);
  const adminCookie = await issueAdminSession();
  const [dashboard, adminUsers, projects, audit] = await Promise.all([
    request(adminBaseUrl, "/api/dashboard", adminCookie),
    request(adminBaseUrl, "/api/users", adminCookie),
    request(adminBaseUrl, "/api/projects", adminCookie),
    request(adminBaseUrl, "/api/audit", adminCookie),
  ]);
  if (!Array.isArray(adminUsers) || !Array.isArray(projects) || !Array.isArray(audit)) {
    throw new Error("Admin API response is incomplete");
  }
  if (Number(dashboard.users) !== before.users || Number(dashboard.bases) !== before.bases
    || Number(dashboard.tables) !== before.tables || String(dashboard.records) !== String(before.records)) {
    throw new Error("Admin dashboard totals do not match the database");
  }

  const after = (await pool.query(`SELECT
    (SELECT count(*) FROM users)::int users,
    (SELECT count(*) FROM bases WHERE deleted_at IS NULL)::int bases,
    (SELECT count(*) FROM data_tables WHERE deleted_at IS NULL)::int tables,
    (SELECT count(*) FROM records WHERE deleted_at IS NULL)::bigint records
  `)).rows[0];
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Release smoke test changed business data counts");

  console.log(JSON.stringify({
    ok: true,
    users: before.users,
    bases: before.bases,
    tables: before.tables,
    records: before.records,
    primaryBases: primaryBases.length,
    primaryTables: primaryTables.length,
    firstTableRecords: recordPage.total,
    secondaryBases: secondaryBases.length,
    isolationStatus: 404,
    adminUsers: adminUsers.length,
    adminProjects: projects.length,
    auditRows: audit.length,
  }));
} finally {
  if (sessionHashes.length) await pool.query("DELETE FROM sessions WHERE token_hash=ANY($1::text[])", [sessionHashes]);
  if (adminSessionHashes.length) await pool.query("DELETE FROM admin_sessions WHERE token_hash=ANY($1::text[])", [adminSessionHashes]);
  await pool.end();
}
