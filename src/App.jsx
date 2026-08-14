import { useEffect, useMemo, useState } from "react";
import {
  ArchiveRestore,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Columns3,
  Database,
  Download,
  FileDown,
  FileSpreadsheet,
  Filter,
  GripVertical,
  Grid2X2,
  HelpCircle,
  LoaderCircle,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api, formatBytes, formatNumber, publicPath } from "./api.js";

const fieldTypes = [
  ["text", "文本"],
  ["number", "数字"],
  ["date", "日期"],
  ["select", "单选"],
  ["relation", "关联记录"],
  ["lookup", "查找引用"],
];
const emptyFilter = () => ({ fieldId: "", operator: "eq", value: "" });

function Button({
  children,
  primary,
  danger,
  icon: Icon,
  className = "",
  ...props
}) {
  return (
    <button
      className={`button ${primary ? "primary" : ""} ${danger ? "danger" : ""} ${className}`}
      {...props}
    >
      {Icon && <Icon size={15} />}
      {children}
    </button>
  );
}

function Modal({ title, children, onClose, footer }) {
  return (
    <div className="overlay">
      <section className="modal" role="dialog" aria-modal="true">
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </div>
  );
}

function RenameModal({ title, initialValue, onClose, onSave }) {
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      await onSave(value.trim());
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button primary disabled={!value.trim() || saving} onClick={save}>
            {saving ? "保存中" : "保存"}
          </Button>
        </>
      }
    >
      <label>
        新名称
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoFocus
          onKeyDown={(event) => event.key === "Enter" && value.trim() && save()}
        />
      </label>
    </Modal>
  );
}

function ContextMenu({ x, y, onClose, onRename }) {
  useEffect(() => {
    const close = () => onClose();
    const escape = (event) => event.key === "Escape" && onClose();
    window.addEventListener("click", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", escape);
    };
  }, [onClose]);
  return (
    <div
      className="context-menu"
      style={{
        left: Math.min(x, window.innerWidth - 180),
        top: Math.min(y, window.innerHeight - 70),
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <button onClick={onRename}>
        <Pencil size={14} />
        重命名
      </button>
    </div>
  );
}

function Empty({ icon: Icon = Database, title, description, action }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={30} />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

function Login({ onLogin }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  function changeMode(nextMode) {
    setMode(nextMode);
    setError("");
    setPassword("");
    setConfirmPassword("");
  }
  async function submit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);
    if (mode === "register" && password !== confirmPassword) {
      setError("两次输入的密码不一致");
      setLoading(false);
      return;
    }
    try {
      onLogin(
        await api(`/auth/${mode}`, {
          method: "POST",
          body: { username, password },
        }),
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <main className="login-page">
      <div className="login-brand">
        <h1>多维数据库</h1>
        <p>面向大数据量的可扩展表格工作台</p>
      </div>
      <form className="login-panel" onSubmit={submit}>
        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => changeMode("login")}
          >
            登录
          </button>
          <button
            type="button"
            className={mode === "register" ? "active" : ""}
            onClick={() => changeMode("register")}
          >
            注册
          </button>
        </div>
        <h2>{mode === "login" ? "登录账号" : "注册账号"}</h2>
        <p>
          {mode === "login"
            ? "进入你的私有数据工作区"
            : "注册名保持唯一，注册后自动登录"}
        </p>
        <label>
          账号
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            minLength="2"
            maxLength="32"
            required
          />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={
              mode === "login" ? "current-password" : "new-password"
            }
            minLength="8"
            required
          />
        </label>
        {mode === "register" && (
          <label>
            确认密码
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              minLength="8"
              required
            />
          </label>
        )}
        {error && (
          <div className="alert error">
            <CircleAlert size={15} />
            {error}
          </div>
        )}
        <div className="login-options">
          <span>
            {mode === "login" ? "账号数据彼此隔离" : "仅创建普通用户账号"}
          </span>
          <span>私有服务器</span>
        </div>
        <Button primary disabled={loading}>
          {loading && <LoaderCircle className="spin" size={15} />}
          {loading ? "正在处理" : mode === "login" ? "登录" : "注册并进入"}
        </Button>
        <small>服务器地址：当前访问地址</small>
      </form>
      <span className="version">V1 · 私有部署</span>
    </main>
  );
}

function Topbar({ base, user, onBack, onLogout }) {
  return (
    <header className="topbar">
      <div className="logo-mark">
        <Database size={16} />
      </div>
      <strong>多维数据库</strong>
      {base && (
        <>
          <button className="back-button" onClick={onBack} title="返回项目列表">
            <ArrowLeft size={15} />
            返回项目
          </button>
          <span className="crumb">{base.name}</span>
        </>
      )}
      <div className="top-actions">
        <span className="saved">已保存</span>
        <button className="icon-button" title="帮助">
          <HelpCircle size={17} />
        </button>
        <button className="avatar" title={user.username}>
          {user.username.slice(0, 1)}
        </button>
        <button className="icon-button" onClick={onLogout} title="退出登录">
          <LogOut size={16} />
        </button>
      </div>
    </header>
  );
}

function Bases({ user, onLogout, onOpen }) {
  const [bases, setBases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [create, setCreate] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [menu, setMenu] = useState(null);
  const [renaming, setRenaming] = useState(null);
  async function load() {
    setLoading(true);
    try {
      setBases(await api("/bases"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);
  async function createBase() {
    const base = await api("/bases", { method: "POST", body: form });
    setCreate(false);
    setForm({ name: "", description: "" });
    await load();
    onOpen(base);
  }
  async function renameBase(name) {
    await api(`/bases/${renaming.id}`, { method: "PATCH", body: { name } });
    setRenaming(null);
    await load();
  }
  const visible = bases.filter((base) =>
    base.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="page">
      <Topbar user={user} onLogout={onLogout} />
      <main className="bases-content">
        <div className="page-heading">
          <div>
            <h1>我的项目</h1>
            <p>{bases.length} 个项目</p>
          </div>
          <Button primary icon={Plus} onClick={() => setCreate(true)}>
            新建项目
          </Button>
        </div>
        <div className="search-box">
          <Search size={15} />
          <input
            placeholder="搜索项目"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <h2 className="section-title">最近打开</h2>
        {loading ? (
          <div className="loading">
            <LoaderCircle className="spin" />
            正在读取项目
          </div>
        ) : visible.length ? (
          <div className="project-grid">
            {visible.map((base, index) => (
              <article
                className="project-card"
                key={base.id}
                role="button"
                tabIndex="0"
                onClick={() => onOpen(base)}
                onKeyDown={(event) => event.key === "Enter" && onOpen(base)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ item: base, x: event.clientX, y: event.clientY });
                }}
                title="右键可重命名"
              >
                <span className={`project-icon tone-${index % 4}`}>
                  <Database size={20} />
                </span>
                <div>
                  <h3>{base.name}</h3>
                  <p>
                    {base.table_count} 张表 · {formatNumber(base.record_count)}{" "}
                    行
                  </p>
                </div>
                <small>
                  {new Date(base.updated_at).toLocaleString("zh-CN")}
                </small>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            title="还没有项目"
            description="创建第一个项目，开始建立数据表。"
            action={
              <Button primary icon={Plus} onClick={() => setCreate(true)}>
                新建项目
              </Button>
            }
          />
        )}
      </main>
      {menu && (
        <ContextMenu
          {...menu}
          onClose={() => setMenu(null)}
          onRename={() => {
            setRenaming(menu.item);
            setMenu(null);
          }}
        />
      )}
      {renaming && (
        <RenameModal
          title="重命名项目"
          initialValue={renaming.name}
          onClose={() => setRenaming(null)}
          onSave={renameBase}
        />
      )}
      {create && (
        <Modal
          title="新建项目"
          onClose={() => setCreate(false)}
          footer={
            <>
              <Button onClick={() => setCreate(false)}>取消</Button>
              <Button primary disabled={!form.name.trim()} onClick={createBase}>
                创建项目
              </Button>
            </>
          }
        >
          <label>
            项目名称
            <input
              value={form.name}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
              placeholder="例如：销售数据中心"
              autoFocus
            />
          </label>
          <label>
            项目说明（可选）
            <textarea
              value={form.description}
              onChange={(event) =>
                setForm({ ...form, description: event.target.value })
              }
            />
          </label>
        </Modal>
      )}
    </div>
  );
}

function Sidebar({
  tables,
  tableId,
  section,
  onTable,
  onSection,
  onCreateTable,
  onRenameTable,
  onReorderTables,
}) {
  const [menu, setMenu] = useState(null);
  const [draggedId, setDraggedId] = useState(null);
  return (
    <aside className="sidebar">
      <span className="nav-label">数据表</span>
      {tables.map((table) => (
        <button
          key={table.id}
          draggable
          className={`nav-item table-nav-item ${section === "table" && table.id === tableId ? "active" : ""} ${draggedId === table.id ? "dragging" : ""}`}
          onDragStart={(event) => {
            setDraggedId(table.id);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", table.id);
          }}
          onDragEnd={() => setDraggedId(null)}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            event.preventDefault();
            const sourceId =
              event.dataTransfer.getData("text/plain") || draggedId;
            setDraggedId(null);
            if (sourceId && sourceId !== table.id)
              onReorderTables(sourceId, table.id);
          }}
          onClick={() => onTable(table.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ item: table, x: event.clientX, y: event.clientY });
          }}
          title="拖拽排序，右键重命名"
        >
          <GripVertical className="drag-handle" size={14} />
          <Grid2X2 size={14} />
          <span>{table.name}</span>
          <small>{formatNumber(table.record_count)}</small>
        </button>
      ))}
      <button className="nav-item create" onClick={onCreateTable}>
        <Plus size={14} />
        新建数据表
      </button>
      <span className="nav-label tools">工具</span>
      <button
        className={`nav-item ${section === "imports" ? "active" : ""}`}
        onClick={() => onSection("imports")}
      >
        <ArrowDownToLine size={14} />
        导入数据
      </button>
      <button
        className={`nav-item ${section === "exports" ? "active" : ""}`}
        onClick={() => onSection("exports")}
      >
        <ArrowUpFromLine size={14} />
        导出数据
      </button>
      <button
        className={`nav-item ${section === "recycle" ? "active" : ""}`}
        onClick={() => onSection("recycle")}
      >
        <Trash2 size={14} />
        回收站
      </button>
      <button
        className={`nav-item ${section === "settings" ? "active" : ""}`}
        onClick={() => onSection("settings")}
      >
        <Settings size={14} />
        项目设置
      </button>
      <button
        className={`nav-item ${section === "audit" ? "active" : ""}`}
        onClick={() => onSection("audit")}
      >
        <ShieldCheck size={14} />
        审计日志
      </button>
      <button
        className={`nav-item ${section === "system" ? "active" : ""}`}
        onClick={() => onSection("system")}
      >
        <Server size={14} />
        系统状态
      </button>
      {menu && (
        <ContextMenu
          {...menu}
          onClose={() => setMenu(null)}
          onRename={() => {
            onRenameTable(menu.item);
            setMenu(null);
          }}
        />
      )}
    </aside>
  );
}

function CellValue({ field, value }) {
  if (value === null || value === undefined || value === "")
    return <span className="muted">—</span>;
  if (field.type === "number") return <>¥ {formatNumber(value)}</>;
  if (field.type === "select")
    return (
      <span
        className={`tag tag-${String(value).includes("失") ? "red" : String(value).includes("成交") ? "green" : "blue"}`}
      >
        {value}
      </span>
    );
  if (field.type === "relation")
    return <span>{Array.isArray(value) ? `${value.length} 条` : value}</span>;
  return <>{String(value)}</>;
}

function FieldDrawer({ field, tableId, tables, fields, onClose, onSaved }) {
  const [name, setName] = useState(field?.name || "");
  const [type, setType] = useState(field?.type || "text");
  const [config, setConfig] = useState(field?.config || {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setSaving(true);
    setError("");
    try {
      if (field)
        await api(`/fields/${field.id}`, {
          method: "PATCH",
          body: { name, config },
        });
      else
        await api(`/tables/${tableId}/fields`, {
          method: "POST",
          body: { name, type, config },
        });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }
  function setOptions(text) {
    setConfig({
      ...config,
      options: text
        .split("\n")
        .map((label) => label.trim())
        .filter(Boolean)
        .map((label) => ({ label })),
    });
  }
  return (
    <div className="drawer-wrap">
      <button className="drawer-veil" onClick={onClose} aria-label="关闭" />
      <aside className="drawer">
        <header>
          <div>
            <h2>配置字段</h2>
            <p>{fieldTypes.find(([value]) => value === type)?.[1]}</p>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="drawer-body">
          <label>
            字段名称
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </label>
          <label>
            字段类型
            <select
              value={type}
              disabled={Boolean(field)}
              onChange={(event) => {
                setType(event.target.value);
                setConfig({});
              }}
            >
              {fieldTypes.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {type === "text" && (
            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(config.multiline)}
                onChange={(event) =>
                  setConfig({ ...config, multiline: event.target.checked })
                }
              />
              允许多行文本
            </label>
          )}
          {type === "number" && (
            <>
              <label>
                小数位数
                <input
                  type="number"
                  min="0"
                  max="8"
                  value={config.decimals ?? 2}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      decimals: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={config.currency === "CNY"}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      currency: event.target.checked ? "CNY" : null,
                    })
                  }
                />
                显示人民币符号
              </label>
            </>
          )}
          {type === "date" && (
            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(config.includeTime)}
                onChange={(event) =>
                  setConfig({ ...config, includeTime: event.target.checked })
                }
              />
              包含具体时间
            </label>
          )}
          {type === "select" && (
            <label>
              选项（每行一个）
              <textarea
                rows="8"
                value={(config.options || [])
                  .map((item) => item.label || item)
                  .join("\n")}
                onChange={(event) => setOptions(event.target.value)}
              />
            </label>
          )}
          {type === "relation" && (
            <label>
              关联数据表
              <select
                value={config.targetTableId || ""}
                onChange={(event) =>
                  setConfig({ ...config, targetTableId: event.target.value })
                }
              >
                <option value="">请选择</option>
                {tables.map((table) => (
                  <option key={table.id} value={table.id}>
                    {table.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {type === "lookup" && (
            <>
              <label>
                通过关联字段
                <select
                  value={config.relationFieldId || ""}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      relationFieldId: event.target.value,
                    })
                  }
                >
                  <option value="">请选择</option>
                  {fields
                    .filter((item) => item.type === "relation")
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                目标字段 ID
                <input
                  value={config.targetFieldId || ""}
                  onChange={(event) =>
                    setConfig({ ...config, targetFieldId: event.target.value })
                  }
                />
              </label>
              <label>
                聚合方式
                <select
                  value={config.aggregation || "first"}
                  onChange={(event) =>
                    setConfig({ ...config, aggregation: event.target.value })
                  }
                >
                  <option value="first">第一条</option>
                  <option value="sum">求和</option>
                  <option value="count">计数</option>
                </select>
              </label>
            </>
          )}
          {error && <div className="alert error">{error}</div>}
        </div>
        <footer>
          <Button onClick={onClose}>取消</Button>
          <Button primary disabled={saving || !name.trim()} onClick={save}>
            {saving ? "保存中" : "保存字段"}
          </Button>
        </footer>
      </aside>
    </div>
  );
}

function RecordDrawer({ record, fields, tableId, onClose, onSaved }) {
  const [values, setValues] = useState(record?.values || {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  function input(field) {
    const value = values[field.id] ?? "";
    const common = {
      value,
      onChange: (event) =>
        setValues({ ...values, [field.id]: event.target.value }),
    };
    if (field.type === "select")
      return (
        <select {...common}>
          <option value="">请选择</option>
          {(field.config?.options || []).map((item) => (
            <option key={item.label || item}>{item.label || item}</option>
          ))}
        </select>
      );
    if (field.type === "date")
      return (
        <input
          type={field.config?.includeTime ? "datetime-local" : "date"}
          {...common}
        />
      );
    if (field.type === "number")
      return <input type="number" step="any" {...common} />;
    if (field.type === "lookup") return <input value={value} readOnly />;
    return field.config?.multiline ? (
      <textarea {...common} />
    ) : (
      <input {...common} />
    );
  }
  async function save() {
    setSaving(true);
    setError("");
    try {
      if (record)
        await api(`/records/${record.id}`, {
          method: "PATCH",
          body: { values, version: record.version },
        });
      else
        await api(`/tables/${tableId}/records`, {
          method: "POST",
          body: { values },
        });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="drawer-wrap">
      <button className="drawer-veil" onClick={onClose} />
      <aside className="drawer">
        <header>
          <div>
            <h2>{record ? `记录 #${record.id}` : "新增记录"}</h2>
            <p>{record ? "编辑记录详情" : "填写字段值"}</p>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="drawer-body">
          {fields.map((field) => (
            <label key={field.id}>
              {field.name}
              <small>
                {fieldTypes.find(([value]) => value === field.type)?.[1]}
              </small>
              {input(field)}
            </label>
          ))}
          {error && <div className="alert error">{error}</div>}
        </div>
        <footer>
          <Button onClick={onClose}>取消</Button>
          <Button primary disabled={saving} onClick={save}>
            {saving ? "保存中" : "保存修改"}
          </Button>
        </footer>
      </aside>
    </div>
  );
}

function FilterEditor({ fields, filters, onChange, compact = false }) {
  const usableFields = fields.filter((field) => field.type !== "lookup");
  function update(index, patch) {
    onChange(
      filters.map((filter, current) =>
        current === index ? { ...filter, ...patch } : filter,
      ),
    );
  }
  function remove(index) {
    const next = filters.filter((_, current) => current !== index);
    onChange(next.length ? next : [emptyFilter()]);
  }
  return (
    <div className={`filter-editor ${compact ? "compact" : ""}`}>
      {filters.map((filter, index) => (
        <div className="filter-row" key={index}>
          <select
            aria-label={`筛选字段 ${index + 1}`}
            value={filter.fieldId}
            onChange={(event) => update(index, { fieldId: event.target.value })}
          >
            <option value="">选择字段</option>
            {usableFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
          <select
            aria-label={`筛选方式 ${index + 1}`}
            value={filter.operator}
            onChange={(event) =>
              update(index, { operator: event.target.value })
            }
          >
            <option value="eq">等于</option>
            <option value="contains">包含</option>
            <option value="gt">大于</option>
            <option value="gte">大于等于</option>
            <option value="lt">小于</option>
            <option value="lte">小于等于</option>
          </select>
          <input
            aria-label={`筛选值 ${index + 1}`}
            value={filter.value}
            onChange={(event) => update(index, { value: event.target.value })}
            placeholder="条件值"
          />
          <button
            className="icon-button"
            title="删除条件"
            onClick={() => remove(index)}
          >
            <X size={15} />
          </button>
        </div>
      ))}
      <button
        className="add-condition"
        onClick={() => onChange([...filters, emptyFilter()])}
      >
        <Plus size={14} />
        添加条件
      </button>
    </div>
  );
}

function validFilters(filters) {
  return filters.filter((filter) => filter.fieldId && filter.value !== "");
}

function Workbench({ tables, tableId, onReloadTables }) {
  const [schema, setSchema] = useState(null);
  const [data, setData] = useState({ records: [], total: 0, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [after, setAfter] = useState("0");
  const [history, setHistory] = useState([]);
  const [search, setSearch] = useState("");
  const [activeViewId, setActiveViewId] = useState(null);
  const [filters, setFilters] = useState([]);
  const [filterDraft, setFilterDraft] = useState([emptyFilter()]);
  const [columnWidths, setColumnWidths] = useState({});
  const [fieldDrawer, setFieldDrawer] = useState(null);
  const [recordDrawer, setRecordDrawer] = useState(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [createView, setCreateView] = useState(false);
  const [viewName, setViewName] = useState("");

  async function fetchRecords(cursor, selectedFilters) {
    const query = validFilters(selectedFilters);
    const suffix = query.length
      ? `&filters=${encodeURIComponent(JSON.stringify(query))}`
      : "";
    return api(`/tables/${tableId}/records?limit=100&after=${cursor}${suffix}`);
  }

  async function initialize() {
    if (!tableId) return;
    setLoading(true);
    try {
      const current = await api(`/tables/${tableId}/schema`);
      const firstView = current.views[0];
      const selectedFilters = firstView?.config?.filters || [];
      setSchema(current);
      setActiveViewId(firstView?.id || null);
      setFilters(selectedFilters);
      setFilterDraft(
        selectedFilters.length ? selectedFilters : [emptyFilter()],
      );
      setColumnWidths(firstView?.config?.columnWidths || {});
      setData(await fetchRecords("0", selectedFilters));
      setAfter("0");
      setHistory([]);
      setSearch("");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    initialize();
  }, [tableId]);
  useEffect(() => {
    const tabs = document.querySelector(".view-tabs");
    if (!tabs || !schema) return undefined;
    const renameFromContextMenu = async (event) => {
      const button = event.target.closest("button");
      const index = [...tabs.querySelectorAll(":scope > button")].indexOf(
        button,
      );
      const view = schema.views[index];
      if (!view) return;
      event.preventDefault();
      const name = window.prompt("重命名视图", view.name)?.trim();
      if (!name || name === view.name) return;
      const updated = await api(`/views/${view.id}`, {
        method: "PATCH",
        body: { name },
      });
      setSchema((current) => ({
        ...current,
        views: current.views.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      }));
    };
    tabs.addEventListener("contextmenu", renameFromContextMenu);
    return () => tabs.removeEventListener("contextmenu", renameFromContextMenu);
  }, [schema]);

  const activeView = schema?.views.find((view) => view.id === activeViewId);
  const visibleRecords = useMemo(
    () =>
      data.records.filter(
        (record) =>
          !search ||
          Object.values(record.values || {}).some((value) =>
            String(value ?? "")
              .toLowerCase()
              .includes(search.toLowerCase()),
          ),
      ),
    [data.records, search],
  );

  async function selectView(view) {
    const selectedFilters = view.config?.filters || [];
    setActiveViewId(view.id);
    setFilters(selectedFilters);
    setFilterDraft(selectedFilters.length ? selectedFilters : [emptyFilter()]);
    setColumnWidths(view.config?.columnWidths || {});
    setLoading(true);
    try {
      setData(await fetchRecords("0", selectedFilters));
      setAfter("0");
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }

  async function saveViewConfig(nextFilters, nextWidths = columnWidths) {
    if (!activeViewId) return;
    const updated = await api(`/views/${activeViewId}`, {
      method: "PATCH",
      body: {
        config: {
          filters: validFilters(nextFilters),
          columnWidths: nextWidths,
        },
      },
    });
    setSchema((current) => ({
      ...current,
      views: current.views.map((view) =>
        view.id === updated.id ? updated : view,
      ),
    }));
  }

  async function applyFilters() {
    const next = validFilters(filterDraft);
    setFilters(next);
    setFilterOpen(false);
    setLoading(true);
    try {
      await saveViewConfig(next);
      setData(await fetchRecords("0", next));
      setAfter("0");
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }

  async function clearFilters() {
    setFilterDraft([emptyFilter()]);
    setFilters([]);
    setFilterOpen(false);
    setLoading(true);
    try {
      await saveViewConfig([]);
      setData(await fetchRecords("0", []));
      setAfter("0");
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }

  async function addView() {
    const view = await api(`/tables/${tableId}/views`, {
      method: "POST",
      body: {
        name: viewName,
        config: { filters: validFilters(filters), columnWidths },
      },
    });
    setSchema((current) => ({ ...current, views: [...current.views, view] }));
    setActiveViewId(view.id);
    setViewName("");
    setCreateView(false);
  }

  function startResize(event, fieldId) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = Number(columnWidths[fieldId] || 190);
    let latest = startWidth;
    const move = (moveEvent) => {
      latest = Math.max(
        28,
        Math.min(2400, startWidth + moveEvent.clientX - startX),
      );
      setColumnWidths((current) => ({ ...current, [fieldId]: latest }));
    };
    const up = async () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const next = { ...columnWidths, [fieldId]: latest };
      setColumnWidths(next);
      await saveViewConfig(filters, next);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  async function nextPage() {
    if (!data.hasMore) return;
    setLoading(true);
    try {
      const cursor = data.nextAfter;
      setHistory([...history, after]);
      setAfter(cursor);
      setData(await fetchRecords(cursor, filters));
    } finally {
      setLoading(false);
    }
  }
  async function prevPage() {
    if (!history.length) return;
    setLoading(true);
    try {
      const cursor = history.at(-1);
      setHistory(history.slice(0, -1));
      setAfter(cursor);
      setData(await fetchRecords(cursor, filters));
    } finally {
      setLoading(false);
    }
  }
  async function refreshSchema() {
    const current = await api(`/tables/${tableId}/schema`);
    setSchema(current);
    setData(await fetchRecords(after, filters));
  }

  if (!schema)
    return (
      <div className="loading full">
        <LoaderCircle className="spin" />
        正在加载数据表
      </div>
    );
  const gridWidth =
    42 +
    schema.fields.reduce(
      (total, field) => total + Number(columnWidths[field.id] || 190),
      0,
    );
  return (
    <section className="workbench">
      <div className="view-tabs">
        {schema.views.map((view) => (
          <button
            key={view.id}
            className={view.id === activeViewId ? "active" : ""}
            onClick={() => selectView(view)}
          >
            {view.name}
            {view.config?.filters?.length ? (
              <span className="view-filter-count">
                {view.config.filters.length}
              </span>
            ) : null}
          </button>
        ))}
        <button
          onClick={() => {
            setViewName(`视图 ${schema.views.length + 1}`);
            setCreateView(true);
          }}
        >
          <Plus size={13} />
          新建视图
        </button>
      </div>
      <div className="toolbar">
        <Button
          primary
          icon={Plus}
          onClick={() => setRecordDrawer({ mode: "create" })}
        >
          新增记录
        </Button>
        <button
          className="tool-button"
          onClick={() => setFieldDrawer({ mode: "create" })}
        >
          <SlidersHorizontal size={14} />
          字段
        </button>
        <button
          className={`tool-button ${filterOpen ? "active" : ""}`}
          onClick={() => {
            setFilterDraft(filters.length ? filters : [emptyFilter()]);
            setFilterOpen(!filterOpen);
          }}
        >
          <Filter size={14} />
          筛选{filters.length ? ` (${filters.length})` : ""}
        </button>
        <div className="toolbar-spacer" />
        <div className="search-box compact">
          <Search size={14} />
          <input
            placeholder="搜索当前页"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <span className="row-count">{formatNumber(data.total)} 行</span>
      </div>
      {filterOpen && (
        <div className="filter-popover">
          <h3>{activeView?.name || "当前视图"}的筛选条件</h3>
          <p>满足以下全部条件，应用后自动保存到当前视图。</p>
          <FilterEditor
            fields={schema.fields}
            filters={filterDraft}
            onChange={setFilterDraft}
            compact
          />
          <footer>
            <Button onClick={clearFilters}>清除全部</Button>
            <Button primary onClick={applyFilters}>
              应用并保存
            </Button>
          </footer>
        </div>
      )}
      <div className="grid-scroll">
        <table className="data-grid" style={{ width: gridWidth }}>
          <colgroup>
            <col style={{ width: 42 }} />
            {schema.fields.map((field) => (
              <col
                key={field.id}
                style={{ width: Number(columnWidths[field.id] || 190) }}
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="check-col">
                <input type="checkbox" />
              </th>
              {schema.fields.map((field) => (
                <th
                  key={field.id}
                  style={{ width: Number(columnWidths[field.id] || 190) }}
                >
                  <button
                    className="field-head"
                    onClick={() => setFieldDrawer({ field })}
                  >
                    <span>{field.name}</span>
                    <small>
                      {fieldTypes.find(([value]) => value === field.type)?.[1]}
                    </small>
                    <ChevronDown size={12} />
                  </button>
                  <span
                    className="column-resizer"
                    onMouseDown={(event) => startResize(event, field.id)}
                    title="拖拽调整列宽"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 10 }, (_, index) => (
                  <tr key={index}>
                    <td colSpan={schema.fields.length + 1}>
                      <span className="skeleton" />
                    </td>
                  </tr>
                ))
              : visibleRecords.map((record) => (
                  <tr
                    key={record.id}
                    onDoubleClick={() => setRecordDrawer({ record })}
                  >
                    <td>
                      <input type="checkbox" />
                    </td>
                    {schema.fields.map((field) => (
                      <td key={field.id}>
                        <button
                          className="cell-button"
                          onClick={() => setRecordDrawer({ record })}
                        >
                          <CellValue
                            field={field}
                            value={record.values?.[field.id]}
                          />
                        </button>
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
        {!loading && !visibleRecords.length && (
          <Empty title="没有匹配记录" description="尝试清除搜索或筛选条件。" />
        )}
      </div>
      <div className="grid-footer">
        <span>每页最多 100 行 · 拖拽表头右边缘调整列宽</span>
        <div>
          <Button
            icon={ChevronLeft}
            onClick={prevPage}
            disabled={!history.length}
          >
            上一页
          </Button>
          <span>第 {history.length + 1} 页</span>
          <Button
            icon={ChevronRight}
            onClick={nextPage}
            disabled={!data.hasMore}
          >
            下一页
          </Button>
        </div>
      </div>
      {createView && (
        <Modal
          title="保存为新视图"
          onClose={() => setCreateView(false)}
          footer={
            <>
              <Button onClick={() => setCreateView(false)}>取消</Button>
              <Button primary disabled={!viewName.trim()} onClick={addView}>
                创建视图
              </Button>
            </>
          }
        >
          <label>
            视图名称
            <input
              value={viewName}
              onChange={(event) => setViewName(event.target.value)}
              autoFocus
            />
          </label>
          <div className="view-summary">
            <Columns3 size={18} />
            <div>
              <strong>将保存当前状态</strong>
              <p>
                {filters.length ? `${filters.length} 个筛选条件` : "无筛选条件"}
                ，以及每一列的当前宽度。
              </p>
            </div>
          </div>
        </Modal>
      )}
      {fieldDrawer && (
        <FieldDrawer
          field={fieldDrawer.field}
          tableId={tableId}
          tables={tables}
          fields={schema.fields}
          onClose={() => setFieldDrawer(null)}
          onSaved={() => {
            setFieldDrawer(null);
            refreshSchema();
          }}
        />
      )}
      {recordDrawer && (
        <RecordDrawer
          record={recordDrawer.record}
          fields={schema.fields}
          tableId={tableId}
          onClose={() => setRecordDrawer(null)}
          onSaved={() => {
            setRecordDrawer(null);
            fetchRecords(after, filters).then(setData);
            onReloadTables();
          }}
        />
      )}
    </section>
  );
}

function Imports({ base, tables, onChanged }) {
  const [jobs, setJobs] = useState([]);
  const [tableId, setTableId] = useState(tables[0]?.id || "");
  const [template, setTemplate] = useState(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  async function load() {
    setJobs(await api(`/bases/${base.id}/imports`));
  }
  useEffect(() => {
    load();
  }, [base.id]);
  useEffect(() => {
    setTemplate(null);
    if (tableId) api(`/tables/${tableId}/import-template`).then(setTemplate);
  }, [tableId]);
  async function submit() {
    if (!file || !tableId) return;
    setBusy(true);
    const body = new FormData();
    body.append("file", file);
    try {
      const value = await api(`/tables/${tableId}/import`, {
        method: "POST",
        body,
      });
      setResult(value);
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <ContentPage
      title="导入数据"
      subtitle="先下载当前数据表的专属模板，再填写并导入"
    >
      <div className="template-layout">
        <section className="selection-panel">
          <span className="panel-icon">
            <Grid2X2 size={20} />
          </span>
          <div>
            <h2>选择目标数据表</h2>
            <p>模板和导入任务只作用于选中的这一张表。</p>
          </div>
          <select
            value={tableId}
            onChange={(event) => {
              setTableId(event.target.value);
              setFile(null);
              setResult(null);
            }}
          >
            {tables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.name}
              </option>
            ))}
          </select>
        </section>
        <section className="template-panel">
          {template ? (
            <>
              <span className="panel-icon">
                <FileSpreadsheet size={21} />
              </span>
              <div className="template-copy">
                <h2>{template.tableName}专属导入模板</h2>
                <p>字段已自动生成，模板内置唯一导入 ID。</p>
                <code>{template.importId}</code>
              </div>
              <a
                className="button primary"
                href={publicPath(template.downloadUrl)}
              >
                <FileDown size={15} />
                下载模板
              </a>
            </>
          ) : (
            <div className="loading">
              <LoaderCircle className="spin" />
              正在生成模板
            </div>
          )}
        </section>
      </div>
      <div className="import-layout">
        <section className="upload-panel">
          <span className="upload-icon">
            <Upload size={26} />
          </span>
          <h2>上传填写后的模板</h2>
          <p>
            系统优先通过模板隐藏的字段 ID
            精确匹配，字段改名也不会导错列。兼容普通 CSV 和 XLSX。
          </p>
          <label className="file-drop">
            <FileSpreadsheet size={24} />
            <span>{file ? file.name : "点击选择 .xlsx 或 .csv 文件"}</span>
            <input
              type="file"
              accept=".xlsx,.csv"
              onChange={(event) => setFile(event.target.files[0])}
            />
          </label>
          <Button
            primary
            icon={Upload}
            disabled={!file || busy}
            onClick={submit}
          >
            {busy ? "正在校验并导入" : "开始导入"}
          </Button>
          {result && (
            <div className="alert success">
              完成：成功 {formatNumber(result.successRows)} 行，错误{" "}
              {formatNumber(result.errorRows)} 行
            </div>
          )}
        </section>
        <section className="list-panel">
          <h2>最近导入任务</h2>
          {jobs.length ? (
            jobs.map((job) => (
              <div className="job-row" key={job.id}>
                <div>
                  <strong>{job.filename}</strong>
                  <small>
                    {job.table_name} ·{" "}
                    {new Date(job.created_at).toLocaleString("zh-CN")}
                  </small>
                </div>
                <span
                  className={`status ${job.error_rows ? "warning" : "success"}`}
                >
                  {job.status}
                </span>
                <span>{formatNumber(job.total_rows)} 行</span>
                <span>成功 {formatNumber(job.success_rows)}</span>
                <span>异常 {formatNumber(job.error_rows)}</span>
              </div>
            ))
          ) : (
            <Empty
              title="暂无导入任务"
              description="上传文件后，执行记录会显示在这里。"
            />
          )}
        </section>
      </div>
    </ContentPage>
  );
}

function Exports({ base, tables }) {
  const [jobs, setJobs] = useState([]);
  const [tableId, setTableId] = useState(tables[0]?.id || "");
  const [schema, setSchema] = useState(null);
  const [filters, setFilters] = useState([emptyFilter()]);
  const [estimate, setEstimate] = useState(null);
  const [estimating, setEstimating] = useState(false);
  async function load() {
    setJobs(await api(`/bases/${base.id}/exports`));
  }
  useEffect(() => {
    load();
  }, [base.id]);
  useEffect(() => {
    setSchema(null);
    setFilters([emptyFilter()]);
    setEstimate(null);
    if (tableId) api(`/tables/${tableId}/schema`).then(setSchema);
  }, [tableId]);
  function changeFilters(next) {
    setFilters(next);
    setEstimate(null);
  }
  async function calculate() {
    setEstimating(true);
    try {
      setEstimate(
        await api(`/tables/${tableId}/export-estimate`, {
          method: "POST",
          body: { filters: validFilters(filters) },
        }),
      );
    } finally {
      setEstimating(false);
    }
  }
  function download() {
    const selected = validFilters(filters);
    const query = selected.length
      ? `?filters=${encodeURIComponent(JSON.stringify(selected))}`
      : "";
    window.location.href = publicPath(
      `/api/tables/${tableId}/export.csv${query}`,
    );
    setTimeout(load, 1200);
  }
  return (
    <ContentPage
      title="导出数据"
      subtitle="选择一张数据表，设置筛选条件，预估后再导出"
    >
      <section className="export-builder">
        <div className="export-table-select">
          <span className="panel-icon">
            <Grid2X2 size={20} />
          </span>
          <label>
            要导出的数据表
            <select
              value={tableId}
              onChange={(event) => setTableId(event.target.value)}
            >
              {tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.name}
                </option>
              ))}
            </select>
          </label>
          <p>只导出这张数据表，不会导出项目中的其他表。</p>
        </div>
        <div className="export-filter-block">
          <div className="block-heading">
            <div>
              <h2>筛选条件</h2>
              <p>满足以下全部条件；不填写条件时导出当前数据表全部记录。</p>
            </div>
            <span>{validFilters(filters).length} 个条件</span>
          </div>
          {schema ? (
            <FilterEditor
              fields={schema.fields}
              filters={filters}
              onChange={changeFilters}
            />
          ) : (
            <div className="loading">
              <LoaderCircle className="spin" />
              读取字段
            </div>
          )}
        </div>
        <div className="export-estimate">
          <div>
            <span>预计导出行数</span>
            <strong>
              {estimate ? formatNumber(estimate.totalRows) : "待预估"}
            </strong>
          </div>
          <div>
            <span>预计文件大小</span>
            <strong>
              {estimate ? formatBytes(estimate.estimatedBytes) : "待预估"}
            </strong>
          </div>
          <Button
            icon={RefreshCw}
            disabled={estimating || !schema}
            onClick={calculate}
          >
            {estimating ? "正在预估" : estimate ? "重新预估" : "预估导出"}
          </Button>
          <Button
            primary
            icon={Download}
            disabled={!estimate}
            onClick={download}
          >
            导出此数据表
          </Button>
        </div>
      </section>
      <section className="list-panel wide">
        <h2>最近导出任务</h2>
        {jobs.length ? (
          jobs.map((job) => (
            <div className="job-row export" key={job.id}>
              <FileSpreadsheet size={18} />
              <div>
                <strong>{job.filename}</strong>
                <small>
                  {job.table_name} ·{" "}
                  {new Date(job.created_at).toLocaleString("zh-CN")}
                </small>
              </div>
              <span className="status success">已完成</span>
              <span>{formatNumber(job.total_rows)} 行</span>
              <small>
                保留至 {new Date(job.expires_at).toLocaleDateString("zh-CN")}
              </small>
            </div>
          ))
        ) : (
          <Empty
            title="暂无导出任务"
            description="选择数据表并创建第一个导出文件。"
          />
        )}
      </section>
    </ContentPage>
  );
}

function Recycle({ base, onChanged }) {
  const [items, setItems] = useState([]);
  async function load() {
    setItems(await api(`/bases/${base.id}/recycle-bin`));
  }
  useEffect(() => {
    load();
  }, [base.id]);
  async function restore(item) {
    await api(`/recycle-bin/${item.type}/${item.id}/restore`, {
      method: "POST",
    });
    await load();
    onChanged();
  }
  return (
    <ContentPage title="回收站" subtitle="删除内容保留在数据库中，可恢复">
      <section className="list-panel wide">
        {items.length ? (
          items.map((item) => (
            <div className="job-row recycle" key={`${item.type}-${item.id}`}>
              <Trash2 size={17} />
              <div>
                <strong>
                  {item.type === "field" ? item.name : `记录 #${item.id}`}
                </strong>
                <small>
                  来自 {item.table_name} ·{" "}
                  {new Date(item.deleted_at).toLocaleString("zh-CN")}
                </small>
              </div>
              <span className="status warning">
                {item.type === "field" ? "字段" : "记录"}
              </span>
              <Button icon={ArchiveRestore} onClick={() => restore(item)}>
                恢复
              </Button>
            </div>
          ))
        ) : (
          <Empty
            icon={Trash2}
            title="回收站为空"
            description="已删除的字段和记录会显示在这里。"
          />
        )}
      </section>
    </ContentPage>
  );
}

function SettingsPage({ base, onChanged }) {
  const [form, setForm] = useState({
    name: base.name,
    description: base.description || "",
  });
  const [saved, setSaved] = useState(false);
  async function save() {
    await api(`/bases/${base.id}`, { method: "PATCH", body: form });
    setSaved(true);
    onChanged();
    setTimeout(() => setSaved(false), 2000);
  }
  return (
    <ContentPage title="项目设置" subtitle="管理项目名称、说明和运行约定">
      <section className="settings-panel">
        <h2>基本信息</h2>
        <label>
          项目名称
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </label>
        <label>
          项目说明
          <textarea
            value={form.description}
            onChange={(event) =>
              setForm({ ...form, description: event.target.value })
            }
          />
        </label>
        <div>
          <Button primary onClick={save}>
            保存设置
          </Button>
          {saved && <span className="saved-inline">已保存</span>}
        </div>
        <div className="setting-row">
          <div>
            <strong>软删除保护</strong>
            <p>删除字段和记录后先进入回收站。</p>
          </div>
          <span className="toggle on" />
        </div>
      </section>
    </ContentPage>
  );
}

function Audit({ base }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    api(`/bases/${base.id}/audit`).then(setRows);
  }, [base.id]);
  return (
    <ContentPage
      title="审计日志"
      subtitle="记录登录、结构变更、数据操作和导入导出"
    >
      <section className="list-panel wide">
        {rows.map((row) => (
          <div className="audit-row" key={row.id}>
            <time>{new Date(row.created_at).toLocaleString("zh-CN")}</time>
            <strong>{row.actor}</strong>
            <span className={row.action.includes("failed") ? "red" : "blue"}>
              {row.action}
            </span>
            <span>
              {row.object_type}
              {row.object_id ? ` ${row.object_id}` : ""}
            </span>
            <small>{row.ip || "服务器内部"}</small>
          </div>
        ))}
      </section>
    </ContentPage>
  );
}

function SystemStatus() {
  const [status, setStatus] = useState(null);
  async function load() {
    setStatus(await api("/system/status"));
  }
  useEffect(() => {
    load();
  }, []);
  return (
    <ContentPage
      title="系统状态"
      subtitle="服务器应用与 PostgreSQL 数据库运行概况"
      actions={
        <Button icon={RefreshCw} onClick={load}>
          刷新
        </Button>
      }
    >
      {status ? (
        <>
          <div className="healthy">
            <span />
            所有服务正常
          </div>
          <div className="status-grid">
            {[
              [
                "应用服务",
                "正常",
                `运行 ${Math.floor(status.uptimeSeconds / 3600)} 小时`,
              ],
              ["PostgreSQL", "正常", `${status.connections} 个连接`],
              ["数据容量", "正常", formatBytes(status.databaseBytes)],
              ["项目数量", "正常", `${status.bases} 个`],
              ["数据表", "正常", `${status.tables} 张`],
              ["有效记录", "正常", `${formatNumber(status.records)} 行`],
            ].map(([name, state, detail]) => (
              <section key={name}>
                <span className="dot" />
                <h2>{name}</h2>
                <strong>{state}</strong>
                <p>{detail}</p>
              </section>
            ))}
          </div>
        </>
      ) : (
        <div className="loading">
          <LoaderCircle className="spin" />
          正在获取状态
        </div>
      )}
    </ContentPage>
  );
}

function ContentPage({ title, subtitle, actions, children }) {
  return (
    <main className="content-page">
      <div className="page-heading">
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="heading-actions">{actions}</div>
      </div>
      {children}
    </main>
  );
}

function BaseApp({ user, initialBase, onBack, onLogout }) {
  const [base, setBase] = useState(initialBase);
  const [tables, setTables] = useState([]);
  const [tableId, setTableId] = useState(null);
  const [section, setSection] = useState("table");
  const [createTable, setCreateTable] = useState(false);
  const [tableName, setTableName] = useState("");
  const [renamingTable, setRenamingTable] = useState(null);
  async function loadTables(preferred) {
    const rows = await api(`/bases/${base.id}/tables`);
    setTables(rows);
    const id = preferred || tableId || rows[0]?.id || null;
    setTableId(rows.some((row) => row.id === id) ? id : rows[0]?.id || null);
  }
  async function refreshBase() {
    const rows = await api("/bases");
    const current = rows.find((item) => item.id === base.id);
    if (current) setBase(current);
  }
  useEffect(() => {
    loadTables();
  }, [base.id]);
  async function addTable() {
    const table = await api(`/bases/${base.id}/tables`, {
      method: "POST",
      body: { name: tableName },
    });
    setCreateTable(false);
    setTableName("");
    await loadTables(table.id);
    setSection("table");
  }
  async function renameTable(name) {
    await api(`/tables/${renamingTable.id}`, {
      method: "PATCH",
      body: { name },
    });
    setRenamingTable(null);
    await loadTables();
  }
  async function reorderTables(sourceId, targetId) {
    const sourceIndex = tables.findIndex((table) => table.id === sourceId);
    const targetIndex = tables.findIndex((table) => table.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const next = [...tables];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    setTables(next);
    try {
      await api(`/bases/${base.id}/tables/reorder`, {
        method: "PATCH",
        body: { tableIds: next.map((table) => table.id) },
      });
    } catch {
      await loadTables();
    }
  }
  return (
    <div className="page">
      <Topbar base={base} user={user} onBack={onBack} onLogout={onLogout} />
      <Sidebar
        tables={tables}
        tableId={tableId}
        section={section}
        onTable={(id) => {
          setTableId(id);
          setSection("table");
        }}
        onSection={setSection}
        onCreateTable={() => setCreateTable(true)}
        onRenameTable={setRenamingTable}
        onReorderTables={reorderTables}
      />
      {section === "table" && tableId ? (
        <Workbench
          tables={tables}
          tableId={tableId}
          onReloadTables={loadTables}
        />
      ) : section === "imports" ? (
        <Imports base={base} tables={tables} onChanged={loadTables} />
      ) : section === "exports" ? (
        <Exports base={base} tables={tables} />
      ) : section === "recycle" ? (
        <Recycle base={base} onChanged={loadTables} />
      ) : section === "settings" ? (
        <SettingsPage base={base} onChanged={refreshBase} />
      ) : section === "audit" ? (
        <Audit base={base} />
      ) : section === "system" ? (
        <SystemStatus />
      ) : (
        <Empty
          title="请选择数据表"
          description="在左侧选择或新建一张数据表。"
        />
      )}
      {renamingTable && (
        <RenameModal
          title="重命名数据表"
          initialValue={renamingTable.name}
          onClose={() => setRenamingTable(null)}
          onSave={renameTable}
        />
      )}
      {createTable && (
        <Modal
          title="新建数据表"
          onClose={() => setCreateTable(false)}
          footer={
            <>
              <Button onClick={() => setCreateTable(false)}>取消</Button>
              <Button primary disabled={!tableName.trim()} onClick={addTable}>
                创建数据表
              </Button>
            </>
          }
        >
          <label>
            数据表名称
            <input
              value={tableName}
              onChange={(event) => setTableName(event.target.value)}
              autoFocus
            />
          </label>
        </Modal>
      )}
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState({ loading: true, user: null });
  const [base, setBase] = useState(null);
  useEffect(() => {
    api("/auth/me")
      .then((user) => setAuth({ loading: false, user }))
      .catch(() => setAuth({ loading: false, user: null }));
  }, []);
  async function logout() {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      setAuth({ loading: false, user: null });
      setBase(null);
    }
  }
  if (auth.loading)
    return (
      <div className="boot">
        <LoaderCircle className="spin" />
        <strong>多维数据库</strong>
        <span>正在连接私有服务器</span>
      </div>
    );
  if (!auth.user)
    return <Login onLogin={(user) => setAuth({ loading: false, user })} />;
  if (!base)
    return <Bases user={auth.user} onLogout={logout} onOpen={setBase} />;
  return (
    <BaseApp
      user={auth.user}
      initialBase={base}
      onBack={() => setBase(null)}
      onLogout={logout}
    />
  );
}
