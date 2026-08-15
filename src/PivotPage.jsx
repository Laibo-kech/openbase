import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Calculator,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  Filter,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { api, formatBytes, formatNumber, publicPath } from "./api.js";

const aggregations = [
  ["count", "计数"], ["distinct_count", "去重计数"], ["sum", "求和"],
  ["average", "平均值"], ["max", "最大值"], ["min", "最小值"],
];
const operators = [["eq", "等于"], ["neq", "不等于"], ["contains", "包含"], ["gt", "大于"], ["gte", "大于等于"], ["lt", "小于"], ["lte", "小于等于"], ["empty", "为空"], ["not_empty", "不为空"], ["in", "属于列表"]];
const statusNames = { pending: "排队中", computing: "计算中", completed: "已完成", failed: "计算失败", cancelled: "已取消" };

function ActionButton({ icon: Icon, primary, danger, children, ...props }) {
  return <button className={`button ${primary ? "primary" : ""} ${danger ? "danger" : ""}`} {...props}>{Icon && <Icon size={15} />}{children}</button>;
}

function IconButton({ icon: Icon, label, ...props }) {
  return <button className="icon-button" title={label} aria-label={label} {...props}><Icon size={16} /></button>;
}

function PivotModal({ title, children, footer, onClose, wide }) {
  return createPortal(<div className="overlay feature-overlay"><section className={`modal feature-modal ${wide ? "wide" : ""}`}><header><h2>{title}</h2><IconButton icon={X} label="关闭" onClick={onClose} /></header><div className="modal-body">{children}</div>{footer && <footer>{footer}</footer>}</section></div>, document.body);
}

function Notice({ type = "info", children }) {
  return <div className={`feature-notice ${type}`}><AlertTriangle size={17} /><div>{children}</div></div>;
}

function blankConfig() {
  return {
    rows: [], columns: [], measures: [{ id: "records", fieldId: null, aggregation: "count", label: "记录数" }],
    filters: [], filterMode: "all",
    totals: { rows: true, columns: true, grand: true, subtotals: true },
    empty: { mode: "separate", label: "(空值)" }, sort: { by: "name", direction: "asc" },
  };
}

function DimensionRow({ item, fields, onChange, onDelete }) {
  const field = fields.find((candidate) => candidate.id === item.fieldId);
  return <div className="pivot-config-row"><select value={item.fieldId} onChange={(event) => onChange({ ...item, fieldId: event.target.value, grouping: "value", interval: null })}><option value="">选择字段</option>{fields.filter((candidate) => ["text", "select", "date", "number"].includes(candidate.type)).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select>{field?.type === "date" ? <select value={item.grouping || "value"} onChange={(event) => onChange({ ...item, grouping: event.target.value })}><option value="value">原始日期</option><option value="year">按年</option><option value="quarter">按季度</option><option value="month">按月</option><option value="week">按周</option><option value="day">按日</option></select> : field?.type === "number" ? <input type="number" min="0" placeholder="区间大小（可选）" value={item.interval || ""} onChange={(event) => onChange({ ...item, interval: event.target.value ? Number(event.target.value) : null })} /> : <span className="row-hint">按值分组</span>}<IconButton icon={Trash2} label="删除" onClick={onDelete} /></div>;
}

function MeasureRow({ item, fields, onChange, onDelete }) {
  const numeric = ["sum", "average", "max", "min"].includes(item.aggregation);
  return <div className="pivot-config-row measure"><select value={item.aggregation} onChange={(event) => onChange({ ...item, aggregation: event.target.value, fieldId: event.target.value === "count" ? null : item.fieldId })}>{aggregations.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><select disabled={item.aggregation === "count"} value={item.fieldId || ""} onChange={(event) => onChange({ ...item, fieldId: event.target.value || null })}><option value="">{item.aggregation === "count" ? "全部记录" : "选择指标字段"}</option>{fields.filter((field) => !numeric || field.type === "number").map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}</select><input value={item.label} placeholder="指标名称" onChange={(event) => onChange({ ...item, label: event.target.value })} /><IconButton icon={Trash2} label="删除" onClick={onDelete} /></div>;
}

function FilterRow({ item, fields, onChange, onDelete }) {
  const needsValue = !["empty", "not_empty"].includes(item.operator);
  return <div className="pivot-config-row filter"><select value={item.fieldId} onChange={(event) => onChange({ ...item, fieldId: event.target.value })}><option value="">选择字段</option>{fields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}</select><select value={item.operator} onChange={(event) => onChange({ ...item, operator: event.target.value })}>{operators.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><input disabled={!needsValue} value={needsValue ? item.value : ""} placeholder={item.operator === "in" ? "用英文逗号分隔" : "筛选值"} onChange={(event) => onChange({ ...item, value: event.target.value })} /><IconButton icon={Trash2} label="删除" onClick={onDelete} /></div>;
}

function ConfigSection({ title, count, limit, onAdd, children }) {
  return <section className="pivot-editor-section"><header><div><strong>{title}</strong><small>{count} / {limit}</small></div><IconButton icon={Plus} label={`添加${title}`} disabled={count >= limit} onClick={onAdd} /></header>{children}</section>;
}

function CreatePivot({ base, tables, schemas, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [tableId, setTableId] = useState(tables[0]?.id || "");
  const [saving, setSaving] = useState(false);
  async function create() {
    setSaving(true);
    try {
      const fields = schemas[tableId]?.fields || [];
      const firstDimension = fields.find((field) => ["text", "select", "date"].includes(field.type));
      const config = blankConfig();
      if (firstDimension) config.rows = [{ fieldId: firstDimension.id }];
      const result = await api(`/bases/${base.id}/pivot-configs`, { method: "POST", body: { name, tableId, config } });
      onCreated(result);
    } finally { setSaving(false); }
  }
  return <PivotModal title="新建数据透视" onClose={onClose} footer={<><ActionButton onClick={onClose}>取消</ActionButton><ActionButton primary disabled={!name.trim() || !tableId || saving} onClick={create}>创建并配置</ActionButton></>}><label>数据透视名称<input value={name} onChange={(event) => setName(event.target.value)} autoFocus placeholder="例如：地区月份销售分析" /></label><label>需要分析的数据表<select value={tableId} onChange={(event) => setTableId(event.target.value)}>{tables.map((table) => <option key={table.id} value={table.id}>{table.name}（{formatNumber(table.record_count)} 行）</option>)}</select></label></PivotModal>;
}

function Drilldown({ data, row, onClose }) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState(data);
  async function load(nextOffset) { setPage(await api(`/pivot-jobs/${row.jobId}/drilldown/${row.row_index}?offset=${nextOffset}&limit=50`)); setOffset(nextOffset); }
  return <PivotModal wide title="汇总数字的原始记录" onClose={onClose} footer={<><span className="modal-footer-note">共 {formatNumber(page.total)} 条原始记录</span><ActionButton disabled={offset === 0} onClick={() => load(Math.max(0, offset - 50))}>上一页</ActionButton><ActionButton disabled={offset + page.records.length >= Number(page.total)} onClick={() => load(offset + 50)}>下一页</ActionButton><ActionButton onClick={onClose}>返回透视</ActionButton></>}><div className="drilldown-scroll"><table><thead><tr><th>记录 ID</th>{page.fields.map((field) => <th key={field.id}>{field.name}</th>)}</tr></thead><tbody>{page.records.map((record) => <tr key={record.id}><td>#{record.id}</td>{page.fields.map((field) => <td key={field.id}>{Array.isArray(record.values[field.id]) ? record.values[field.id].join(", ") : String(record.values[field.id] ?? "—")}</td>)}</tr>)}</tbody></table></div></PivotModal>;
}

function ExportModal({ job, onClose }) {
  const [format, setFormat] = useState("xlsx");
  const [estimate, setEstimate] = useState(null);
  useEffect(() => { api(`/pivot-jobs/${job.id}/export-estimate?format=${format}`).then(setEstimate); }, [job.id, format]);
  return <PivotModal title="导出数据透视结果" onClose={onClose} footer={<><ActionButton onClick={onClose}>取消</ActionButton><a className="button primary" href={publicPath(`/api/pivot-jobs/${job.id}/export.${format}`)}><Download size={15} />开始导出</a></>}><label>文件格式<select value={format} onChange={(event) => setFormat(event.target.value)}><option value="xlsx">Excel 工作簿 (.xlsx)</option><option value="csv">CSV 文本 (.csv)</option></select></label><div className="export-preview"><div><span>预计结果行数</span><strong>{formatNumber(estimate?.rows)}</strong></div><div><span>预计文件大小</span><strong>{estimate ? formatBytes(estimate.estimatedBytes) : "计算中"}</strong></div></div></PivotModal>;
}

function PivotResult({ selected, fields, config, onJobChanged }) {
  const [jobPage, setJobPage] = useState(null);
  const [offset, setOffset] = useState(0);
  const [drilldown, setDrilldown] = useState(null);
  const [exporting, setExporting] = useState(false);
  const job = jobPage?.job || selected.jobs?.find((item) => item.id === selected.last_job_id) || selected.jobs?.[0];
  async function load(jobId = selected.last_job_id || selected.jobs?.[0]?.id, nextOffset = 0) {
    if (!jobId) return setJobPage(null);
    const page = await api(`/pivot-jobs/${jobId}?offset=${nextOffset}&limit=200`);
    setJobPage(page); setOffset(nextOffset);
  }
  useEffect(() => { load(); }, [selected.id, selected.last_job_id]);
  useEffect(() => {
    if (!job || !["pending", "computing"].includes(job.status)) return;
    const timer = setInterval(async () => { const next = await api(`/pivot-jobs/${job.id}?offset=0&limit=200`); setJobPage(next); if (!["pending", "computing"].includes(next.job.status)) onJobChanged(); }, 800);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  const fieldName = (id) => fields.find((field) => field.id === id)?.name || "已失效字段";
  async function openDrilldown(row) { setDrilldown({ row: { ...row, jobId: job.id }, data: await api(`/pivot-jobs/${job.id}/drilldown/${row.row_index}?offset=0&limit=50`) }); }
  if (!job) return <div className="pivot-result-empty"><Calculator size={34} /><h3>保存配置后开始计算</h3><p>所有分组和汇总都在 PostgreSQL 服务器完成。</p></div>;
  if (["pending", "computing"].includes(job.status)) return <div className="pivot-calculating"><LoaderCircle className="spin" size={30} /><h3>{statusNames[job.status]}</h3><div className="task-progress"><span style={{ width: `${job.progress || 0}%` }} /><strong>{job.progress || 0}%</strong></div><p>正在服务端处理 {formatNumber(job.source_records)} 条来源记录，页面不会下载全部数据。</p><ActionButton danger icon={X} onClick={async () => { await api(`/pivot-jobs/${job.id}/cancel`, { method: "POST" }); await load(job.id); }}>取消计算</ActionButton></div>;
  if (job.status === "failed") return <div className="pivot-result-empty"><AlertTriangle size={34} /><h3>计算失败</h3><p>{job.error_message || "请检查失效字段或缩小汇总范围。"}</p></div>;
  const rows = jobPage?.rows || [];
  return <div className="pivot-result-area"><div className="pivot-result-toolbar"><div><strong>{formatNumber(job.result_rows)} 行汇总结果</strong><small>{job.completed_at ? new Date(job.completed_at).toLocaleString("zh-CN") : ""}{job.cached ? " · 已使用缓存" : ""}{selected.dataUpdated ? " · 来源已变化，重新计算后可钻取" : ""}</small></div><ActionButton icon={Download} onClick={() => setExporting(true)}>导出结果</ActionButton></div><div className="pivot-table-scroll"><table className="pivot-table"><thead><tr>{config.rows.map((item) => <th key={`r-${item.fieldId}`}>{fieldName(item.fieldId)}</th>)}{config.columns.map((item) => <th key={`c-${item.fieldId}`}>{fieldName(item.fieldId)}</th>)}{config.measures.map((item) => <th key={item.id}>{item.label}</th>)}</tr></thead><tbody>{rows.map((row) => <tr className={row.is_total ? "total" : ""} key={row.row_index}>{row.row_key.map((value, index) => <td key={`r${index}`}>{value ?? (row.is_total ? "合计" : config.empty.label)}</td>)}{row.column_key.map((value, index) => <td key={`c${index}`}>{value ?? (row.is_total ? "合计" : config.empty.label)}</td>)}{config.measures.map((measure) => <td key={measure.id}><button disabled={selected.dataUpdated} title={selected.dataUpdated ? "来源数据已更新，请先重新计算" : "查看原始记录"} onClick={() => openDrilldown(row)}>{formatNumber(row.values?.[measure.id])}</button></td>)}</tr>)}</tbody></table></div><footer className="pivot-pagination"><span>第 {formatNumber(offset + 1)}-{formatNumber(offset + rows.length)} 行</span><div><IconButton icon={ChevronLeft} label="上一页" disabled={offset === 0} onClick={() => load(job.id, Math.max(0, offset - 200))} /><IconButton icon={ChevronRight} label="下一页" disabled={!jobPage?.hasMore} onClick={() => load(job.id, offset + 200)} /></div></footer>{drilldown && <Drilldown row={drilldown.row} data={drilldown.data} onClose={() => setDrilldown(null)} />}{exporting && <ExportModal job={job} onClose={() => setExporting(false)} />}</div>;
}

function PivotWorkspace({ selected, fields, onSaved, onDeleted, onCopied }) {
  const [name, setName] = useState(selected.name);
  const [config, setConfig] = useState(selected.config || blankConfig());
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setName(selected.name); setConfig(selected.config || blankConfig()); setDirty(false); }, [selected.id, selected.updated_at]);
  function update(next) { setConfig(next); setDirty(true); }
  async function save() { setBusy(true); setError(""); try { await api(`/pivot-configs/${selected.id}`, { method: "PATCH", body: { name, config } }); setDirty(false); await onSaved(selected.id); } catch (err) { setError(err.message); } finally { setBusy(false); } }
  async function calculate() { setBusy(true); setError(""); try { if (dirty || name !== selected.name) await api(`/pivot-configs/${selected.id}`, { method: "PATCH", body: { name, config } }); await api(`/pivot-configs/${selected.id}/calculate`, { method: "POST", body: {} }); setDirty(false); await onSaved(selected.id); } catch (err) { setError(err.message); } finally { setBusy(false); } }
  const valid = config.rows.every((item) => item.fieldId) && config.columns.every((item) => item.fieldId) && config.measures.every((item) => item.label && (item.aggregation === "count" || item.fieldId)) && config.filters.every((item) => item.fieldId);
  return <div className="pivot-workspace"><header className="pivot-workspace-header"><div><input value={name} onChange={(event) => { setName(event.target.value); setDirty(true); }} /><span>{selected.table_name} · {formatNumber(selected.sourceRecords)} 条来源数据</span></div><div>{selected.dataUpdated && <em className="data-updated">数据已更新</em>}<IconButton icon={Copy} label="复制方案" onClick={onCopied} /><IconButton icon={Trash2} label="删除方案" onClick={onDeleted} /><ActionButton icon={Save} disabled={!dirty || !valid || busy} onClick={save}>保存</ActionButton><ActionButton primary icon={Calculator} disabled={!valid || busy || selected.invalidFields?.length} onClick={calculate}>重新计算</ActionButton></div></header>{selected.invalidFields?.length > 0 && <Notice type="error"><strong>方案包含 {selected.invalidFields.length} 个已删除或失效字段</strong><p>请在左侧配置中移除失效项，再保存并重新计算。</p></Notice>}{error && <Notice type="error">{error}</Notice>}<div className="pivot-body"><aside className="pivot-editor">
    <ConfigSection title="行字段" count={config.rows.length} limit={5} onAdd={() => update({ ...config, rows: [...config.rows, { fieldId: "" }] })}>{config.rows.map((item, index) => <DimensionRow key={index} item={item} fields={fields} onChange={(next) => update({ ...config, rows: config.rows.map((row, rowIndex) => rowIndex === index ? next : row) })} onDelete={() => update({ ...config, rows: config.rows.filter((_, rowIndex) => rowIndex !== index) })} />)}</ConfigSection>
    <ConfigSection title="列字段" count={config.columns.length} limit={3} onAdd={() => update({ ...config, columns: [...config.columns, { fieldId: "" }] })}>{config.columns.map((item, index) => <DimensionRow key={index} item={item} fields={fields} onChange={(next) => update({ ...config, columns: config.columns.map((row, rowIndex) => rowIndex === index ? next : row) })} onDelete={() => update({ ...config, columns: config.columns.filter((_, rowIndex) => rowIndex !== index) })} />)}</ConfigSection>
    <ConfigSection title="数值指标" count={config.measures.length} limit={10} onAdd={() => update({ ...config, measures: [...config.measures, { id: `measure_${Date.now()}`, fieldId: null, aggregation: "count", label: "记录数" }] })}>{config.measures.map((item, index) => <MeasureRow key={item.id} item={item} fields={fields} onChange={(next) => update({ ...config, measures: config.measures.map((row, rowIndex) => rowIndex === index ? next : row) })} onDelete={() => config.measures.length > 1 && update({ ...config, measures: config.measures.filter((_, rowIndex) => rowIndex !== index) })} />)}</ConfigSection>
    <ConfigSection title="筛选条件" count={config.filters.length} limit={12} onAdd={() => update({ ...config, filters: [...config.filters, { fieldId: "", operator: "eq", value: "" }] })}><div className="filter-mode"><button className={config.filterMode === "all" ? "active" : ""} onClick={() => update({ ...config, filterMode: "all" })}>全部满足</button><button className={config.filterMode === "any" ? "active" : ""} onClick={() => update({ ...config, filterMode: "any" })}>任意满足</button></div>{config.filters.map((item, index) => <FilterRow key={index} item={item} fields={fields} onChange={(next) => update({ ...config, filters: config.filters.map((row, rowIndex) => rowIndex === index ? next : row) })} onDelete={() => update({ ...config, filters: config.filters.filter((_, rowIndex) => rowIndex !== index) })} />)}</ConfigSection>
    <section className="pivot-editor-section options"><header><strong>显示与排序</strong></header><div className="pivot-checks">{[["rows", "行合计"], ["columns", "列合计"], ["grand", "总计"], ["subtotals", "显示小计"]].map(([key, label]) => <label className="check" key={key}><input type="checkbox" checked={config.totals[key]} onChange={(event) => update({ ...config, totals: { ...config.totals, [key]: event.target.checked } })} />{label}</label>)}</div><div className="option-grid"><label>空值<select value={config.empty.mode} onChange={(event) => update({ ...config, empty: { ...config.empty, mode: event.target.value } })}><option value="separate">单独分组</option><option value="ignore">忽略空值</option><option value="custom">自定义名称</option></select></label>{config.empty.mode === "custom" && <label>空值名称<input value={config.empty.label} onChange={(event) => update({ ...config, empty: { ...config.empty, label: event.target.value } })} /></label>}<label>排序依据<select value={config.sort.by} onChange={(event) => update({ ...config, sort: { ...config.sort, by: event.target.value } })}><option value="name">名称</option><option value="count">数量</option>{config.measures.map((measure) => <option key={measure.id} value={measure.id}>{measure.label}</option>)}</select></label><label>顺序<select value={config.sort.direction} onChange={(event) => update({ ...config, sort: { ...config.sort, direction: event.target.value } })}><option value="asc">升序</option><option value="desc">降序</option></select></label></div></section>
  </aside><section className="pivot-result"><PivotResult selected={selected} fields={fields} config={config} onJobChanged={() => onSaved(selected.id)} /></section></div></div>;
}

export default function PivotPage({ base, tables }) {
  const [items, setItems] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selected, setSelected] = useState(null);
  const [schemas, setSchemas] = useState({});
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  async function load(preferred) {
    const rows = await api(`/bases/${base.id}/pivot-configs`); setItems(rows);
    const id = preferred || selectedId || rows[0]?.id || null; setSelectedId(rows.some((item) => item.id === id) ? id : rows[0]?.id || null); setLoading(false);
  }
  async function loadSelected(id = selectedId) { if (!id) return setSelected(null); const item = await api(`/pivot-configs/${id}`); setSelected(item); if (!schemas[item.table_id]) setSchemas((current) => ({ ...current, [item.table_id]: null })); const schema = await api(`/tables/${item.table_id}/schema`); setSchemas((current) => ({ ...current, [item.table_id]: schema })); }
  useEffect(() => { load(); Promise.all(tables.map(async (table) => [table.id, await api(`/tables/${table.id}/schema`)])).then((entries) => setSchemas(Object.fromEntries(entries))); }, [base.id]);
  useEffect(() => { loadSelected(); }, [selectedId]);
  async function deleteSelected() { if (!window.confirm(`删除数据透视方案“${selected.name}”？历史计算结果也会删除。`)) return; await api(`/pivot-configs/${selected.id}`, { method: "DELETE" }); setSelectedId(null); await load(); }
  async function copySelected() { const copy = await api(`/pivot-configs/${selected.id}/copy`, { method: "POST", body: { name: `${selected.name} 副本` } }); await load(copy.id); setSelectedId(copy.id); }
  if (loading) return <main className="content-page"><div className="loading"><LoaderCircle className="spin" />正在读取数据透视方案</div></main>;
  return <main className="content-page feature-page pivot-page"><div className="page-heading"><div><h1>数据透视</h1><p>在 PostgreSQL 服务端对大数据量进行分组、筛选和汇总。</p></div><div className="heading-actions"><ActionButton primary icon={Plus} disabled={!tables.length} onClick={() => setCreating(true)}>新建数据透视</ActionButton></div></div><div className="pivot-layout"><aside className="feature-list"><header><strong>已保存方案</strong><span>{items.length}</span></header>{items.map((item) => <button className={selectedId === item.id ? "active" : ""} onClick={() => setSelectedId(item.id)} key={item.id}><span><strong>{item.name}</strong><small>{item.table_name} · {formatNumber(item.sourceRecords)} 行</small></span>{item.dataUpdated ? <em className="warning">待更新</em> : item.job_status ? <em>{statusNames[item.job_status] || item.job_status}</em> : null}</button>)}{!items.length && <p>暂无数据透视方案</p>}</aside><section className="feature-main">{selected && schemas[selected.table_id] ? <PivotWorkspace selected={selected} fields={schemas[selected.table_id].fields} onSaved={async (id) => { await load(id); await loadSelected(id); }} onDeleted={deleteSelected} onCopied={copySelected} /> : <div className="feature-empty"><Table2 size={34} /><h3>建立第一个数据透视</h3><p>选择数据表后配置行、列、数值和筛选字段。</p></div>}</section></div>{creating && <CreatePivot base={base} tables={tables} schemas={schemas} onClose={() => setCreating(false)} onCreated={async (item) => { setCreating(false); await load(item.id); setSelectedId(item.id); }} />}</main>;
}
