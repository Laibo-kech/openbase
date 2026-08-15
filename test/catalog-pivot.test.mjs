import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { makeCatalogKey, normalizeCatalogValue } from "../server/catalog-service.mjs";
import { normalizePivotConfig } from "../server/pivot-service.mjs";

test("catalog matching normalizes text, full-width characters, numbers and dates", () => {
  const options = { trim: true, collapseSpaces: true, caseInsensitive: true, fullWidth: true, typed: true };
  assert.equal(normalizeCatalogValue("  Ｐ００１   Item  ", "text", options), "p001 item");
  assert.equal(normalizeCatalogValue("001.50", "number", options), "1.5");
  assert.equal(normalizeCatalogValue("2026-08-15T12:30:00+08:00", "date", options), "2026-08-15");
  const fields = new Map([["name", { id: "name", type: "text" }], ["size", { id: "size", type: "number" }]]);
  assert.equal(makeCatalogKey({ name: " Widget ", size: "010" }, fields, ["name", "size"], options), '["widget","10"]');
});

test("pivot configuration supports dimensions, measures, filters, totals and empty modes", () => {
  const fields = [
    { id: "region", name: "地区", type: "select" },
    { id: "date", name: "日期", type: "date" },
    { id: "amount", name: "金额", type: "number" },
  ];
  const config = normalizePivotConfig({
    rows: [{ fieldId: "region" }],
    columns: [{ fieldId: "date", grouping: "month" }],
    measures: [
      { id: "orders", aggregation: "count", label: "订单数" },
      { id: "sales", fieldId: "amount", aggregation: "sum", label: "销售额" },
    ],
    filters: [{ fieldId: "amount", operator: "gt", value: 0 }],
    filterMode: "any",
    totals: { rows: true, columns: false, grand: true, subtotals: false },
    empty: { mode: "custom", label: "未填写" },
    sort: { by: "sales", direction: "desc" },
  }, fields);
  assert.equal(config.columns[0].grouping, "month");
  assert.equal(config.measures[1].aggregation, "sum");
  assert.equal(config.filterMode, "any");
  assert.equal(config.totals.columns, false);
  assert.equal(config.empty.label, "未填写");
  assert.deepEqual(config.sort, { by: "sales", direction: "desc" });
});

test("catalog and pivot endpoints and complete frontend workspaces are present", () => {
  const database = fs.readFileSync(new URL("../server/db.mjs", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const catalog = fs.readFileSync(new URL("../server/catalog-service.mjs", import.meta.url), "utf8");
  const pivot = fs.readFileSync(new URL("../server/pivot-service.mjs", import.meta.url), "utf8");
  const catalogUi = fs.readFileSync(new URL("../src/CatalogMatching.jsx", import.meta.url), "utf8");
  const pivotUi = fs.readFileSync(new URL("../src/PivotPage.jsx", import.meta.url), "utf8");
  for (const marker of [
    "catalog_definitions", "catalog_match_jobs", "catalog_aliases", "catalog_dirty_records",
    "pivot_configs", "pivot_jobs", "pivot_job_rows", "pg_trgm",
  ]) assert.equal(database.includes(marker), true, marker);
  for (const marker of [
    "/catalog-definitions", "/catalog-configs", "/catalog-jobs", "/duplicates", "/confirm", "/undo",
    "/pivot-configs", "/pivot-jobs", "/drilldown", "/export-estimate", "/export.:format",
  ]) assert.equal(server.includes(marker), true, marker);
  for (const marker of ["incremental", "fuzzy_candidate", "manual_confirmed", "previous_target_ids", "FOR UPDATE"]) {
    assert.equal(catalog.includes(marker), true, marker);
  }
  for (const marker of ["ROLLUP", "statement_timeout", "pg_cancel_backend", "10 minutes", "NULLS LAST", "PIVOT_DATA_UPDATED"]) {
    assert.equal(pivot.includes(marker), true, marker);
  }
  for (const marker of ["联合匹配字段", "模糊匹配候选", "选择目录记录", "保存为别名规则", "撤销本次任务"]) {
    assert.equal(catalogUi.includes(marker), true, marker);
  }
  for (const marker of ["行字段", "列字段", "数值指标", "全部满足", "显示小计", "查看原始记录", "导出数据透视结果"]) {
    assert.equal(pivotUi.includes(marker), true, marker);
  }
});
