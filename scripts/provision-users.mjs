import bcrypt from "bcryptjs";
import { initializeDatabase, pool, withTransaction } from "../server/db.mjs";

function required(name) {
  const value = String(process.env[name] || "");
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

function username(value) {
  const result = String(value).trim();
  if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(result)) throw new Error("用户名格式无效");
  return result;
}

function password(value) {
  const result = String(value);
  if (result.length < 8 || result.length > 128) throw new Error("密码长度必须为 8-128 位");
  return result;
}

await initializeDatabase();

const primaryUsername = username(required("PRIMARY_USERNAME"));
const primaryPasswordHash = await bcrypt.hash(password(required("PRIMARY_PASSWORD")), 12);
const secondaryUsername = username(required("SECONDARY_USERNAME"));
const secondaryPasswordHash = await bcrypt.hash(password(required("SECONDARY_PASSWORD")), 12);

const result = await withTransaction(async (client) => {
  let primary = (await client.query("SELECT id FROM users WHERE lower(username)=lower($1)", [primaryUsername])).rows[0];
  if (!primary) {
    const legacy = (await client.query("SELECT id FROM users WHERE lower(username)='admin'")).rows[0];
    if (legacy) {
      primary = (await client.query(
        "UPDATE users SET username=$2,password_hash=$3,status='active',updated_at=now() WHERE id=$1 RETURNING id",
        [legacy.id, primaryUsername, primaryPasswordHash],
      )).rows[0];
    } else {
      primary = (await client.query(
        "INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id",
        [primaryUsername, primaryPasswordHash],
      )).rows[0];
    }
  } else {
    await client.query(
      "UPDATE users SET username=$2,password_hash=$3,status='active',updated_at=now() WHERE id=$1",
      [primary.id, primaryUsername, primaryPasswordHash],
    );
  }

  let secondary = (await client.query("SELECT id FROM users WHERE lower(username)=lower($1)", [secondaryUsername])).rows[0];
  if (secondary) {
    await client.query(
      "UPDATE users SET username=$2,password_hash=$3,status='active',updated_at=now() WHERE id=$1",
      [secondary.id, secondaryUsername, secondaryPasswordHash],
    );
  } else {
    secondary = (await client.query(
      "INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id",
      [secondaryUsername, secondaryPasswordHash],
    )).rows[0];
  }

  const assigned = await client.query("UPDATE bases SET owner_user_id=$1 WHERE owner_user_id IS NULL", [primary.id]);
  await client.query("DELETE FROM sessions");
  return { primaryUserId: primary.id, secondaryUserId: secondary.id, assignedBases: assigned.rowCount };
});

console.log(JSON.stringify({ ok: true, ...result }));
await pool.end();
