import pg from "pg";

const { Pool } = pg;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
});

const schema = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci_unique ON users(lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  username text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash text PRIMARY KEY,
  username text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
ALTER TABLE bases ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS bases_owner_idx ON bases(owner_user_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS data_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_id uuid NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS data_tables_base_idx ON data_tables(base_id, position) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('text','number','date','select','relation','lookup')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
ALTER TABLE fields DROP CONSTRAINT IF EXISTS fields_table_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS fields_table_name_active_unique ON fields(table_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS fields_table_idx ON fields(table_id, position) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '表格视图',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE views ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS views_table_name_unique ON views(table_id, name);

CREATE TABLE IF NOT EXISTS import_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL UNIQUE REFERENCES data_tables(id) ON DELETE CASCADE,
  import_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS records (
  id bigserial PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE,
  values jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS records_table_seek_idx ON records(table_id, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS records_table_updated_idx ON records(table_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS records_values_gin_idx ON records USING gin(values jsonb_path_ops) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS record_relations (
  source_record_id bigint NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  source_table_id uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE,
  relation_field_id uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  target_table_id uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE,
  target_record_id bigint NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  ordinal integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_record_id, relation_field_id, target_record_id)
);
CREATE INDEX IF NOT EXISTS record_relations_source_idx
  ON record_relations(source_table_id, relation_field_id, source_record_id, ordinal);
CREATE INDEX IF NOT EXISTS record_relations_target_idx
  ON record_relations(target_table_id, target_record_id, relation_field_id, source_record_id);

CREATE TABLE IF NOT EXISTS lookup_dependencies (
  lookup_field_id uuid PRIMARY KEY REFERENCES fields(id) ON DELETE CASCADE,
  source_table_id uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE,
  relation_field_id uuid NOT NULL REFERENCES fields(id) ON DELETE RESTRICT,
  target_table_id uuid NOT NULL REFERENCES data_tables(id) ON DELETE RESTRICT,
  target_field_id uuid NOT NULL REFERENCES fields(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lookup_dependencies_target_idx
  ON lookup_dependencies(target_table_id, target_field_id);
CREATE INDEX IF NOT EXISTS lookup_dependencies_relation_idx
  ON lookup_dependencies(relation_field_id);

CREATE TABLE IF NOT EXISTS lookup_values (
  lookup_field_id uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  source_record_id bigint NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  value jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','computing','completed','failed')),
  error_code text,
  error_message text,
  calculated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lookup_field_id, source_record_id)
);
CREATE INDEX IF NOT EXISTS lookup_values_status_idx
  ON lookup_values(lookup_field_id, status, source_record_id);

CREATE TABLE IF NOT EXISTS lookup_dirty_records (
  lookup_field_id uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  source_record_id bigint NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT 'source_changed',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lookup_field_id, source_record_id)
);
CREATE INDEX IF NOT EXISTS lookup_dirty_created_idx
  ON lookup_dirty_records(lookup_field_id, created_at, source_record_id);

CREATE TABLE IF NOT EXISTS lookup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lookup_field_id uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_by text NOT NULL,
  mode text NOT NULL DEFAULT 'incremental' CHECK (mode IN ('full','incremental','retry_failed')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','computing','completed','partial','failed')),
  total_records bigint NOT NULL DEFAULT 0,
  processed_records bigint NOT NULL DEFAULT 0,
  success_records bigint NOT NULL DEFAULT 0,
  failed_records bigint NOT NULL DEFAULT 0,
  batch_size integer NOT NULL DEFAULT 1000,
  last_record_id bigint NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS lookup_jobs_one_active_field_idx
  ON lookup_jobs(lookup_field_id) WHERE status IN ('pending','computing');
CREATE INDEX IF NOT EXISTS lookup_jobs_status_idx ON lookup_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS lookup_job_failures (
  job_id uuid NOT NULL REFERENCES lookup_jobs(id) ON DELETE CASCADE,
  lookup_field_id uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  source_record_id bigint NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  error_code text NOT NULL,
  error_message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, source_record_id)
);
CREATE INDEX IF NOT EXISTS lookup_job_failures_field_idx
  ON lookup_job_failures(lookup_field_id, source_record_id);

CREATE TABLE IF NOT EXISTS import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE,
  filename text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  total_rows integer NOT NULL DEFAULT 0,
  success_rows integer NOT NULL DEFAULT 0,
  error_rows integer NOT NULL DEFAULT 0,
  warning_rows integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE,
  filename text NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  total_rows bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs(created_at DESC);
`;

export async function initializeDatabase() {
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await pool.query(schema);
      if (process.env.SEED_DEMO !== "false") await seedDemo();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 500, 3000)));
    }
  }
  throw lastError;
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function writeAudit({ actor = "admin", action, objectType, objectId, details = {}, ip = null }, client = pool) {
  await client.query(
    `INSERT INTO audit_logs(actor, action, object_type, object_id, details, ip)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [actor, action, objectType, objectId ? String(objectId) : null, JSON.stringify(details), ip],
  );
}

async function seedDemo() {
  const { rows } = await pool.query("SELECT id FROM bases WHERE deleted_at IS NULL LIMIT 1");
  if (rows.length) return;
  const owner = (await pool.query("SELECT id FROM users WHERE status='active' ORDER BY created_at LIMIT 1")).rows[0];
  if (!owner) return;
  await withTransaction(async (client) => {
    const base = (await client.query(
      "INSERT INTO bases(name, description, owner_user_id) VALUES ($1,$2,$3) RETURNING id",
      ["客户数据库", "销售、客户与订单数据中心", owner.id],
    )).rows[0];
    const tableNames = ["客户数据", "联系记录", "订单明细"];
    const tables = [];
    for (let index = 0; index < tableNames.length; index += 1) {
      const table = (await client.query(
        "INSERT INTO data_tables(base_id,name,position) VALUES ($1,$2,$3) RETURNING id,name",
        [base.id, tableNames[index], index],
      )).rows[0];
      await client.query("INSERT INTO views(table_id,name) VALUES ($1,'表格视图')", [table.id]);
      tables.push(table);
    }
    const customers = tables[0];
    const orders = tables[2];
    const customerFields = [
      ["客户名称", "text", { multiline: false }],
      ["状态", "select", { options: [
        { label: "潜在客户", color: "blue" }, { label: "跟进中", color: "green" },
        { label: "已成交", color: "teal" }, { label: "已流失", color: "red" },
      ] }],
      ["成交金额", "number", { decimals: 2, currency: "CNY" }],
      ["下次跟进", "date", { includeTime: false, format: "YYYY-MM-DD" }],
      ["负责人", "text", {}],
      ["备注", "text", { multiline: true }],
    ];
    const fieldRows = [];
    for (let index = 0; index < customerFields.length; index += 1) {
      const [name, type, config] = customerFields[index];
      fieldRows.push((await client.query(
        "INSERT INTO fields(table_id,name,type,config,position) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id,name,type,config,position",
        [customers.id, name, type, JSON.stringify(config), index],
      )).rows[0]);
    }
    const samples = [
      ["上海远望科技", "跟进中", 128000, "2026-08-13", "石文祥", "重点客户"],
      ["北京常青贸易", "跟进中", 86500, "2026-08-14", "陈晨", ""],
      ["杭州星河网络", "潜在客户", 42800, "2026-08-15", "李敏", ""],
      ["深圳壹方咨询", "已成交", 215000, "2026-08-16", "石文祥", "重点客户"],
      ["成都启行实业", "跟进中", 68900, "2026-08-17", "陈晨", ""],
      ["南京云杉数据", "已成交", 104200, "2026-08-18", "李敏", ""],
      ["武汉知行教育", "潜在客户", 56000, "2026-08-19", "石文祥", "重点客户"],
      ["厦门简一设计", "已流失", 31600, "2026-08-20", "陈晨", ""],
      ["苏州橙果智能", "跟进中", 178000, "2026-08-21", "李敏", ""],
      ["天津向海物流", "已成交", 92400, "2026-08-22", "石文祥", "重点客户"],
      ["重庆山岚食品", "潜在客户", 73800, "2026-08-23", "陈晨", ""],
      ["青岛新域传媒", "跟进中", 49900, "2026-08-24", "李敏", ""],
    ];
    for (const sample of samples) {
      const values = Object.fromEntries(fieldRows.map((field, index) => [field.id, sample[index]]));
      await client.query("INSERT INTO records(table_id,values) VALUES ($1,$2::jsonb)", [customers.id, JSON.stringify(values)]);
    }
    const orderFields = [];
    const orderFieldDefinitions = [
      ["订单编号", "text", {}],
      ["订单金额", "number", { currency: "CNY" }],
      ["状态", "select", { options: [{ label: "待付款" }, { label: "已付款" }] }],
    ];
    for (const [index, item] of orderFieldDefinitions.entries()) {
      const [name,type,config]=item;
      orderFields.push((await client.query(
        "INSERT INTO fields(table_id,name,type,config,position) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id",
        [orders.id,name,type,JSON.stringify(config),index],
      )).rows[0]);
    }
    for (let index = 1; index <= 8; index += 1) {
      const values = {
        [orderFields[0].id]: `ORD-202608-${String(index).padStart(4,"0")}`,
        [orderFields[1].id]: 12000 + index * 8600,
        [orderFields[2].id]: index % 3 ? "已付款" : "待付款",
      };
      await client.query("INSERT INTO records(table_id,values) VALUES ($1,$2::jsonb)", [orders.id,JSON.stringify(values)]);
    }
    await writeAudit({ action: "seed_demo", objectType: "base", objectId: base.id }, client);
  });
}
