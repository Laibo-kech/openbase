import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const target = Number(process.env.TARGET_ROWS || 1_000_000);

try {
  const table = (await pool.query(`SELECT t.id,t.name FROM data_tables t JOIN bases b ON b.id=t.base_id WHERE b.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY b.created_at,t.position LIMIT 1`)).rows[0];
  if (!table) throw new Error("没有可用于压测的数据表");
  const fields = (await pool.query("SELECT id,name FROM fields WHERE table_id=$1 AND deleted_at IS NULL ORDER BY position", [table.id])).rows;
  const byName = Object.fromEntries(fields.map((field) => [field.name, field.id]));
  const current = Number((await pool.query("SELECT count(*)::bigint count FROM records WHERE table_id=$1 AND deleted_at IS NULL", [table.id])).rows[0].count);
  const missing = Math.max(0, target - current);
  console.log(JSON.stringify({ phase: "before", table: table.name, current, target, missing }));
  if (missing) {
    const started = Date.now();
    await pool.query(`
      INSERT INTO records(table_id, values)
      SELECT $1, jsonb_strip_nulls(jsonb_build_object(
        $2::text, '百万行客户-' || lpad(g::text, 7, '0'),
        $3::text, CASE g % 4 WHEN 0 THEN '潜在客户' WHEN 1 THEN '跟进中' WHEN 2 THEN '已成交' ELSE '已流失' END,
        $4::text, (g % 250000)::numeric,
        $5::text, to_char(date '2026-01-01' + ((g % 365)::int), 'YYYY-MM-DD'),
        $6::text, CASE g % 3 WHEN 0 THEN '石文祥' WHEN 1 THEN '陈晨' ELSE '李敏' END
      ))
      FROM generate_series(1,$7::int) g`,
      [table.id, byName["客户名称"] || "name", byName["状态"] || "status", byName["成交金额"] || "amount", byName["下次跟进"] || "date", byName["负责人"] || "owner", missing],
    );
    console.log(JSON.stringify({ phase: "inserted", rows: missing, elapsedMs: Date.now() - started }));
  }
  await pool.query("ANALYZE records");
  const final = Number((await pool.query("SELECT count(*)::bigint count FROM records WHERE table_id=$1 AND deleted_at IS NULL", [table.id])).rows[0].count);
  const explain = (await pool.query("EXPLAIN (ANALYZE,FORMAT JSON) SELECT id,values FROM records WHERE table_id=$1 AND deleted_at IS NULL AND id>$2 ORDER BY id LIMIT 100", [table.id, Math.max(0, final - 1000)])).rows[0]["QUERY PLAN"][0];
  console.log(JSON.stringify({ phase: "complete", final, executionMs: explain["Execution Time"], plan: explain.Plan["Node Type"] }));
} finally {
  await pool.end();
}
