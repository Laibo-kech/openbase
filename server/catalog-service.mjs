import { pool, withTransaction } from "./db.mjs";
import { enqueueDirtyLookupJobs, markLookupsDirtyForSource } from "./lookup-service.mjs";

const DEFAULT_NORMALIZATION = Object.freeze({
  trim: true,
  collapseSpaces: true,
  caseInsensitive: false,
  fullWidth: false,
  typed: true,
});

function catalogError(message, code = "CATALOG_MATCH_FAILED", status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function normalizeCatalogOptions(input = {}) {
  return {
    trim: input.trim !== false,
    collapseSpaces: input.collapseSpaces !== false,
    caseInsensitive: Boolean(input.caseInsensitive),
    fullWidth: Boolean(input.fullWidth),
    typed: input.typed !== false,
  };
}

export function normalizeCatalogValue(value, fieldType = "text", input = {}) {
  if (value === null || value === undefined || value === "") return "";
  const options = { ...DEFAULT_NORMALIZATION, ...normalizeCatalogOptions(input) };
  if (options.typed && fieldType === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? String(number) : "";
  }
  if (options.typed && fieldType === "date") {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "";
  }
  let text = String(value);
  if (options.fullWidth) text = text.normalize("NFKC");
  if (options.trim) text = text.trim();
  if (options.collapseSpaces) text = text.replace(/\s+/gu, " ");
  if (options.caseInsensitive) text = text.toLocaleLowerCase("en-US");
  return text;
}

export function makeCatalogKey(values, fieldMap, fieldIds, options = {}) {
  return JSON.stringify(fieldIds.map((fieldId) => {
    const field = fieldMap.get(fieldId);
    return normalizeCatalogValue(values?.[fieldId], field?.type || "text", options);
  }));
}

async function getFields(tableId, client = pool) {
  const { rows } = await client.query(
    "SELECT id,name,type,config FROM fields WHERE table_id=$1 AND deleted_at IS NULL ORDER BY position,created_at",
    [tableId],
  );
  return rows;
}

async function loadDefinition(definitionId, client = pool) {
  const definition = (await client.query(
    `SELECT d.*,t.name table_name FROM catalog_definitions d
     JOIN data_tables t ON t.id=d.table_id AND t.deleted_at IS NULL WHERE d.id=$1`,
    [definitionId],
  )).rows[0];
  if (!definition) throw catalogError("目录表定义不存在", "CATALOG_DEFINITION_NOT_FOUND", 404);
  return definition;
}

async function loadConfig(configId, client = pool) {
  const config = (await client.query(
    `SELECT c.*,d.table_id catalog_table_id,d.unique_field_ids,d.index_status,d.duplicate_groups,
       source.name source_table_name,target.name catalog_table_name
     FROM catalog_match_configs c
     JOIN catalog_definitions d ON d.id=c.definition_id
     JOIN data_tables source ON source.id=c.source_table_id AND source.deleted_at IS NULL
     JOIN data_tables target ON target.id=d.table_id AND target.deleted_at IS NULL
     WHERE c.id=$1`,
    [configId],
  )).rows[0];
  if (!config) throw catalogError("目录匹配方案不存在", "CATALOG_CONFIG_NOT_FOUND", 404);
  return config;
}

async function loadRules(configId, client = pool) {
  return (await client.query(
    "SELECT * FROM catalog_match_rules WHERE config_id=$1 ORDER BY priority,created_at",
    [configId],
  )).rows;
}

function validateFieldIds(fields, ids, label) {
  const available = new Set(fields.map((field) => field.id));
  if (!ids.length || ids.some((id) => !available.has(id))) {
    throw catalogError(`${label}包含不存在或已删除的字段`, "CATALOG_FIELD_INVALID");
  }
}

async function insertIndexRows(client, tableName, ownerColumn, ownerId, rows) {
  for (let start = 0; start < rows.length; start += 1000) {
    const batch = rows.slice(start, start + 1000);
    const params = [];
    const tuples = batch.map((row, index) => {
      const offset = index * 4;
      params.push(ownerId, row.recordId, row.key, JSON.stringify(row.values || []));
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4}::jsonb)`;
    });
    if (tableName === "catalog_definition_index") {
      await client.query(
        `INSERT INTO catalog_definition_index(definition_id,catalog_record_id,normalized_key,key_values)
         VALUES ${tuples.join(",")}`,
        params,
      );
    } else {
      const simpleParams = [];
      const simpleTuples = batch.map((row, index) => {
        const offset = index * 3;
        simpleParams.push(ownerId, row.recordId, row.key);
        return `($${offset + 1},$${offset + 2},$${offset + 3})`;
      });
      await client.query(
        `INSERT INTO catalog_match_index(${ownerColumn},catalog_record_id,normalized_key)
         VALUES ${simpleTuples.join(",")}`,
        simpleParams,
      );
    }
  }
}

export async function rebuildCatalogDefinition(definitionId) {
  const definition = await loadDefinition(definitionId);
  const fieldIds = Array.isArray(definition.unique_field_ids) ? definition.unique_field_ids.map(String) : [];
  const fields = await getFields(definition.table_id);
  validateFieldIds(fields, fieldIds, "目录唯一匹配字段");
  const fieldMap = new Map(fields.map((field) => [field.id, field]));
  await pool.query("UPDATE catalog_definitions SET index_status='building',updated_at=now() WHERE id=$1", [definitionId]);
  try {
    await withTransaction(async (client) => {
      await client.query("DELETE FROM catalog_definition_index WHERE definition_id=$1", [definitionId]);
      let after = 0;
      while (true) {
        const records = (await client.query(
          `SELECT id,values FROM records WHERE table_id=$1 AND deleted_at IS NULL AND id>$2
           ORDER BY id LIMIT 2000`,
          [definition.table_id, after],
        )).rows;
        if (!records.length) break;
        const rows = records.map((record) => ({
          recordId: record.id,
          key: makeCatalogKey(record.values, fieldMap, fieldIds, definition.normalization),
          values: fieldIds.map((fieldId) => record.values?.[fieldId] ?? null),
        }));
        await insertIndexRows(client, "catalog_definition_index", "definition_id", definitionId, rows);
        after = records.at(-1).id;
      }
      const duplicate = (await client.query(
        `SELECT count(*)::int groups,COALESCE(sum(item_count),0)::bigint records FROM (
           SELECT count(*)::bigint item_count FROM catalog_definition_index
           WHERE definition_id=$1 GROUP BY normalized_key HAVING count(*)>1
         ) duplicates`,
        [definitionId],
      )).rows[0];
      await client.query(
        `UPDATE catalog_definitions SET index_status=$2,duplicate_groups=$3,duplicate_records=$4,
         indexed_at=now(),updated_at=now() WHERE id=$1`,
        [definitionId, duplicate.groups ? "duplicate" : "ready", duplicate.groups, duplicate.records],
      );
    });
  } catch (error) {
    await pool.query("UPDATE catalog_definitions SET index_status='failed',updated_at=now() WHERE id=$1", [definitionId]);
    throw error;
  }
  return loadDefinition(definitionId);
}

export async function getCatalogDuplicates(definitionId, limit = 50) {
  const definition = await loadDefinition(definitionId);
  if (definition.index_status === "stale" || definition.index_status === "failed") {
    await rebuildCatalogDefinition(definitionId);
  }
  const { rows } = await pool.query(
    `SELECT i.normalized_key,(min(i.key_values::text))::jsonb key_values,count(*)::int record_count,
      jsonb_agg(jsonb_build_object('id',i.catalog_record_id,'values',r.values) ORDER BY i.catalog_record_id) records
     FROM catalog_definition_index i JOIN records r ON r.id=i.catalog_record_id AND r.deleted_at IS NULL
     WHERE i.definition_id=$1 GROUP BY i.normalized_key HAVING count(*)>1
     ORDER BY count(*) DESC,i.normalized_key LIMIT $2`,
    [definitionId, Math.max(1, Math.min(200, Number(limit) || 50))],
  );
  const fresh = await loadDefinition(definitionId);
  return {
    status: fresh.index_status,
    duplicateGroups: fresh.duplicate_groups,
    duplicateRecords: String(fresh.duplicate_records),
    groups: rows,
  };
}

export async function refreshCatalogMatchIndex(configId) {
  const config = await loadConfig(configId);
  let definition = await loadDefinition(config.definition_id);
  if (definition.index_status !== "ready") definition = await rebuildCatalogDefinition(definition.id);
  if (definition.index_status !== "ready") {
    throw catalogError("目录表存在重复匹配值，处理重复记录后才能执行匹配", "CATALOG_DUPLICATES_BLOCK_MATCH", 409);
  }
  const targetFields = await getFields(config.catalog_table_id);
  const targetFieldMap = new Map(targetFields.map((field) => [field.id, field]));
  const rules = await loadRules(configId);
  if (!rules.length) throw catalogError("请至少配置一条目录匹配规则", "CATALOG_RULE_REQUIRED");
  for (const rule of rules) {
    const targetIds = Array.isArray(rule.target_field_ids) ? rule.target_field_ids.map(String) : [];
    validateFieldIds(targetFields, targetIds, "目标目录字段");
  }
  await withTransaction(async (client) => {
    await client.query("DELETE FROM catalog_match_index WHERE rule_id=ANY($1::uuid[])", [rules.map((rule) => rule.id)]);
    let after = 0;
    while (true) {
      const records = (await client.query(
        `SELECT id,values FROM records WHERE table_id=$1 AND deleted_at IS NULL AND id>$2 ORDER BY id LIMIT 2000`,
        [config.catalog_table_id, after],
      )).rows;
      if (!records.length) break;
      for (const rule of rules) {
        const ids = rule.target_field_ids.map(String);
        const rows = records.map((record) => ({
          recordId: record.id,
          key: makeCatalogKey(record.values, targetFieldMap, ids, rule.normalization),
        }));
        await insertIndexRows(client, "catalog_match_index", "rule_id", rule.id, rows);
      }
      after = records.at(-1).id;
    }
  });
  return { rules: rules.length };
}

export async function markCatalogDirtyForSource(client, tableId, recordIds, reason = "source_changed") {
  if (!recordIds.length) return [];
  const { rows } = await client.query(
    `INSERT INTO catalog_dirty_records(config_id,source_record_id,reason)
     SELECT c.id,r.id,$3 FROM catalog_match_configs c
     JOIN records r ON r.table_id=c.source_table_id AND r.deleted_at IS NULL
     WHERE c.source_table_id=$1 AND r.id=ANY($2::bigint[])
     ON CONFLICT(config_id,source_record_id) DO UPDATE SET reason=EXCLUDED.reason,created_at=now()
     RETURNING config_id`,
    [tableId, recordIds, reason],
  );
  return [...new Set(rows.map((row) => row.config_id))];
}

export async function markCatalogStaleForTarget(client, tableId) {
  const definitions = (await client.query(
    `UPDATE catalog_definitions SET index_status='stale',updated_at=now()
     WHERE table_id=$1 RETURNING id`,
    [tableId],
  )).rows;
  if (!definitions.length) return [];
  const configs = (await client.query(
    "SELECT id FROM catalog_match_configs WHERE definition_id=ANY($1::uuid[])",
    [definitions.map((row) => row.id)],
  )).rows;
  for (const config of configs) {
    await client.query(
      `INSERT INTO catalog_dirty_records(config_id,source_record_id,reason)
       SELECT $1,r.source_record_id,'catalog_changed' FROM catalog_match_results r
       JOIN catalog_match_jobs j ON j.id=r.job_id AND j.config_id=$1
       WHERE r.status IN ('unmatched','conflict')
       ON CONFLICT(config_id,source_record_id) DO UPDATE SET reason=EXCLUDED.reason,created_at=now()`,
      [config.id],
    );
  }
  return configs.map((row) => row.id);
}

export async function enqueueCatalogPreview({ configId, mode = "full", user }) {
  if (!["full", "incremental", "retry_failed"].includes(mode)) {
    throw catalogError("目录匹配任务模式无效", "CATALOG_JOB_MODE_INVALID");
  }
  const config = await loadConfig(configId);
  const definition = await loadDefinition(config.definition_id);
  if (definition.index_status !== "ready") await rebuildCatalogDefinition(definition.id);
  const duplicateState = await loadDefinition(definition.id);
  if (duplicateState.index_status !== "ready") {
    throw catalogError("目录表存在重复值，不允许执行自动匹配", "CATALOG_DUPLICATES_BLOCK_MATCH", 409);
  }
  await refreshCatalogMatchIndex(configId);
  const rules = await loadRules(configId);
  const sourceCount = mode === "incremental"
    ? (await pool.query("SELECT count(*)::bigint value FROM catalog_dirty_records WHERE config_id=$1", [configId])).rows[0].value
    : (await pool.query("SELECT count(*)::bigint value FROM records WHERE table_id=$1 AND deleted_at IS NULL", [config.source_table_id])).rows[0].value;
  const { rows } = await pool.query(
    `INSERT INTO catalog_match_jobs(config_id,requested_by_user_id,requested_by,mode,total_records,rules_snapshot)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT(config_id) WHERE status IN ('pending','computing','paused') DO NOTHING RETURNING *`,
    [configId, user?.id || null, user?.username || "system", mode, sourceCount, JSON.stringify(rules)],
  );
  if (rows[0]) return rows[0];
  return (await pool.query(
    "SELECT * FROM catalog_match_jobs WHERE config_id=$1 AND status IN ('pending','computing','paused') ORDER BY created_at DESC LIMIT 1",
    [configId],
  )).rows[0];
}

async function claimCatalogJob() {
  return withTransaction(async (client) => (await client.query(
    `UPDATE catalog_match_jobs SET status='computing',started_at=COALESCE(started_at,now())
     WHERE id=(SELECT id FROM catalog_match_jobs WHERE status IN ('pending','computing')
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING *`,
  )).rows[0]);
}

async function loadSourceBatch(job, config) {
  if (job.stage === "apply") {
    return (await pool.query(
      `SELECT r.source_record_id id,source.values FROM catalog_match_results r
       JOIN records source ON source.id=r.source_record_id AND source.deleted_at IS NULL
       WHERE r.job_id=$1 AND r.status IN ('matched','manual_confirmed') AND r.applied=false
         AND r.source_record_id>$2 ORDER BY r.source_record_id LIMIT $3`,
      [job.id, job.last_record_id, job.batch_size],
    )).rows;
  }
  if (job.mode === "incremental") {
    return (await pool.query(
      `SELECT source.id,source.values FROM catalog_dirty_records dirty
       JOIN records source ON source.id=dirty.source_record_id AND source.deleted_at IS NULL
       WHERE dirty.config_id=$1 AND source.id>$2 ORDER BY source.id LIMIT $3`,
      [config.id, job.last_record_id, job.batch_size],
    )).rows;
  }
  return (await pool.query(
    `SELECT id,values FROM records WHERE table_id=$1 AND deleted_at IS NULL AND id>$2 ORDER BY id LIMIT $3`,
    [config.source_table_id, job.last_record_id, job.batch_size],
  )).rows;
}

async function exactCandidates(rule, keyBySource) {
  const keys = [...new Set(keyBySource.values())];
  if (!keys.length) return new Map();
  const rows = (await pool.query(
    `SELECT normalized_key,jsonb_agg(catalog_record_id ORDER BY catalog_record_id) ids
     FROM catalog_match_index WHERE rule_id=$1 AND normalized_key=ANY($2::text[])
     GROUP BY normalized_key`,
    [rule.id, keys],
  )).rows;
  return new Map(rows.map((row) => [row.normalized_key, row.ids.map(String)]));
}

async function fuzzyCandidates(rule, keyBySource) {
  if (!keyBySource.size) return new Map();
  const ids = [...keyBySource.keys()];
  const keys = ids.map((id) => keyBySource.get(id));
  const rows = (await pool.query(
    `WITH input(source_id,normalized_key) AS (SELECT * FROM unnest($2::bigint[],$3::text[]))
     SELECT input.source_id,jsonb_agg(candidate.catalog_record_id ORDER BY candidate.score DESC) ids
     FROM input JOIN LATERAL (
       SELECT catalog_record_id,similarity(normalized_key,input.normalized_key) score
       FROM catalog_match_index WHERE rule_id=$1
         AND similarity(normalized_key,input.normalized_key)>=$4
       ORDER BY score DESC,catalog_record_id LIMIT 5
     ) candidate ON true GROUP BY input.source_id`,
    [rule.id, ids, keys, Number(rule.fuzzy_threshold || 0.72)],
  )).rows;
  return new Map(rows.map((row) => [String(row.source_id), row.ids.map(String)]));
}

async function previewBatch(job, config, records) {
  const sourceFields = await getFields(config.source_table_id);
  const sourceFieldMap = new Map(sourceFields.map((field) => [field.id, field]));
  const rules = await loadRules(config.id);
  for (const rule of rules) validateFieldIds(sourceFields, rule.source_field_ids.map(String), "源匹配字段");

  const signatures = new Map();
  if (rules[0]) {
    for (const record of records) {
      signatures.set(String(record.id), makeCatalogKey(record.values, sourceFieldMap, rules[0].source_field_ids.map(String), rules[0].normalization));
    }
  }
  const outcomes = new Map();

  for (const rule of rules) {
    const remaining = records.filter((record) => !outcomes.has(String(record.id)));
    if (!remaining.length) break;
    const keyBySource = new Map(remaining.map((record) => [
      String(record.id),
      makeCatalogKey(record.values, sourceFieldMap, rule.source_field_ids.map(String), rule.normalization),
    ]));
    const aliases = (await pool.query(
      `SELECT source_signature,target_record_id FROM catalog_aliases
       WHERE config_id=$1 AND source_signature=ANY($2::text[])`,
      [config.id, [...new Set(keyBySource.values())]],
    )).rows;
    const aliasMap = new Map(aliases.map((row) => [row.source_signature, String(row.target_record_id)]));
    for (const record of remaining) {
      const id = String(record.id);
      const signature = keyBySource.get(id);
      if (aliasMap.has(signature)) {
        outcomes.set(id, { status: "matched", targetId: aliasMap.get(signature), candidates: [], method: "alias", signature, ruleId: rule.id });
      }
    }
    const unresolved = remaining.filter((record) => !outcomes.has(String(record.id)));
    if (!unresolved.length) continue;
    if (rule.fuzzy) {
      const candidates = await fuzzyCandidates(rule, keyBySource);
      for (const record of unresolved) {
        const id = String(record.id);
        const ids = candidates.get(id) || [];
        if (ids.length) outcomes.set(id, { status: "conflict", targetId: null, candidates: ids, method: "fuzzy_candidate", signature: keyBySource.get(id), ruleId: rule.id });
      }
      continue;
    }
    const matches = await exactCandidates(rule, keyBySource);
    for (const record of unresolved) {
      const id = String(record.id);
      const ids = matches.get(keyBySource.get(id)) || [];
      if (ids.length === 1) outcomes.set(id, { status: "matched", targetId: ids[0], candidates: ids, method: "exact", signature: keyBySource.get(id), ruleId: rule.id });
      else if (ids.length > 1) outcomes.set(id, { status: "conflict", targetId: null, candidates: ids, method: "duplicate_match", signature: keyBySource.get(id), ruleId: rule.id });
    }
  }

  await withTransaction(async (client) => {
    for (const record of records) {
      const id = String(record.id);
      const result = outcomes.get(id) || { status: "unmatched", targetId: null, candidates: [], method: null, signature: signatures.get(id) || "", ruleId: null };
      const sourceValues = rules[0]?.source_field_ids?.map((fieldId) => record.values?.[fieldId] ?? null) || [];
      await client.query(
        `INSERT INTO catalog_match_results(job_id,source_record_id,status,target_record_id,candidate_record_ids,
           matched_rule_id,match_method,source_signature,source_values)
         VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb)
         ON CONFLICT(job_id,source_record_id) DO UPDATE SET status=EXCLUDED.status,target_record_id=EXCLUDED.target_record_id,
           candidate_record_ids=EXCLUDED.candidate_record_ids,matched_rule_id=EXCLUDED.matched_rule_id,
           match_method=EXCLUDED.match_method,source_signature=EXCLUDED.source_signature,
           source_values=EXCLUDED.source_values,error_message=NULL,updated_at=now()`,
        [job.id, record.id, result.status, result.targetId, JSON.stringify(result.candidates), result.ruleId,
          result.method, result.signature, JSON.stringify(sourceValues)],
      );
    }
  });
}

async function ensureRelationField(config, client) {
  const currentConfig = (await client.query(
    "SELECT relation_field_id FROM catalog_match_configs WHERE id=$1 FOR UPDATE",
    [config.id],
  )).rows[0];
  const relationFieldId = currentConfig?.relation_field_id || config.relation_field_id;
  if (relationFieldId) {
    const existing = (await client.query(
      "SELECT id FROM fields WHERE id=$1 AND table_id=$2 AND type='relation' AND deleted_at IS NULL",
      [relationFieldId, config.source_table_id],
    )).rows[0];
    if (existing) {
      config.relation_field_id = existing.id;
      return existing.id;
    }
  }
  const definition = await loadDefinition(config.definition_id, client);
  const firstFieldId = definition.unique_field_ids[0];
  const baseName = `${config.catalog_table_name}匹配`;
  let name = baseName;
  let suffix = 2;
  while ((await client.query(
    "SELECT 1 FROM fields WHERE table_id=$1 AND lower(name)=lower($2) AND deleted_at IS NULL",
    [config.source_table_id, name],
  )).rows.length) name = `${baseName}${suffix++}`;
  const position = (await client.query(
    "SELECT COALESCE(max(position),-1)+1 value FROM fields WHERE table_id=$1",
    [config.source_table_id],
  )).rows[0].value;
  const field = (await client.query(
    `INSERT INTO fields(table_id,name,type,config,position) VALUES($1,$2,'relation',$3::jsonb,$4) RETURNING id`,
    [config.source_table_id, name, JSON.stringify({
      targetTableId: config.catalog_table_id,
      matchFieldId: firstFieldId,
      returnFieldId: firstFieldId,
      multiple: false,
      catalogConfigId: config.id,
    }), position],
  )).rows[0];
  await client.query("UPDATE catalog_match_configs SET relation_field_id=$2,updated_at=now() WHERE id=$1", [config.id, field.id]);
  config.relation_field_id = field.id;
  return field.id;
}

async function applyOneResult(client, job, config, result, user) {
  const relationFieldId = await ensureRelationField(config, client);
  const currentTargets = (await client.query(
    `SELECT target_record_id FROM record_relations WHERE source_record_id=$1 AND relation_field_id=$2 ORDER BY ordinal`,
    [result.source_record_id, relationFieldId],
  )).rows.map((row) => String(row.target_record_id));
  const targetIds = result.target_record_id ? [String(result.target_record_id)] : [];
  await client.query("DELETE FROM record_relations WHERE source_record_id=$1 AND relation_field_id=$2", [result.source_record_id, relationFieldId]);
  if (targetIds.length) {
    await client.query(
      `INSERT INTO record_relations(source_record_id,source_table_id,relation_field_id,target_table_id,target_record_id,ordinal)
       VALUES($1,$2,$3,$4,$5,0)`,
      [result.source_record_id, config.source_table_id, relationFieldId, config.catalog_table_id, targetIds[0]],
    );
  }
  await client.query(
    `UPDATE records SET values=jsonb_set(values,$2::text[],$3::jsonb,true),version=version+1,updated_at=now()
     WHERE id=$1 AND deleted_at IS NULL`,
    [result.source_record_id, [relationFieldId], JSON.stringify(targetIds)],
  );
  await client.query(
    `UPDATE catalog_match_results SET previous_target_ids=$3::jsonb,applied_target_ids=$4::jsonb,
     applied=true,updated_at=now() WHERE job_id=$1 AND source_record_id=$2`,
    [job.id, result.source_record_id, JSON.stringify(currentTargets), JSON.stringify(targetIds)],
  );
  const dirty = await markLookupsDirtyForSource(client, config.source_table_id, [result.source_record_id], "catalog_match_applied");
  await enqueueDirtyLookupJobs(client, dirty, user);
}

async function applyBatch(job, config, records) {
  await withTransaction(async (client) => {
    const results = (await client.query(
      `SELECT * FROM catalog_match_results WHERE job_id=$1 AND source_record_id=ANY($2::bigint[])
       AND status IN ('matched','manual_confirmed') AND applied=false ORDER BY source_record_id`,
      [job.id, records.map((record) => record.id)],
    )).rows;
    for (const result of results) {
      await applyOneResult(client, job, config, result, { id: job.requested_by_user_id, username: job.requested_by });
    }
  });
}

async function updateJobMetrics(jobId, lastRecordId) {
  const metrics = (await pool.query(
    `SELECT count(*) FILTER (WHERE status='matched')::bigint matched,
      count(*) FILTER (WHERE status='unmatched')::bigint unmatched,
      count(*) FILTER (WHERE status='conflict')::bigint conflict,
      count(*) FILTER (WHERE status='manual_confirmed')::bigint manual,
      count(*) FILTER (WHERE applied)::bigint applied,count(*)::bigint processed
     FROM catalog_match_results WHERE job_id=$1`,
    [jobId],
  )).rows[0];
  await pool.query(
    `UPDATE catalog_match_jobs SET processed_records=$2,matched_records=$3,unmatched_records=$4,
     conflict_records=$5,manual_records=$6,applied_records=$7,last_record_id=$8 WHERE id=$1`,
    [jobId, metrics.processed, metrics.matched, metrics.unmatched, metrics.conflict, metrics.manual, metrics.applied, lastRecordId],
  );
  return metrics;
}

async function processCatalogJob(job) {
  const config = await loadConfig(job.config_id);
  const records = await loadSourceBatch(job, config);
  if (!records.length) {
    if (job.stage === "apply") {
      await pool.query(
        `UPDATE catalog_match_jobs SET status='completed',processed_records=total_records,applied_at=now(),completed_at=now()
         WHERE id=$1`,
        [job.id],
      );
      await pool.query(
        `UPDATE catalog_match_configs SET last_completed_at=now(),updated_at=now() WHERE id=$1`,
        [config.id],
      );
      await pool.query(
        `DELETE FROM catalog_dirty_records d USING catalog_match_results r
         WHERE r.job_id=$1 AND r.source_record_id=d.source_record_id AND d.config_id=$2`,
        [job.id, config.id],
      );
    } else {
      await updateJobMetrics(job.id, job.last_record_id);
      await pool.query("UPDATE catalog_match_jobs SET status='completed',completed_at=now() WHERE id=$1", [job.id]);
    }
    return;
  }
  if (job.stage === "apply") await applyBatch(job, config, records);
  else await previewBatch(job, config, records);
  await updateJobMetrics(job.id, records.at(-1).id);
}

let workerBusy = false;
async function catalogWorkerTick() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const job = await claimCatalogJob();
    if (job) await processCatalogJob(job);
  } catch (error) {
    console.error("catalog worker", error);
    const active = (await pool.query("SELECT id FROM catalog_match_jobs WHERE status='computing' ORDER BY started_at LIMIT 1")).rows[0];
    if (active) await pool.query(
      "UPDATE catalog_match_jobs SET status='failed',error_message=$2,completed_at=now() WHERE id=$1",
      [active.id, String(error.message || error).slice(0, 1000)],
    );
  } finally {
    workerBusy = false;
  }
}

export async function startCatalogWorker() {
  await pool.query(
    `UPDATE catalog_match_jobs SET status='failed',error_message='服务重启导致任务中断，可重新执行',completed_at=now()
     WHERE status='computing'`,
  );
  const timer = setInterval(catalogWorkerTick, Number(process.env.CATALOG_WORKER_INTERVAL_MS || 600));
  timer.unref();
  catalogWorkerTick();
}

export async function setCatalogJobAction(jobId, action) {
  const transitions = {
    pause: { from: ["pending", "computing"], to: "paused" },
    resume: { from: ["paused"], to: "pending" },
    cancel: { from: ["pending", "computing", "paused"], to: "cancelled" },
    retry: { from: ["failed"], to: "pending" },
  };
  const transition = transitions[action];
  if (!transition) throw catalogError("不支持的任务操作", "CATALOG_JOB_ACTION_INVALID");
  const { rows } = await pool.query(
    `UPDATE catalog_match_jobs SET status=$2,error_message=CASE WHEN $2='pending' THEN NULL ELSE error_message END,
     completed_at=CASE WHEN $2='cancelled' THEN now() ELSE NULL END
     WHERE id=$1 AND status=ANY($3::text[]) RETURNING *`,
    [jobId, transition.to, transition.from],
  );
  if (!rows.length) throw catalogError("当前任务状态不能执行该操作", "CATALOG_JOB_STATE_INVALID", 409);
  return rows[0];
}

export async function startCatalogApply(jobId) {
  const { rows } = await pool.query(
    `UPDATE catalog_match_jobs SET stage='apply',status='pending',last_record_id=0,processed_records=0,
     total_records=(SELECT count(*) FROM catalog_match_results WHERE job_id=$1 AND status IN ('matched','manual_confirmed')),
     error_message=NULL,started_at=NULL,completed_at=NULL
     WHERE id=$1 AND stage='preview' AND status='completed' RETURNING *`,
    [jobId],
  );
  if (!rows.length) throw catalogError("只有已完成的匹配预览可以正式应用", "CATALOG_PREVIEW_NOT_READY", 409);
  return rows[0];
}

export async function confirmCatalogResult({ jobId, sourceRecordId, targetRecordId, saveAlias, user }) {
  return withTransaction(async (client) => {
    const job = (await client.query("SELECT * FROM catalog_match_jobs WHERE id=$1 FOR UPDATE", [jobId])).rows[0];
    if (!job) throw catalogError("目录匹配任务不存在", "CATALOG_JOB_NOT_FOUND", 404);
    const config = await loadConfig(job.config_id, client);
    const target = (await client.query(
      "SELECT id FROM records WHERE id=$1 AND table_id=$2 AND deleted_at IS NULL",
      [targetRecordId, config.catalog_table_id],
    )).rows[0];
    if (!target) throw catalogError("选择的目录记录不存在", "CATALOG_TARGET_NOT_FOUND", 404);
    const result = (await client.query(
      `UPDATE catalog_match_results SET status='manual_confirmed',target_record_id=$3,
       candidate_record_ids=jsonb_build_array($3::bigint),match_method='manual',updated_at=now()
       WHERE job_id=$1 AND source_record_id=$2 RETURNING *`,
      [jobId, sourceRecordId, targetRecordId],
    )).rows[0];
    if (!result) throw catalogError("待处理匹配记录不存在", "CATALOG_RESULT_NOT_FOUND", 404);
    if (saveAlias && result.source_signature) {
      await client.query(
        `INSERT INTO catalog_aliases(config_id,source_signature,source_values,target_record_id,created_by_user_id,created_by)
         VALUES($1,$2,$3::jsonb,$4,$5,$6)
         ON CONFLICT(config_id,source_signature) DO UPDATE SET target_record_id=EXCLUDED.target_record_id,
           source_values=EXCLUDED.source_values,created_by_user_id=EXCLUDED.created_by_user_id,
           created_by=EXCLUDED.created_by,updated_at=now()`,
        [config.id, result.source_signature, JSON.stringify(result.source_values), targetRecordId, user.id, user.username],
      );
    }
    if (job.stage === "apply" && job.status === "completed") {
      await applyOneResult(client, job, config, result, user);
    }
    return result;
  });
}

export async function undoCatalogJob(jobId, user) {
  const job = (await pool.query("SELECT * FROM catalog_match_jobs WHERE id=$1", [jobId])).rows[0];
  if (!job || !job.applied_at || job.reverted_at) {
    throw catalogError("该任务没有可撤销的匹配结果", "CATALOG_JOB_NOT_REVERSIBLE", 409);
  }
  const config = await loadConfig(job.config_id);
  let after = 0;
  let reverted = 0;
  while (true) {
    const results = (await pool.query(
      `SELECT * FROM catalog_match_results WHERE job_id=$1 AND applied=true AND source_record_id>$2
       ORDER BY source_record_id LIMIT 1000`,
      [jobId, after],
    )).rows;
    if (!results.length) break;
    await withTransaction(async (client) => {
      for (const result of results) {
        const current = (await client.query(
          "SELECT target_record_id::text id FROM record_relations WHERE source_record_id=$1 AND relation_field_id=$2 ORDER BY ordinal",
          [result.source_record_id, config.relation_field_id],
        )).rows.map((row) => row.id);
        const applied = result.applied_target_ids.map(String);
        if (JSON.stringify(current) !== JSON.stringify(applied)) continue;
        const previous = result.previous_target_ids.map(String);
        await client.query("DELETE FROM record_relations WHERE source_record_id=$1 AND relation_field_id=$2", [result.source_record_id, config.relation_field_id]);
        for (const [ordinal, targetId] of previous.entries()) {
          await client.query(
            `INSERT INTO record_relations(source_record_id,source_table_id,relation_field_id,target_table_id,target_record_id,ordinal)
             VALUES($1,$2,$3,$4,$5,$6)`,
            [result.source_record_id, config.source_table_id, config.relation_field_id, config.catalog_table_id, targetId, ordinal],
          );
        }
        await client.query(
          `UPDATE records SET values=jsonb_set(values,$2::text[],$3::jsonb,true),version=version+1,updated_at=now()
           WHERE id=$1 AND deleted_at IS NULL`,
          [result.source_record_id, [config.relation_field_id], JSON.stringify(previous)],
        );
        await client.query(
          "UPDATE catalog_match_results SET applied=false,updated_at=now() WHERE job_id=$1 AND source_record_id=$2",
          [jobId, result.source_record_id],
        );
        const dirty = await markLookupsDirtyForSource(client, config.source_table_id, [result.source_record_id], "catalog_match_reverted");
        await enqueueDirtyLookupJobs(client, dirty, user);
        reverted += 1;
      }
    });
    after = results.at(-1).source_record_id;
  }
  await pool.query(
    `UPDATE catalog_match_jobs SET status='reverted',reverted_at=now(),applied_records=GREATEST(applied_records-$2,0)
     WHERE id=$1`,
    [jobId, reverted],
  );
  return { reverted };
}

export async function catalogFieldImpact(fieldId) {
  const definitionRows = (await pool.query(
    `SELECT d.id,d.table_id,t.name table_name,d.duplicate_records FROM catalog_definitions d
     JOIN data_tables t ON t.id=d.table_id WHERE d.unique_field_ids ? $1`,
    [fieldId],
  )).rows;
  const ruleRows = (await pool.query(
    `SELECT DISTINCT c.id,c.name,c.source_table_id,c.definition_id FROM catalog_match_rules r
     JOIN catalog_match_configs c ON c.id=r.config_id
     WHERE r.source_field_ids ? $1 OR r.target_field_ids ? $1`,
    [fieldId],
  )).rows;
  const recordCount = ruleRows.length ? (await pool.query(
    `SELECT count(*)::bigint value FROM records WHERE table_id=ANY($1::uuid[]) AND deleted_at IS NULL`,
    [[...new Set(ruleRows.map((row) => row.source_table_id))]],
  )).rows[0].value : 0;
  return { definitions: definitionRows, configs: ruleRows, affectedRecords: String(recordCount) };
}
