import crypto from "node:crypto";
import { pool } from "../server/db.mjs";

const baseUrl = process.env.ACCEPTANCE_BASE_URL || "http://127.0.0.1:14280";
const rowTarget = Number(process.env.PIVOT_TEST_ROWS || 1_000_000);
const suffix = Date.now().toString(36);
const username = `pivot_million_${suffix}`;
const password = crypto.randomBytes(24).toString("base64url");
let cookie = "";
let userId = null;
let baseId = null;

async function request(path, options = {}, expectedStatus = null) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...options.headers,
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const contentType = response.headers.get("content-type") || "";
  const result = response.status === 204 ? null
    : contentType.includes("json") ? await response.json() : await response.text();
  if (expectedStatus !== null && response.status !== expectedStatus) {
    throw new Error(`${path} expected ${expectedStatus}, received ${response.status}: ${JSON.stringify(result)}`);
  }
  if (expectedStatus === null && !response.ok) {
    throw new Error(`${path} returned ${response.status}: ${JSON.stringify(result)}`);
  }
  return result;
}

async function waitForJob(jobId, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await request(`/api/pivot-jobs/${jobId}?limit=500`);
    if (result.job.status === "completed") return result;
    if (["failed", "cancelled"].includes(result.job.status)) {
      throw new Error(`Pivot job stopped with ${result.job.status}: ${result.job.error_message || "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Pivot job timed out after ${timeoutMs}ms`);
}

try {
  const registered = await request("/api/auth/register", { method: "POST", body: { username, password } }, 201);
  userId = registered.id;
  const base = await request("/api/bases", { method: "POST", body: { name: `百万行透视验收-${suffix}` } }, 201);
  baseId = base.id;
  const tables = await request(`/api/bases/${base.id}/tables`);
  const table = tables[0];
  await request(`/api/tables/${table.id}`, { method: "PATCH", body: { name: "百万行订单" } });
  const createField = (name, type, config = {}) => request(`/api/tables/${table.id}/fields`, {
    method: "POST",
    body: { name, type, config },
  });
  const category = await createField("商品分类", "select", {
    options: ["办公", "家居", "数码", "服饰", "食品", "美妆", "运动", "其他"].map((label) => ({ label })),
  });
  const region = await createField("地区", "select", {
    options: ["华东", "华南", "华北", "西部"].map((label) => ({ label })),
  });
  const orderDate = await createField("订单日期", "date");
  const amount = await createField("订单金额", "number", { decimals: 2 });

  const insertStartedAt = Date.now();
  await pool.query(
    `INSERT INTO records(table_id,values)
     SELECT $1,jsonb_build_object(
       $2::text, CASE g % 8 WHEN 0 THEN '办公' WHEN 1 THEN '家居' WHEN 2 THEN '数码' WHEN 3 THEN '服饰'
         WHEN 4 THEN '食品' WHEN 5 THEN '美妆' WHEN 6 THEN '运动' ELSE '其他' END,
       $3::text, CASE g % 4 WHEN 0 THEN '华东' WHEN 1 THEN '华南' WHEN 2 THEN '华北' ELSE '西部' END,
       $4::text, to_char(date '2025-01-01' + ((g - 1) % 365)::int, 'YYYY-MM-DD'),
       $5::text, ((g % 10000)::numeric + 0.5)
     )
     FROM generate_series(1,$6::int) g`,
    [table.id, category.id, region.id, orderDate.id, amount.id, rowTarget],
  );
  await pool.query("ANALYZE records");
  const insertMs = Date.now() - insertStartedAt;
  const sourceRows = Number((await pool.query(
    "SELECT count(*)::bigint count FROM records WHERE table_id=$1 AND deleted_at IS NULL",
    [table.id],
  )).rows[0].count);
  if (sourceRows !== rowTarget) throw new Error(`Expected ${rowTarget} source rows, found ${sourceRows}`);

  const pivot = await request(`/api/bases/${base.id}/pivot-configs`, {
    method: "POST",
    body: {
      name: "月份分类销售验收",
      tableId: table.id,
      config: {
        rows: [{ fieldId: category.id }],
        columns: [{ fieldId: orderDate.id, grouping: "month" }],
        measures: [
          { id: "orders", aggregation: "count", label: "订单数" },
          { id: "amount", fieldId: amount.id, aggregation: "sum", label: "销售额" },
        ],
        filters: [{ fieldId: region.id, operator: "not_empty" }],
        filterMode: "all",
        totals: { rows: true, columns: true, grand: true, subtotals: true },
        empty: { mode: "separate", label: "(空值)" },
        sort: { by: "amount", direction: "desc" },
      },
    },
  }, 201);

  const calculationStartedAt = Date.now();
  const enqueued = await request(`/api/pivot-configs/${pivot.id}/calculate`, { method: "POST", body: {} }, 202);
  const result = await waitForJob(enqueued.id);
  const calculationMs = Date.now() - calculationStartedAt;
  const grandTotal = result.rows.find((row) => Number(row.row_level) === 0 && Number(row.column_level) === 0);
  if (!grandTotal) throw new Error("Grand total row is missing");
  if (Number(grandTotal.values.orders) !== rowTarget) {
    throw new Error(`Grand total count is ${grandTotal.values.orders}, expected ${rowTarget}`);
  }
  const expectedSum = rowTarget === 1_000_000 ? 5_000_000_000 : null;
  if (expectedSum !== null && Number(grandTotal.values.amount) !== expectedSum) {
    throw new Error(`Grand total sum is ${grandTotal.values.amount}, expected ${expectedSum}`);
  }
  const cachedStartedAt = Date.now();
  const cached = await request(`/api/pivot-configs/${pivot.id}/calculate`, { method: "POST", body: {} }, 200);
  const cachedMs = Date.now() - cachedStartedAt;
  if (!cached.cached || cached.id !== enqueued.id) throw new Error("Repeated pivot calculation did not use cache");

  console.log(JSON.stringify({
    ok: true,
    sourceRows,
    insertMs,
    calculationMs,
    resultRows: Number(result.job.result_rows),
    grandTotal: { count: Number(grandTotal.values.orders), sum: Number(grandTotal.values.amount) },
    cache: { hit: true, responseMs: cachedMs },
  }));
} finally {
  if (baseId && userId) await pool.query("DELETE FROM bases WHERE id=$1 AND owner_user_id=$2", [baseId, userId]);
  if (userId) {
    await pool.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
    await pool.query("DELETE FROM users WHERE id=$1 AND username=$2", [userId, username]);
  }
  const leftovers = (await pool.query(
    "SELECT count(*)::int count FROM bases WHERE id=$1 UNION ALL SELECT count(*)::int FROM users WHERE id=$2",
    [baseId, userId],
  )).rows.reduce((sum, row) => sum + Number(row.count), 0);
  if (leftovers) console.error(JSON.stringify({ cleanupOk: false, leftovers }));
  await pool.end();
}
