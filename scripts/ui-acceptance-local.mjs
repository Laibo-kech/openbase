import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const appUrl = process.env.UI_APP_URL;
const adminUrl = process.env.UI_ADMIN_URL;
const appUsername = process.env.UI_APP_USERNAME;
const appPassword = process.env.UI_APP_PASSWORD;
const adminUsername = process.env.UI_ADMIN_USERNAME;
const adminPassword = process.env.UI_ADMIN_PASSWORD;
const outputDir = process.env.UI_OUTPUT_DIR || process.cwd();
if (![appUrl, adminUrl, appUsername, appPassword, adminUsername, adminPassword].every(Boolean)) throw new Error("缺少 UI 验收环境变量");

const browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
const page = await context.newPage();
let restoreState = null;

async function appApi(pathname, options = {}) {
  return page.evaluate(async ({ pathname, options }) => {
    const response = await fetch(`./api${pathname}`, {
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const result = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(`${pathname}: ${response.status}`);
    return result;
  }, { pathname, options });
}

try {
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "注册" }).click();
  await page.getByText("注册名保持唯一，注册后自动登录").waitFor();
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByLabel("账号").fill(appUsername);
  await page.getByLabel("密码").fill(appPassword);
  await page.locator(".login-panel .button.primary").click();
  await page.getByRole("heading", { name: "我的项目" }).waitFor();

  const bases = await appApi("/bases");
  if (!bases.length) throw new Error("主账号项目为空");
  await page.locator(".project-card").first().click();
  await page.locator(".data-grid").waitFor();

  const tables = await appApi(`/bases/${bases[0].id}/tables`);
  const schema = await appApi(`/tables/${tables[0].id}/schema`);
  const view = schema.views[0];
  const originalConfig = view.config || {};
  restoreState = { baseId: bases[0].id, viewId: view.id, viewName: view.name, viewConfig: originalConfig, tableIds: tables.map((table) => table.id) };
  const compactWidths = Object.fromEntries(schema.fields.map((field) => [field.id, 28]));
  await appApi(`/views/${view.id}`, { method: "PATCH", body: { config: { ...originalConfig, columnWidths: compactWidths } } });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".project-card").first().click();
  await page.locator(".data-grid").waitFor();
  const gridMetrics = await page.evaluate(() => {
    const table = document.querySelector(".data-grid");
    const scroller = document.querySelector(".grid-scroll");
    const lastHeader = table.querySelector("th:last-child");
    return { tableWidth: table.getBoundingClientRect().width, containerWidth: scroller.clientWidth, lastColumnWidth: lastHeader.getBoundingClientRect().width };
  });
  if (gridMetrics.lastColumnWidth > 32 || gridMetrics.tableWidth >= gridMetrics.containerWidth) throw new Error(`列宽布局未缩小: ${JSON.stringify(gridMetrics)}`);

  const renamedView = `${view.name}-UI验收`;
  page.once("dialog", (dialog) => dialog.accept(renamedView));
  await page.locator(".view-tabs > button").first().click({ button: "right" });
  await page.getByRole("button", { name: renamedView }).waitFor();
  const navItems = page.locator(".table-nav-item");
  await navItems.nth(0).dragTo(navItems.nth(1));
  await page.waitForTimeout(500);
  const reordered = await appApi(`/bases/${bases[0].id}/tables`);
  if (reordered[0].id === tables[0].id) throw new Error("拖拽排序未生效");
  await page.screenshot({ path: path.join(outputDir, "multibase-user.png"), fullPage: true });

  await page.goto(appUrl, { waitUntil: "networkidle" });
  await appApi(`/views/${restoreState.viewId}`, { method: "PATCH", body: { name: restoreState.viewName, config: restoreState.viewConfig } });
  await appApi(`/bases/${restoreState.baseId}/tables/reorder`, { method: "PATCH", body: { tableIds: restoreState.tableIds } });
  restoreState = null;

  await page.goto(adminUrl, { waitUntil: "networkidle" });
  await page.locator("#login-username").fill(adminUsername);
  await page.locator("#login-password").fill(adminPassword);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator("#app:not([hidden])").waitFor();
  await page.locator('[data-page="users"]').click();
  await page.locator("#content tbody tr").first().waitFor();
  const userRows = await page.locator("#content tbody tr").count();
  if (userRows < 2) throw new Error("管理后台用户列表不足");
  await page.locator('[data-page="projects"]').click();
  await page.locator("#content tbody tr").first().waitFor();
  await page.locator('[data-page="audit"]').click();
  await page.locator("#content tbody tr").first().waitFor();
  await page.screenshot({ path: path.join(outputDir, "multibase-admin.png"), fullPage: true });

  console.log(JSON.stringify({ ok: true, registrationVisible: true, baseCount: bases.length, tableCount: tables.length, gridMetrics, viewRename: true, tableDrag: true, adminUserRows: userRows }));
} finally {
  if (restoreState) {
    try {
      await page.goto(appUrl, { waitUntil: "networkidle" });
      await appApi(`/views/${restoreState.viewId}`, { method: "PATCH", body: { name: restoreState.viewName, config: restoreState.viewConfig } });
      await appApi(`/bases/${restoreState.baseId}/tables/reorder`, { method: "PATCH", body: { tableIds: restoreState.tableIds } });
    } catch (error) {
      console.error(`测试数据恢复失败: ${error.message}`);
    }
  }
  await browser.close();
}
