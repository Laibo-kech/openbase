import assert from "node:assert/strict";
import test from "node:test";
import { aggregateLookupValues, validateAggregation } from "../server/lookup-service.mjs";

const items = (...values) => values.map((value, ordinal) => ({ value, ordinal, deleted: false }));

test("lookup supports first, last, unique concat and count", () => {
  assert.equal(aggregateLookupValues(items("A", "B", "A"), { aggregation: "first" }), "A");
  assert.equal(aggregateLookupValues(items("A", "B", "A"), { aggregation: "last" }), "A");
  assert.equal(aggregateLookupValues(items("A", "B", "A"), { aggregation: "unique_concat" }), "A、B");
  assert.equal(aggregateLookupValues(items("A", "B", "A"), { aggregation: "count" }), 3);
});

test("lookup supports numeric aggregations", () => {
  assert.equal(aggregateLookupValues(items(10, 20, 30), { aggregation: "sum" }, "number"), 60);
  assert.equal(aggregateLookupValues(items(10, 20, 30), { aggregation: "average" }, "number"), 20);
  assert.equal(aggregateLookupValues(items(10, 20, 30), { aggregation: "max" }, "number"), 30);
  assert.equal(aggregateLookupValues(items(10, 20, 30), { aggregation: "min" }, "number"), 10);
});

test("lookup supports date min and max", () => {
  const values = items("2026-08-14", "2025-01-01", "2027-12-31");
  assert.equal(aggregateLookupValues(values, { aggregation: "min" }, "date"), "2025-01-01");
  assert.equal(aggregateLookupValues(values, { aggregation: "max" }, "date"), "2027-12-31");
});

test("lookup empty policies are deterministic", () => {
  assert.equal(aggregateLookupValues([], { emptyPolicy: "empty" }), null);
  assert.equal(aggregateLookupValues([], { emptyPolicy: "default", defaultValue: "暂无" }), "暂无");
  assert.equal(aggregateLookupValues([], { emptyPolicy: "unmatched" }), "未匹配");
});

test("deleted target is visible instead of silently cleared", () => {
  assert.equal(
    aggregateLookupValues([{ value: "旧名称", ordinal: 0, deleted: true }], { aggregation: "first" }),
    "来源记录已删除",
  );
});

test("lookup aggregation validates return field types", () => {
  assert.doesNotThrow(() => validateAggregation("text", "unique_concat"));
  assert.doesNotThrow(() => validateAggregation("number", "average"));
  assert.throws(() => validateAggregation("text", "sum"), { code: "LOOKUP_AGGREGATION_INCOMPATIBLE" });
  assert.throws(() => validateAggregation("select", "max"), { code: "LOOKUP_AGGREGATION_INCOMPATIBLE" });
});
