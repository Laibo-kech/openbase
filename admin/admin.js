const state = { admin: null, page: "overview", modalSubmit: null };
const pages = {
  overview: ["系统概览", "运行状态与容量"],
  users: ["账号管理", "用户账号与数据使用情况"],
  projects: ["项目统计", "项目归属与数据规模"],
  audit: ["审计记录", "最近 200 条系统操作"],
};

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
