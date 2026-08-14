const baseUrl = process.env.ADMIN_ACCEPTANCE_BASE_URL || "http://127.0.0.1:13281";
const username = process.env.ADMIN_ACCEPTANCE_USERNAME;
const password = process.env.ADMIN_ACCEPTANCE_PASSWORD;
const expectedUsers = String(process.env.ADMIN_ACCEPTANCE_EXPECTED_USERS || "").split(",").map((item) => item.trim()).filter(Boolean);
if (!username || !password) throw new Error("缺少管理后台验收账号");

let cookie = "";
async function request(path, options = {}, expectedStatus = null) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...options.headers },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (expectedStatus !== null) {
    if (response.status !== expectedStatus) throw new Error(`${path} 应返回 ${expectedStatus}，实际 ${response.status}`);
    return result;
  }
  if (!response.ok) throw new Error(`${path} 返回 ${response.status}`);
  return result;
}

const health = await request("/api/health");
if (!health.ok || health.database !== "connected") throw new Error("管理后台健康检查失败");
await request("/api/dashboard", {}, 401);
await request("/api/auth/login", { method: "POST", body: { username, password } });
const [me, dashboard, users, projects, audit] = await Promise.all([
  request("/api/auth/me"), request("/api/dashboard"), request("/api/users"), request("/api/projects"), request("/api/audit"),
]);
if (me.username !== username) throw new Error("管理后台登录身份不正确");
for (const expected of expectedUsers) {
  if (!users.some((user) => user.username === expected)) throw new Error("缺少预期普通用户");
}
if (Number(dashboard.records) < 1 || Number(dashboard.users) < expectedUsers.length || !Array.isArray(projects) || !Array.isArray(audit)) {
  throw new Error("管理后台统计数据不完整");
}
console.log(JSON.stringify({ ok: true, users: dashboard.users, activeUsers: dashboard.activeUsers, bases: dashboard.bases, tables: dashboard.tables, records: dashboard.records, projects: projects.length, auditRows: audit.length }));
