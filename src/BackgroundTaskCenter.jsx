import { useEffect, useMemo, useState } from "react";
import { CircleX, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import { api, formatNumber } from "./api.js";

const statusNames = {
  waiting: "等待中", running: "执行中", completed: "已完成", partial_success: "部分成功",
  failed: "失败", cancelled: "已取消", interrupted: "已中断",
};
const typeNames = {
  lookup_recalculation: "查找引用重新计算", catalog_match: "目录匹配", pivot_calculation: "数据透视计算",
};
const terminal = new Set(["completed", "partial_success", "failed", "cancelled", "interrupted"]);
const date = (value) => value ? new Date(value).toLocaleString("zh-CN") : "—";
const duration = (value) => {
  const ms = Number(value || 0);
  if (!ms) return "—";
  if (ms < 1000) return `${ms} 毫秒`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${(ms / 60000).toFixed(1)} 分钟`;
};

function TaskProgress({ task }) {
  return <div className="background-progress"><span style={{ width: `${task.progress || 0}%` }} /><strong>{task.progress || 0}%</strong></div>;
}

export default function BackgroundTaskCenter({ base }) {
  const [tasks, setTasks] = useState([]);
  const [status, setStatus] = useState("active");
  const [type, setType] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const statusQuery = status === "active" ? "waiting,running" : status === "all" ? "" : status;
  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "300" });
      if (statusQuery) params.set("status", statusQuery);
      if (type) params.set("type", type);
      setTasks(await api(`/bases/${base.id}/background-tasks?${params}`));
      setError("");
    } catch (failure) { setError(failure.message); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { load(); }, [base.id, status, type]);
  const hasActive = useMemo(() => tasks.some((task) => !terminal.has(task.status)), [tasks]);
  useEffect(() => {
    if (!hasActive && status !== "active") return undefined;
    const timer = setInterval(() => load(true), 1200);
    return () => clearInterval(timer);
  }, [base.id, status, type, hasActive]);
  async function action(task, name) {
    await api(`/background-tasks/${task.id}/${name}`, { method: "POST", body: {} });
    await load(true);
  }
  return <main className="content-page task-center-page">
    <div className="page-heading"><div><h1>任务中心</h1><p>计算在服务器后台继续执行，关闭页面不会中断任务。</p></div><button className="button" onClick={() => load()}><RefreshCw size={15} />刷新</button></div>
    <div className="task-filters">
      <label>任务状态<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">进行中</option><option value="all">全部</option>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>任务类型<select value={type} onChange={(event) => setType(event.target.value)}><option value="">全部类型</option>{Object.entries(typeNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <span>{formatNumber(tasks.length)} 个任务</span>
    </div>
    {error && <div className="feature-notice error">{error}</div>}
    <section className="task-table-wrap">
      <table className="task-table"><thead><tr><th>任务类型 / 数据表</th><th>创建账号</th><th>状态与进度</th><th>处理数量</th><th>开始时间</th><th>完成时间</th><th>耗时</th><th>操作</th></tr></thead>
      <tbody>{tasks.map((task) => <tr key={task.id}>
        <td><strong>{typeNames[task.task_type] || task.task_type}</strong><small>{task.table_name}</small></td>
        <td>{task.requested_by}</td>
        <td><em className={`task-status ${task.status}`}>{statusNames[task.status] || task.status}</em><TaskProgress task={task} />{task.error_message && <small title={task.error_message}>{task.error_message}</small>}</td>
        <td><strong>{formatNumber(task.processed_records)} / {formatNumber(task.total_records)}</strong><small>失败 {formatNumber(task.failed_records)}</small></td>
        <td>{date(task.started_at)}</td><td>{date(task.completed_at)}</td><td>{duration(task.duration_ms)}</td>
        <td><div className="task-actions">{["waiting", "running"].includes(task.status) && <button className="icon-button" title="取消任务" onClick={() => action(task, "cancel")}><CircleX size={16} /></button>}{["failed", "interrupted"].includes(task.status) && <button className="icon-button" title="失败重试" onClick={() => action(task, "retry")}><RotateCcw size={16} /></button>}</div></td>
      </tr>)}</tbody></table>
      {loading ? <div className="task-empty"><LoaderCircle className="spin" size={20} />正在读取任务</div> : !tasks.length && <div className="task-empty">当前筛选条件下没有任务</div>}
    </section>
  </main>;
}
