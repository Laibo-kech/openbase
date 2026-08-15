import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  CirclePause,
  CirclePlay,
  Link2,
  ListChecks,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  SearchCheck,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { api, formatBytes, formatNumber } from "./api.js";

const NORMALIZATION_DEFAULT = {
  trim: true,
  collapseSpaces: true,
  caseInsensitive: true,
  fullWidth: true,
  typed: true,
};
const resultTabs = [
  ["all", "全部"],
  ["matched", "成功"],
  ["unmatched", "未匹配"],
  ["conflict", "匹配冲突"],
  ["manual_confirmed", "人工确认"],
];
const statusNames = {
  pending: "排队中",
  computing: "处理中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  reverted: "已撤销",
  matched: "匹配成功",
  unmatched: "未匹配",
  conflict: "待确认",
  manual_confirmed: "人工确认",
  ready: "可使用",
  duplicate: "存在重复",
  stale: "待更新",
};

function IconButton({ icon: Icon, label, ...props }) {
  return <button className="icon-button" title={label} aria-label={label} {...props}><Icon size={16} /></button>;
}

function ActionButton({ icon: Icon, primary, danger, children, ...props }) {
  return <button className={`button ${primary ? "primary" : ""} ${danger ? "danger" : ""}`} {...props}>{Icon && <Icon size={15} />}{children}</button>;
}

function FeatureModal({ title, wide, children, footer, onClose }) {
  return createPortal(
    <div className="overlay feature-overlay">
      <section className={`modal feature-modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true">
        <header><h2>{title}</h2><IconButton icon={X} label="关闭" onClick={onClose} /></header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}

function Notice({ type = "info", children }) {
  return <div className={`feature-notice ${type}`}><AlertTriangle size={17} /><div>{children}</div></div>;
}

function useSchemas(tables) {
  const [schemas, setSchemas] = useState({});
  async function load(tableId) {
    if (!tableId) return null;
    if (schemas[tableId]) return schemas[tableId];
    const schema = await api(`/tables/${tableId}/schema`);
    setSchemas((current) => ({ ...current, [tableId]: schema }));
    return schema;
  }
  useEffect(() => {
    for (const table of tables) load(table.id).catch(() => {});
  }, [tables.map((table) => table.id).join(",")]);
  return { schemas, load };
}

function ToggleLine({ checked, onChange, children }) {
  return <label className="check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{children}</label>;
}

function DefinitionEditor({ base, tables, schemas, existing, onClose, onSaved }) {
  const [tableId, setTableId] = useState(existing?.table_id || tables[0]?.id || "");
  const [fieldIds, setFieldIds] = useState(existing?.unique_field_ids || []);
  const [normalization, setNormalization] = useState({ ...NORMALIZATION_DEFAULT, ...(existing?.normalization || {}) });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [indexEstimate, setIndexEstimate] = useState(null);
  const fields = (schemas[tableId]?.fields || []).filter((field) => field.type !== "lookup");
  useEffect(() => {
    setIndexEstimate(null);
    if (!tableId || !fieldIds.length) return undefined;
    const timer = setTimeout(() => api(`/tables/${tableId}/index-estimate`, {
      method: "POST", body: { fieldIds, purpose: "catalog" },
    }).then(setIndexEstimate).catch(() => setIndexEstimate(null)), 250);
    return () => clearTimeout(timer);
  }, [tableId, fieldIds.join(",")]);
  async function save(confirmImpact = false) {
    setSaving(true); setError("");
    try {
      const response = await api(`/bases/${base.id}/catalog-definitions`, {
        method: "POST", body: { tableId, uniqueFieldIds: fieldIds, normalization, confirmImpact },
      });
      onSaved(response);
    } catch (err) {
      if (err.code === "CATALOG_IMPACT_CONFIRMATION_REQUIRED" && window.confirm(`修改后将影响 ${err.details?.matchConfigs || 0} 个匹配方案，继续吗？`)) return save(true);
      setError(err.message);
    } finally { setSaving(false); }
  }
  return (
    <FeatureModal title={existing ? "编辑目录表" : "设置目录表"} onClose={onClose} footer={<><ActionButton onClick={onClose}>取消</ActionButton><ActionButton primary disabled={!tableId || !fieldIds.length || saving} onClick={() => save()}>{saving ? "检查中" : "保存并检查"}</ActionButton></>}>
      <div className="form-stack">
        <label>目录数据表<select value={tableId} onChange={(event) => { setTableId(event.target.value); setFieldIds([]); }}>{tables.map((table) => <option key={table.id} value={table.id}>{table.name}</option>)}</select></label>
        <div>
          <strong className="field-label">唯一匹配字段 <small>可选择 1-5 个字段组成联合唯一键</small></strong>
          <div className="choice-grid">{fields.map((field) => <ToggleLine key={field.id} checked={fieldIds.includes(field.id)} onChange={(checked) => setFieldIds((current) => checked ? [...current, field.id].slice(0, 5) : current.filter((id) => id !== field.id))}>{field.name} <small>{field.type}</small></ToggleLine>)}</div>
        </div>
        <div>
          <strong className="field-label">标准化规则</strong>
          <div className="choice-grid compact">{[
            ["trim", "忽略首尾空格"], ["collapseSpaces", "合并连续空格"], ["caseInsensitive", "忽略英文大小写"], ["fullWidth", "忽略全角半角"], ["typed", "标准化数字和日期"],
          ].map(([key, label]) => <ToggleLine key={key} checked={normalization[key]} onChange={(checked) => setNormalization({ ...normalization, [key]: checked })}>{label}</ToggleLine>)}</div>
        </div>
        {indexEstimate && <div className="index-estimate"><div><span>预计记录</span><strong>{formatNumber(indexEstimate.records)}</strong></div><div><span>预计索引空间</span><strong>{formatBytes(indexEstimate.estimatedBytes)}</strong></div><div><span>预计建立时间</span><strong>约 {indexEstimate.estimatedSeconds} 秒</strong></div><small>采用并发建立索引，期间仍可浏览和编辑数据。</small></div>}
        {error && <Notice type="error">{error}</Notice>}
      </div>
    </FeatureModal>
  );
}

function DuplicateModal({ definition, schemas, onClose }) {
  const [data, setData] = useState(null);
  const fields = schemas[definition.table_id]?.fields || [];
  useEffect(() => { api(`/catalog-definitions/${definition.id}/duplicates`).then(setData); }, [definition.id]);
  const fieldName = (id) => fields.find((field) => field.id === id)?.name || id;
  return (
    <FeatureModal title="目录重复值" wide onClose={onClose} footer={<ActionButton onClick={onClose}>关闭</ActionButton>}>
      {!data ? <div className="loading"><LoaderCircle className="spin" />正在检查目录</div> : data.duplicateGroups === 0 ? <Notice type="success"><strong>目录唯一性检查通过</strong><p>当前匹配字段没有重复值，可以执行自动匹配。</p></Notice> : <>
        <Notice type="error"><strong>发现 {formatNumber(data.duplicateGroups)} 组重复值，共涉及 {formatNumber(data.duplicateRecords)} 条记录</strong><p>自动匹配已被阻止。请回到“{definition.table_name}”修正重复记录，再重新检查。</p></Notice>
        <div className="duplicate-list">{data.groups.map((group) => <section key={group.normalized_key}><header><code>{group.key_values.map((value, index) => `${fieldName(definition.unique_field_ids[index])}: ${value ?? "(空)"}`).join(" + ")}</code><span>{group.record_count} 条</span></header>{group.records.map((record) => <div key={record.id}><strong>#{record.id}</strong><span>{JSON.stringify(record.values)}</span></div>)}</section>)}</div>
      </>}
    </FeatureModal>
  );
}

function emptyRule() {
  return { pairs: [{ source: "", target: "" }], normalization: { ...NORMALIZATION_DEFAULT }, fuzzy: false, fuzzyThreshold: 0.72 };
}

function ConfigEditor({ base, tables, schemas, definitions, existing, onClose, onSaved }) {
  const [step, setStep] = useState(existing ? 3 : 1);
  const [name, setName] = useState(existing?.name || "");
  const [sourceTableId, setSourceTableId] = useState(existing?.source_table_id || tables[0]?.id || "");
  const [definitionId, setDefinitionId] = useState(existing?.definition_id || definitions.find((item) => item.index_status === "ready")?.id || "");
  const initialRules = existing?.rules?.map((rule) => ({
    pairs: rule.source_field_ids.map((source, index) => ({ source, target: rule.target_field_ids[index] || "" })),
    normalization: { ...NORMALIZATION_DEFAULT, ...rule.normalization }, fuzzy: rule.fuzzy, fuzzyThreshold: Number(rule.fuzzy_threshold),
  })) || [emptyRule()];
  const [rules, setRules] = useState(initialRules);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const definition = definitions.find((item) => item.id === definitionId);
  const sourceFields = schemas[sourceTableId]?.fields || [];
  const targetFields = schemas[definition?.table_id]?.fields || [];
  function updateRule(index, next) { setRules((current) => current.map((item, itemIndex) => itemIndex === index ? next : item)); }
  function payloadRules() {
    return rules.map((rule, priority) => ({
      priority: priority + 1,
      sourceFieldIds: rule.pairs.map((pair) => pair.source), targetFieldIds: rule.pairs.map((pair) => pair.target),
      normalization: rule.normalization, fuzzy: rule.fuzzy, fuzzyThreshold: Number(rule.fuzzyThreshold),
    }));
  }
  const rulesValid = rules.length && rules.every((rule) => rule.pairs.length && rule.pairs.every((pair) => pair.source && pair.target));
  async function save() {
    setSaving(true); setError("");
    try {
      const body = existing ? { name, rules: payloadRules() } : { name, sourceTableId, definitionId, rules: payloadRules() };
      const response = await api(existing ? `/catalog-configs/${existing.id}` : `/bases/${base.id}/catalog-configs`, { method: existing ? "PATCH" : "POST", body });
      onSaved(response);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  return (
    <FeatureModal title={existing ? "编辑匹配方案" : "新建匹配方案"} wide onClose={onClose} footer={<><ActionButton onClick={onClose}>取消</ActionButton>{!existing && step > 1 && <ActionButton onClick={() => setStep(step - 1)}>上一步</ActionButton>}{!existing && step < 3 ? <ActionButton primary disabled={(step === 1 && !sourceTableId) || (step === 2 && !definitionId)} onClick={() => setStep(step + 1)}>下一步</ActionButton> : <ActionButton primary disabled={!name.trim() || !sourceTableId || !definitionId || !rulesValid || saving} onClick={save}>{saving ? "保存中" : "保存方案"}</ActionButton>}</>}>
      <div className="step-strip">{["目标数据表", "匹配目录", "匹配字段与规则"].map((label, index) => <span className={step >= index + 1 ? "active" : ""} key={label}><b>{index + 1}</b>{label}</span>)}</div>
      {(step === 1 || existing) && <div className="form-grid"><label>方案名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：订单匹配商品目录" /></label><label>业务数据表<select disabled={Boolean(existing)} value={sourceTableId} onChange={(event) => setSourceTableId(event.target.value)}><option value="">请选择</option>{tables.map((table) => <option key={table.id} value={table.id}>{table.name}</option>)}</select></label></div>}
      {(step === 2 || existing) && <div className="form-stack"><label>目标目录表<select disabled={Boolean(existing)} value={definitionId} onChange={(event) => setDefinitionId(event.target.value)}><option value="">请选择</option>{definitions.map((item) => <option key={item.id} disabled={item.index_status !== "ready"} value={item.id}>{item.table_name}{item.index_status !== "ready" ? "（存在重复值）" : ""}</option>)}</select></label>{definition?.index_status !== "ready" && <Notice type="error">该目录表未通过唯一性检查，不能创建自动匹配方案。</Notice>}</div>}
      {step === 3 && <div className="rule-editor">
        <div className="rule-editor-heading"><div><strong>规则按优先级依次执行</strong><p>完全一致规则可以自动关联；模糊规则只生成候选，必须人工确认。</p></div><ActionButton icon={Plus} disabled={rules.length >= 10} onClick={() => setRules([...rules, emptyRule()])}>添加规则</ActionButton></div>
        {rules.map((rule, index) => <section className="match-rule" key={index}>
          <header><span className="rule-order">优先级 {index + 1}</span><div><IconButton icon={ChevronUp} label="上移" disabled={index === 0} onClick={() => { const next = [...rules]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setRules(next); }} /><IconButton icon={ChevronDown} label="下移" disabled={index === rules.length - 1} onClick={() => { const next = [...rules]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; setRules(next); }} /><IconButton icon={Trash2} label="删除规则" disabled={rules.length === 1} onClick={() => setRules(rules.filter((_, itemIndex) => itemIndex !== index))} /></div></header>
          <div className="mapping-list">{rule.pairs.map((pair, pairIndex) => <div className="mapping-row" key={pairIndex}><select value={pair.source} onChange={(event) => { const pairs = rule.pairs.map((item, itemIndex) => itemIndex === pairIndex ? { ...item, source: event.target.value } : item); updateRule(index, { ...rule, pairs }); }}><option value="">源字段</option>{sourceFields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}</select><Link2 size={15} /><select value={pair.target} onChange={(event) => { const pairs = rule.pairs.map((item, itemIndex) => itemIndex === pairIndex ? { ...item, target: event.target.value } : item); updateRule(index, { ...rule, pairs }); }}><option value="">目录字段</option>{targetFields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}</select><IconButton icon={X} label="删除字段对" disabled={rule.pairs.length === 1} onClick={() => updateRule(index, { ...rule, pairs: rule.pairs.filter((_, itemIndex) => itemIndex !== pairIndex) })} /></div>)}</div>
          <button className="text-command" onClick={() => updateRule(index, { ...rule, pairs: [...rule.pairs, { source: "", target: "" }] })}><Plus size={14} />添加联合匹配字段</button>
          <div className="rule-options"><ToggleLine checked={rule.fuzzy} onChange={(checked) => updateRule(index, { ...rule, fuzzy: checked })}>模糊匹配候选</ToggleLine>{rule.fuzzy && <label>相似度阈值<input type="number" min="0.1" max="1" step="0.05" value={rule.fuzzyThreshold} onChange={(event) => updateRule(index, { ...rule, fuzzyThreshold: event.target.value })} /></label>}{[["caseInsensitive", "忽略大小写"], ["trim", "首尾空格"], ["collapseSpaces", "连续空格"], ["fullWidth", "全角半角"], ["typed", "数字日期标准化"]].map(([key, label]) => <ToggleLine key={key} checked={rule.normalization[key]} onChange={(checked) => updateRule(index, { ...rule, normalization: { ...rule.normalization, [key]: checked } })}>{label}</ToggleLine>)}</div>
        </section>)}
      </div>}
      {error && <Notice type="error">{error}</Notice>}
    </FeatureModal>
  );
}

function valuePreview(values) {
  if (!values) return "—";
  const shown = Object.values(values).filter((value) => value !== null && value !== "").slice(0, 4);
  return shown.map((value) => Array.isArray(value) ? value.join(", ") : String(value)).join(" · ") || "—";
}

function ManualConfirmModal({ result, catalogTableId, onClose, onConfirmed }) {
  const [candidates, setCandidates] = useState(result.candidates || []);
  const [targetId, setTargetId] = useState(result.candidates[0]?.id ? String(result.candidates[0].id) : "");
  const [saveAlias, setSaveAlias] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (candidates.length || !catalogTableId) return;
    api(`/tables/${catalogTableId}/records?limit=100`).then((data) => setCandidates(data.records));
  }, [catalogTableId]);
  async function confirm() {
    setSaving(true);
    try {
      await api(`/catalog-jobs/${result.job_id}/results/${result.source_record_id}/confirm`, { method: "POST", body: { targetRecordId: targetId, saveAlias } });
      onConfirmed();
    } finally { setSaving(false); }
  }
  return <FeatureModal title="人工确认目录记录" onClose={onClose} footer={<><ActionButton onClick={onClose}>取消</ActionButton><ActionButton primary disabled={!targetId || saving} onClick={confirm}>确认关联</ActionButton></>}><div className="manual-source"><small>待匹配原始数据</small><strong>{valuePreview(result.source_record_values)}</strong></div><div className="candidate-list">{candidates.map((candidate) => <label className={targetId === String(candidate.id) ? "selected" : ""} key={candidate.id}><input type="radio" name="candidate" value={candidate.id} checked={targetId === String(candidate.id)} onChange={(event) => setTargetId(event.target.value)} /><div><strong>目录记录 #{candidate.id}</strong><span>{valuePreview(candidate.values)}</span></div></label>)}</div><ToggleLine checked={saveAlias} onChange={setSaveAlias}>保存为别名规则；以后出现相同内容时自动匹配</ToggleLine></FeatureModal>;
}

function JobWorkspace({ config, onConfigChanged }) {
  const [job, setJob] = useState(config.jobs?.[0] || null);
  const [tab, setTab] = useState("all");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(null);
  async function loadResults(targetJob = job, targetTab = tab) {
    if (!targetJob?.id) return setResults([]);
    const query = targetTab === "all" ? "" : `?status=${targetTab}`;
    const data = await api(`/catalog-jobs/${targetJob.id}/results${query}`);
    setResults(data.results);
  }
  async function refreshJob(id = job?.id) {
    if (!id) return;
    const next = await api(`/catalog-jobs/${id}`);
    setJob(next);
    if (!["pending", "computing"].includes(next.status)) await loadResults(next, tab);
    return next;
  }
  useEffect(() => { setJob(config.jobs?.[0] || null); }, [config.id]);
  useEffect(() => { loadResults().catch((err) => setError(err.message)); }, [job?.id, tab]);
  useEffect(() => {
    if (!job || !["pending", "computing"].includes(job.status)) return;
    const timer = setInterval(() => refreshJob(job.id).catch((err) => setError(err.message)), 700);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  async function run(mode) {
    setBusy(true); setError("");
    try { const next = await api(`/catalog-configs/${config.id}/preview`, { method: "POST", body: { mode } }); setJob(next); setResults([]); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function action(name) {
    setBusy(true); setError("");
    try {
      const path = name === "apply" ? `/catalog-jobs/${job.id}/apply` : name === "undo" ? `/catalog-jobs/${job.id}/undo` : `/catalog-jobs/${job.id}/action`;
      const next = await api(path, { method: "POST", body: name === "apply" || name === "undo" ? {} : { action: name } });
      if (name === "undo") await refreshJob(); else setJob(next);
      onConfigChanged();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const progress = job?.total_records ? Math.round(Number(job.processed_records || 0) / Number(job.total_records) * 100) : 0;
  return <div className="catalog-workspace">
    <section className="catalog-runbar"><div><h2>{config.name}</h2><p>{config.source_table_name} → {config.catalog_table_name} · {config.rules.length} 条规则 · 待增量 {formatNumber(config.dirty_records || 0)} 条</p></div><div className="run-actions">{config.jobs?.length > 0 && <select className="task-select" value={job?.id || ""} onChange={async (event) => { const next = await api(`/catalog-jobs/${event.target.value}`); setJob(next); setResults([]); }}><option value="">任务记录</option>{config.jobs.map((item) => <option key={item.id} value={item.id}>{new Date(item.created_at).toLocaleString("zh-CN")} · {statusNames[item.status] || item.status}</option>)}</select>}<ActionButton icon={RefreshCw} disabled={busy} onClick={() => run("incremental")}>匹配新增/变化</ActionButton><ActionButton primary icon={SearchCheck} disabled={busy} onClick={() => run("full")}>全量匹配预览</ActionButton></div></section>
    {error && <Notice type="error">{error}</Notice>}
    {!job ? <div className="feature-empty"><ListChecks size={34} /><h3>尚未执行匹配</h3><p>先生成预览，确认成功、未匹配和冲突数量，再应用关联结果。</p></div> : <>
      <section className="job-overview">
        <div className="job-status"><span className={`status-dot ${job.status}`} /> <strong>{statusNames[job.status] || job.status}</strong><small>{job.mode === "incremental" ? "增量任务" : "全量任务"} · {new Date(job.created_at).toLocaleString("zh-CN")}</small></div>
        <div className="metric"><span>总记录</span><strong>{formatNumber(job.total_records)}</strong></div><div className="metric success"><span>自动匹配</span><strong>{formatNumber(job.matched_records)}</strong></div><div className="metric warning"><span>待确认</span><strong>{formatNumber(job.conflict_records)}</strong></div><div className="metric danger"><span>未匹配</span><strong>{formatNumber(job.unmatched_records)}</strong></div><div className="metric"><span>人工确认</span><strong>{formatNumber(job.manual_records)}</strong></div>
      </section>
      {["pending", "computing", "paused"].includes(job.status) && <div className="task-progress"><span style={{ width: `${progress}%` }} /><strong>{progress}%</strong><small>{formatNumber(job.processed_records)} / {formatNumber(job.total_records)}</small></div>}
      <div className="job-actions">{job.status === "computing" && <ActionButton icon={CirclePause} onClick={() => action("pause")}>暂停</ActionButton>}{job.status === "paused" && <ActionButton icon={CirclePlay} onClick={() => action("resume")}>继续</ActionButton>}{["pending", "computing", "paused"].includes(job.status) && <ActionButton danger icon={X} onClick={() => action("cancel")}>取消任务</ActionButton>}{job.status === "failed" && <ActionButton icon={RefreshCw} onClick={() => action("retry")}>失败重试</ActionButton>}{job.stage === "preview" && job.status === "completed" && <ActionButton primary icon={Check} disabled={!Number(job.matched_records) && !Number(job.manual_records)} onClick={() => action("apply")}>应用 {formatNumber(Number(job.matched_records) + Number(job.manual_records))} 条关联</ActionButton>}{job.applied_at && !job.reverted_at && <ActionButton danger icon={RotateCcw} onClick={() => window.confirm("只撤销本次任务写入的关联结果，继续吗？") && action("undo")}>撤销本次任务</ActionButton>}</div>
      <div className="result-tabs">{resultTabs.map(([id, label]) => <button className={tab === id ? "active" : ""} onClick={() => setTab(id)} key={id}>{label}</button>)}</div>
      <div className="result-table"><div className="result-head"><span>源记录</span><span>匹配结果</span><span>方式</span><span>状态</span><span>处理</span></div>{results.length ? results.map((result) => <div className="result-row" key={result.source_record_id}><span><b>#{result.source_record_id}</b><small>{valuePreview(result.source_record_values)}</small></span><span>{result.target_record_id ? <>#{result.target_record_id}<small>{valuePreview(result.target_record_values)}</small></> : result.candidates.length ? `${result.candidates.length} 个候选` : "—"}</span><span>{result.match_method === "alias" ? "别名规则" : result.match_method === "fuzzy_candidate" ? "模糊候选" : result.match_method === "manual" ? "人工" : result.match_method === "exact" ? "完全一致" : "—"}</span><span><em className={`result-status ${result.status}`}>{statusNames[result.status] || result.status}</em></span><span>{["conflict", "unmatched"].includes(result.status) ? <ActionButton onClick={() => setConfirming(result)}>选择目录记录</ActionButton> : "—"}</span></div>) : <div className="result-empty">此分类暂无记录</div>}</div>
    </>}
    {confirming && <ManualConfirmModal result={confirming} catalogTableId={config.catalog_table_id} onClose={() => setConfirming(null)} onConfirmed={async () => { setConfirming(null); await refreshJob(); await loadResults(job, tab); onConfigChanged(); }} />}
  </div>;
}

export default function CatalogMatching({ base, tables }) {
  const [view, setView] = useState("matching");
  const [definitions, setDefinitions] = useState([]);
  const [configs, setConfigs] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selected, setSelected] = useState(null);
  const [definitionEditor, setDefinitionEditor] = useState(null);
  const [duplicates, setDuplicates] = useState(null);
  const [configEditor, setConfigEditor] = useState(null);
  const [loading, setLoading] = useState(true);
  const { schemas } = useSchemas(tables);
  async function load() {
    const [nextDefinitions, nextConfigs] = await Promise.all([api(`/bases/${base.id}/catalog-definitions`), api(`/bases/${base.id}/catalog-configs`)]);
    setDefinitions(nextDefinitions); setConfigs(nextConfigs); setSelectedId((current) => current && nextConfigs.some((item) => item.id === current) ? current : nextConfigs[0]?.id || null); setLoading(false);
  }
  async function loadSelected(id = selectedId) { if (!id) return setSelected(null); setSelected(await api(`/catalog-configs/${id}`)); }
  useEffect(() => { load(); }, [base.id]);
  useEffect(() => { loadSelected(); }, [selectedId]);
  async function removeConfig(item) {
    if (!window.confirm(`删除匹配方案“${item.name}”？任务记录、别名和自动关联字段也会删除。`)) return;
    try { await api(`/catalog-configs/${item.id}`, { method: "DELETE" }); } catch (err) { if (err.code === "CATALOG_IMPACT_CONFIRMATION_REQUIRED" && window.confirm(`将影响 ${err.details?.jobs || 0} 个任务、${err.details?.records || 0} 条记录，确认删除吗？`)) await api(`/catalog-configs/${item.id}?confirmImpact=true`, { method: "DELETE" }); else return; }
    setSelectedId(null); await load();
  }
  if (loading) return <main className="content-page"><div className="loading"><LoaderCircle className="spin" />正在读取目录配置</div></main>;
  return <main className="content-page feature-page">
    <div className="page-heading"><div><h1>匹配目录</h1><p>把业务数据匹配到标准目录记录，再通过查找引用带出标准字段。</p></div><div className="heading-actions"><div className="segmented"><button className={view === "matching" ? "active" : ""} onClick={() => setView("matching")}>匹配方案</button><button className={view === "definitions" ? "active" : ""} onClick={() => setView("definitions")}>目录表</button></div>{view === "matching" ? <ActionButton primary icon={Plus} disabled={!definitions.length} onClick={() => setConfigEditor({})}>新建匹配方案</ActionButton> : <ActionButton primary icon={Plus} onClick={() => setDefinitionEditor({})}>设置目录表</ActionButton>}</div></div>
    {view === "definitions" ? <div className="definition-page"><div className="definition-table"><div className="definition-head"><span>目录表</span><span>唯一匹配字段</span><span>唯一性状态</span><span>匹配方案</span><span>操作</span></div>{definitions.map((item) => <div className="definition-row" key={item.id}><span><strong>{item.table_name}</strong><small>更新于 {new Date(item.updated_at).toLocaleString("zh-CN")}</small></span><span>{item.unique_field_ids.map((id) => schemas[item.table_id]?.fields?.find((field) => field.id === id)?.name || id).join(" + ")}</span><span><em className={`result-status ${item.index_status}`}>{statusNames[item.index_status] || item.index_status}</em>{item.index_status === "duplicate" && <small>{item.duplicate_groups} 组重复</small>}</span><span>{item.match_config_count}</span><span><IconButton icon={item.index_status === "duplicate" ? AlertTriangle : SearchCheck} label="查看唯一性检查" onClick={() => setDuplicates(item)} /><IconButton icon={Pencil} label="编辑目录表" onClick={() => setDefinitionEditor(item)} /></span></div>)}</div>{!definitions.length && <div className="feature-empty"><Settings2 size={34} /><h3>先设置一张目录表</h3><p>商品、客户、地区或科目表都可以成为目录表。</p></div>}</div> : <div className="catalog-layout"><aside className="feature-list"><header><strong>匹配方案</strong><span>{configs.length}</span></header>{configs.map((item) => <button className={selectedId === item.id ? "active" : ""} key={item.id} onClick={() => setSelectedId(item.id)}><span><strong>{item.name}</strong><small>{item.source_table_name} → {item.catalog_table_name}</small></span><em>{formatNumber(item.dirty_records)} 待匹配</em></button>)}{!configs.length && <p>暂无匹配方案</p>}</aside><section className="feature-main">{selected ? <><div className="feature-main-tools"><span>{selected.rules.length} 条规则 · {selected.aliases.length} 条别名</span><div><IconButton icon={Pencil} label="编辑匹配方案" onClick={() => setConfigEditor(selected)} /><IconButton icon={Trash2} label="删除匹配方案" onClick={() => removeConfig(selected)} /></div></div><JobWorkspace config={{ ...selected, dirty_records: configs.find((item) => item.id === selected.id)?.dirty_records }} onConfigChanged={async () => { await load(); await loadSelected(selected.id); }} /></> : <div className="feature-empty"><ListChecks size={34} /><h3>新建匹配方案</h3><p>按“目标数据表、匹配目录、匹配字段”三个步骤完成配置。</p></div>}</section></div>}
    {definitionEditor && <DefinitionEditor base={base} tables={tables.map((table) => ({ ...table, base_id: base.id }))} schemas={schemas} existing={definitionEditor.id ? definitionEditor : null} onClose={() => setDefinitionEditor(null)} onSaved={async (item) => { setDefinitionEditor(null); await load(); if (item.index_status === "duplicate") setDuplicates({ ...item, table_name: tables.find((table) => table.id === item.table_id)?.name }); }} />}
    {duplicates && <DuplicateModal definition={duplicates} schemas={schemas} onClose={() => { setDuplicates(null); load(); }} />}
    {configEditor && <ConfigEditor base={base} tables={tables} schemas={schemas} definitions={definitions} existing={configEditor.id ? configEditor : null} onClose={() => setConfigEditor(null)} onSaved={async (item) => { setConfigEditor(null); await load(); setSelectedId(item.id); }} />}
  </main>;
}
