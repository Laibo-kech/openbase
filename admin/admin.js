const state = { admin: null, page: "overview", modalSubmit: null };
const pages = {
  overview: ["系统概览", "运行状态与容量"],
  users: ["账号管理", "用户账号与数据使用情况"],
  projects: ["项目统计", "项目归属与数据规模"],
  tasks: ["任务监控", "正在执行、等待中和失败的后台任务"],
  slowTasks: ["慢任务统计", "耗时最长的目录匹配和数据透视任务"],
  database: ["数据库监控", "连接、慢查询、后台任务、索引和磁盘"],
  audit: ["审计记录", "最近 200 条系统操作"],
};
const taskTypeNames = { lookup_recalculation: "查找引用", catalog_match: "目录匹配", pivot_calculation: "数据透视" };
const taskStatusNames = { waiting: "等待中", running: "执行中", completed: "已完成", partial_success: "部分成功", failed: "失败", cancelled: "已取消", interrupted: "已中断" };

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || `请求失败 (${response.status})`), { status: response.status, code: result.code });
  return result;
}

const number = (value) => new Intl.NumberFormat("zh-CN").format(Number(value || 0));
const bytes = (value) => {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
};
const date = (value) => value ? new Date(value).toLocaleString("zh-CN") : "从未";
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);

function showApp(admin) {
  state.admin = admin;
  document.querySelector("#login").hidden = true;
  document.querySelector("#app").hidden = false;
  document.querySelector("#admin-name").textContent = admin.username;
  render();
}

function showLogin() {
  state.admin = null;
  document.querySelector("#app").hidden = true;
  document.querySelector("#login").hidden = false;
}

function openModal(title, fields, onSubmit) {
  document.querySelector("#modal-title").textContent = title;
  document.querySelector("#modal-fields").innerHTML = fields;
  document.querySelector("#modal-error").textContent = "";
  state.modalSubmit = onSubmit;
  document.querySelector("#modal").hidden = false;
  document.querySelector("#modal-fields input")?.focus();
}

function closeModal() {
  document.querySelector("#modal").hidden = true;
  state.modalSubmit = null;
}

async function renderOverview() {
  const data = await api("/dashboard");
  const memoryUsed = Math.max(0, Number(data.memoryTotalBytes) - Number(data.memoryFreeBytes));
  const diskUsed = Math.max(0, Number(data.diskTotalBytes) - Number(data.diskFreeBytes));
  const memoryPercent = data.memoryTotalBytes ? Math.round(memoryUsed / Number(data.memoryTotalBytes) * 100) : 0;
  const diskPercent = data.diskTotalBytes ? Math.round(diskUsed / Number(data.diskTotalBytes) * 100) : 0;
  document.querySelector("#content").innerHTML = `
    <div class="metrics">
      <div class="metric"><span>用户账号</span><strong>${number(data.users)}</strong></div>
      <div class="metric"><span>项目</span><strong>${number(data.bases)}</strong></div>
      <div class="metric"><span>数据表</span><strong>${number(data.tables)}</strong></div>
      <div class="metric"><span>有效记录</span><strong>${number(data.records)}</strong></div>
    </div>
    <section class="section">
      <div class="section-heading"><h2>资源监控</h2><span class="muted">数据库连接 ${number(data.databaseConnections)}</span></div>
      <div class="resource-grid">
        <div class="resource-item"><header><span>服务器内存</span><strong>${memoryPercent}%</strong></header><div class="bar"><i style="width:${Math.min(memoryPercent,100)}%"></i></div><p class="muted">${bytes(memoryUsed)} / ${bytes(data.memoryTotalBytes)}</p></div>
        <div class="resource-item"><header><span>服务器磁盘</span><strong>${diskPercent}%</strong></header><div class="bar"><i style="width:${Math.min(diskPercent,100)}%"></i></div><p class="muted">${bytes(diskUsed)} / ${bytes(data.diskTotalBytes)}</p></div>
        <div class="resource-item"><header><span>数据库容量</span><strong>${bytes(data.databaseBytes)}</strong></header><div class="bar"><i style="width:12%"></i></div><p class="muted">运行 ${number(Math.floor(Number(data.processUptimeSeconds) / 60))} 分钟</p></div>
      </div>
    </section>
    <section class="section">
      <div class="section-heading"><h2>账号状态</h2></div>
      <div class="resource-grid">
        <div class="resource-item"><header><span>正常账号</span><strong>${number(data.active_users)}</strong></header></div>
        <div class="resource-item"><header><span>已禁用账号</span><strong>${number(data.disabled_users)}</strong></header></div>
        <div class="resource-item"><header><span>服务器负载</span><strong>${data.loadAverage.map((item) => Number(item).toFixed(2)).join(" / ")}</strong></header></div>
      </div>
    </section>`;
}

async function renderUsers() {
  const users = await api("/users");
  document.querySelector("#content").innerHTML = `
    <section class="section" style="margin-top:0">
      <div class="section-heading"><h2>全部账号</h2><button class="primary" id="create-user">新建账号</button></div>
      <table><thead><tr><th>用户名</th><th>状态</th><th>项目</th><th>数据表</th><th>记录</th><th>最近登录</th><th>操作</th></tr></thead>
      <tbody>${users.map((user) => `<tr data-user-id="${user.id}"><td><strong>${escape(user.username)}</strong><br><span class="muted">${escape(user.id)}</span></td><td><span class="status ${user.status === "disabled" ? "disabled" : ""}">${user.status === "active" ? "正常" : "已禁用"}</span></td><td>${number(user.base_count)}</td><td>${number(user.table_count)}</td><td>${number(user.record_count)}</td><td>${date(user.last_login_at)}</td><td><div class="actions"><button data-action="rename">改名</button><button data-action="password">重置密码</button><button class="${user.status === "active" ? "danger" : ""}" data-action="status">${user.status === "active" ? "禁用" : "启用"}</button></div></td></tr>`).join("")}</tbody></table>
    </section>`;
  document.querySelector("#create-user").onclick = () => openModal("新建用户账号", `
    <label>用户名<input name="username" required minlength="2" maxlength="32" /></label>
    <label>初始密码<input name="password" type="password" required minlength="8" maxlength="128" /></label>`, async (form) => {
      await api("/users", { method: "POST", body: Object.fromEntries(form) }); closeModal(); renderUsers();
    });
  document.querySelectorAll("tbody tr").forEach((row) => {
    const user = users.find((item) => item.id === row.dataset.userId);
    row.querySelector('[data-action="rename"]').onclick = () => openModal("修改用户名", `<label>用户名<input name="username" value="${escape(user.username)}" required minlength="2" maxlength="32" /></label>`, async (form) => {
      await api(`/users/${user.id}`, { method: "PATCH", body: { username: form.get("username") } }); closeModal(); renderUsers();
    });
    row.querySelector('[data-action="password"]').onclick = () => openModal("重置用户密码", `<label>新密码<input name="password" type="password" required minlength="8" maxlength="128" /></label>`, async (form) => {
      await api(`/users/${user.id}/reset-password`, { method: "POST", body: { password: form.get("password") } }); closeModal(); renderUsers();
    });
    row.querySelector('[data-action="status"]').onclick = async () => {
      await api(`/users/${user.id}`, { method: "PATCH", body: { status: user.status === "active" ? "disabled" : "active" } }); renderUsers();
    };
  });
}

async function renderProjects() {
  const projects = await api("/projects");
  document.querySelector("#content").innerHTML = `<section class="section" style="margin-top:0"><div class="section-heading"><h2>全部项目</h2><span class="muted">${number(projects.length)} 个</span></div><table><thead><tr><th>项目</th><th>所属账号</th><th>数据表</th><th>有效记录</th><th>最近更新</th></tr></thead><tbody>${projects.map((project) => `<tr><td><strong>${escape(project.name)}</strong></td><td>${escape(project.owner_username)}</td><td>${number(project.table_count)}</td><td>${number(project.record_count)}</td><td>${date(project.updated_at)}</td></tr>`).join("")}</tbody></table></section>`;
}

async function renderTasks() {
  const tasks = await api("/tasks?status=waiting,running,failed&limit=300");
  document.querySelector("#content").innerHTML = `<section class="section" style="margin-top:0"><div class="section-heading"><h2>后台任务</h2><span class="muted">${number(tasks.length)} 个</span></div><table><thead><tr><th>任务</th><th>项目 / 数据表</th><th>创建账号</th><th>状态</th><th>进度</th><th>处理 / 失败</th><th>开始时间</th><th>操作</th></tr></thead><tbody>${tasks.map((task) => `<tr data-task-id="${task.id}"><td><strong>${escape(taskTypeNames[task.task_type] || task.task_type)}</strong><br><span class="muted">${escape(task.id)}</span></td><td>${escape(task.base_name)}<br><span class="muted">${escape(task.table_name)}</span></td><td>${escape(task.account_name || task.requested_by)}</td><td><span class="status ${task.status === "failed" ? "disabled" : ""}">${escape(taskStatusNames[task.status] || task.status)}</span></td><td><div class="admin-progress"><i style="width:${Math.min(100,Number(task.progress || 0))}%"></i><span>${number(task.progress)}%</span></div></td><td>${number(task.processed_records)} / ${number(task.total_records)}<br><span class="muted">失败 ${number(task.failed_records)}</span></td><td>${date(task.started_at)}</td><td><div class="actions">${["waiting", "running"].includes(task.status) ? '<button class="danger" data-action="cancel">取消</button>' : ""}${task.status === "failed" ? '<button data-action="retry">重试</button>' : ""}</div></td></tr>`).join("")}</tbody></table>${tasks.length ? "" : '<div class="empty">当前没有等待中、执行中或失败的任务</div>'}</section>`;
  document.querySelectorAll("[data-task-id]").forEach((row) => {
    row.querySelector('[data-action="cancel"]')?.addEventListener("click", async () => { await api(`/tasks/${row.dataset.taskId}/cancel`, { method: "POST", body: {} }); renderTasks(); });
    row.querySelector('[data-action="retry"]')?.addEventListener("click", async () => { await api(`/tasks/${row.dataset.taskId}/retry`, { method: "POST", body: {} }); renderTasks(); });
  });
}

async function renderSlowTasks() {
  const tasks = await api("/slow-tasks");
  const elapsed = (value) => Number(value || 0) < 60000 ? `${(Number(value || 0) / 1000).toFixed(1)} 秒` : `${(Number(value || 0) / 60000).toFixed(1)} 分钟`;
  document.querySelector("#content").innerHTML = `<section class="section" style="margin-top:0"><div class="section-heading"><h2>耗时排行</h2><span class="muted">最近 ${number(tasks.length)} 个任务</span></div><table><thead><tr><th>排名</th><th>任务类型</th><th>项目 / 数据表</th><th>创建账号</th><th>处理数量</th><th>耗时</th><th>完成时间</th></tr></thead><tbody>${tasks.map((task, index) => `<tr><td><strong>${index + 1}</strong></td><td>${escape(taskTypeNames[task.task_type] || task.task_type)}</td><td>${escape(task.base_name)}<br><span class="muted">${escape(task.table_name)}</span></td><td>${escape(task.requested_by)}</td><td>${number(task.processed_records)}</td><td><strong>${elapsed(task.duration_ms)}</strong></td><td>${date(task.completed_at)}</td></tr>`).join("")}</tbody></table>${tasks.length ? "" : '<div class="empty">尚无已完成的目录匹配或数据透视任务</div>'}</section>`;
}

async function renderDatabase() {
  const data = await api("/database-monitor");
  const diskUsed = Number(data.diskTotalBytes) - Number(data.diskFreeBytes);
  const diskPercent = data.diskTotalBytes ? Math.round(diskUsed / Number(data.diskTotalBytes) * 100) : 0;
  document.querySelector("#content").innerHTML = `<div class="metrics"><div class="metric"><span>数据库容量</span><strong>${bytes(data.database_bytes)}</strong></div><div class="metric"><span>有效记录</span><strong>${number(data.records)}</strong></div><div class="metric"><span>数据库连接</span><strong>${number(data.connections.reduce((sum,item) => sum + Number(item.count),0))}</strong></div><div class="metric"><span>磁盘使用率</span><strong>${diskPercent}%</strong></div></div>
  <section class="section"><div class="section-heading"><h2>连接与后台任务</h2></div><div class="resource-grid"><div class="resource-item"><header><span>连接状态</span><strong>${data.connections.map((item) => `${escape(item.state)} ${number(item.count)}`).join(" · ") || "无"}</strong></header></div><div class="resource-item"><header><span>任务状态</span><strong>${data.tasks.map((item) => `${escape(taskStatusNames[item.status] || item.status)} ${number(item.count)}`).join(" · ") || "无"}</strong></header></div><div class="resource-item"><header><span>字段索引</span><strong>${data.indexes.map((item) => `${escape(item.status)} ${number(item.count)}`).join(" · ") || "无"}</strong></header></div></div></section>
  <section class="section"><div class="section-heading"><h2>当前慢查询</h2><span class="muted">执行超过 1 秒</span></div><table><thead><tr><th>进程</th><th>账号</th><th>状态</th><th>执行时间</th><th>SQL 摘要</th></tr></thead><tbody>${data.slowQueries.map((query) => `<tr><td>${number(query.pid)}</td><td>${escape(query.usename)}</td><td>${escape(query.state)}</td><td>${query.duration_seconds} 秒</td><td><code>${escape(query.query)}</code></td></tr>`).join("")}</tbody></table>${data.slowQueries.length ? "" : '<div class="empty">当前没有执行超过 1 秒的查询</div>'}</section>`;
}

async function renderAudit() {
  const logs = await api("/audit");
  document.querySelector("#content").innerHTML = `<section class="section" style="margin-top:0"><div class="section-heading"><h2>最近操作</h2><span class="muted">${number(logs.length)} 条</span></div><table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>来源 IP</th></tr></thead><tbody>${logs.map((log) => `<tr><td>${date(log.created_at)}</td><td>${escape(log.actor)}</td><td>${escape(log.action)}</td><td>${escape(log.object_type)} ${escape(log.object_id || "")}</td><td>${escape(log.ip || "-")}</td></tr>`).join("")}</tbody></table></section>`;
}

async function render() {
  const [title, subtitle] = pages[state.page];
  document.querySelector("#page-title").textContent = title;
  document.querySelector("#page-subtitle").textContent = subtitle;
  document.querySelectorAll("nav button").forEach((button) => button.classList.toggle("active", button.dataset.page === state.page));
  document.querySelector("#content").innerHTML = '<div class="empty">正在读取数据</div>';
  try {
    if (state.page === "overview") await renderOverview();
    else if (state.page === "users") await renderUsers();
    else if (state.page === "projects") await renderProjects();
    else if (state.page === "tasks") await renderTasks();
    else if (state.page === "slowTasks") await renderSlowTasks();
    else if (state.page === "database") await renderDatabase();
    else await renderAudit();
  } catch (error) {
    if (error.status === 401) showLogin();
    else document.querySelector("#content").innerHTML = `<div class="empty">${escape(error.message)}</div>`;
  }
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.querySelector("#login-error");
  error.textContent = "";
  try {
    const admin = await api("/auth/login", { method: "POST", body: { username: document.querySelector("#login-username").value, password: document.querySelector("#login-password").value } });
    document.querySelector("#login-password").value = "";
    showApp(admin);
  } catch (failure) { error.textContent = failure.message; }
});
document.querySelectorAll("nav button").forEach((button) => button.onclick = () => { state.page = button.dataset.page; render(); });
document.querySelector("#logout").onclick = async () => { try { await api("/auth/logout", { method: "POST" }); } finally { showLogin(); } };
document.querySelector("#modal-close").onclick = closeModal;
document.querySelector("#modal-cancel").onclick = closeModal;
document.querySelector("#modal-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.querySelector("#modal-error");
  error.textContent = "";
  try { await state.modalSubmit?.(new FormData(event.currentTarget)); } catch (failure) { error.textContent = failure.message; }
});

api("/auth/me").then(showApp).catch(showLogin);
