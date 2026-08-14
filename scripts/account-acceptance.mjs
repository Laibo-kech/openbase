import crypto from "node:crypto";
import { pool } from "../server/db.mjs";

const baseUrl = process.env.ACCEPTANCE_BASE_URL || "http://127.0.0.1:13280";
const primaryUsername = process.env.ACCEPTANCE_PRIMARY_USERNAME;
const primaryPassword = process.env.ACCEPTANCE_PRIMARY_PASSWORD;
const secondaryUsername = process.env.ACCEPTANCE_SECONDARY_USERNAME;
const secondaryPassword = process.env.ACCEPTANCE_SECONDARY_PASSWORD;
if (![primaryUsername, primaryPassword, secondaryUsername, secondaryPassword].every(Boolean)) throw new Error("缺少账号验收环境变量");

function client() {
  let cookie = "";
  return async (path, options = {}, expectedStatus = null) => {
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
  };
}

const primary = client();
await primary("/api/auth/login", { method: "POST", body: { username: primaryUsername, password: primaryPassword } });
const bases = await primary("/api/bases");
if (!bases.length) throw new Error("主账号没有继承现有项目");
const tables = await primary(`/api/bases/${bases[0].id}/tables`);
if (tables.length < 2) throw new Error("数据表数量不足，无法验收排序");

const reversedIds = [...tables].reverse().map((table) => table.id);
await primary(`/api/bases/${bases[0].id}/tables/reorder`, { method: "PATCH", body: { tableIds: reversedIds } });
const reversed = await primary(`/api/bases/${bases[0].id}/tables`);
if (reversed.map((table) => table.id).join() !== reversedIds.join()) throw new Error("数据表排序未持久化");
await primary(`/api/bases/${bases[0].id}/tables/reorder`, { method: "PATCH", body: { tableIds: tables.map((table) => table.id) } });

const schema = await primary(`/api/tables/${tables[0].id}/schema`);
const view = schema.views[0];
const field = schema.fields[0];
const temporaryName = `${view.name}-验收`;
const updatedView = await primary(`/api/views/${view.id}`, { method: "PATCH", body: { name: temporaryName, config: { ...view.config, columnWidths: { ...(view.config?.columnWidths || {}), [field.id]: 28 } } } });
if (updatedView.name !== temporaryName || Number(updatedView.config.columnWidths[field.id]) !== 28) throw new Error("视图重命名或最小列宽未保存");
await primary(`/api/views/${view.id}`, { method: "PATCH", body: { name: view.name, config: view.config } });

const secondary = client();
await secondary("/api/auth/login", { method: "POST", body: { username: secondaryUsername, password: secondaryPassword } });
const secondaryBases = await secondary("/api/bases");
if (secondaryBases.length !== 0) throw new Error("新用户错误看到了其他用户项目");
await secondary(`/api/bases/${bases[0].id}/tables`, {}, 404);

const temporaryUsername = `accept_${Date.now()}`;
const temporaryPassword = crypto.randomBytes(24).toString("base64url");
const registration = client();
try {
  const registered = await registration("/api/auth/register", { method: "POST", body: { username: temporaryUsername, password: temporaryPassword } });
  if (registered.username !== temporaryUsername) throw new Error("注册返回的用户名不正确");
  if ((await registration("/api/bases")).length !== 0) throw new Error("新注册用户错误继承了现有项目");
  const duplicate = client();
  await duplicate("/api/auth/register", { method: "POST", body: { username: temporaryUsername.toUpperCase(), password: temporaryPassword } }, 409);
} finally {
  await pool.query("DELETE FROM users WHERE lower(username)=lower($1)", [temporaryUsername]);
  await pool.end();
}

console.log(JSON.stringify({ ok: true, primaryBaseCount: bases.length, tableCount: tables.length, secondaryBaseCount: secondaryBases.length, isolationStatus: 404 }));
