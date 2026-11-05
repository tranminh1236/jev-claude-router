import test from "node:test";
import assert from "node:assert/strict";
import { PRICE_TABLE, costOf, computeSavings } from "../src/price.mjs";

test("costOf prices input, output and cache-read tokens separately", () => {
  const cost = costOf("claude-haiku-4-5-20251001", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
  });
  const expected =
    PRICE_TABLE["claude-haiku-4-5-20251001"].input +
    PRICE_TABLE["claude-haiku-4-5-20251001"].output +
    PRICE_TABLE["claude-haiku-4-5-20251001"].cacheRead;
  assert.equal(cost, expected);
});

test("costOf returns null for an unknown model", () => {
  assert.equal(costOf("some-unknown-model", { inputTokens: 100 }), null);
});

test("costOf returns null for missing usage", () => {
  assert.equal(costOf("claude-opus-5", null), null);
});

test("computeSavings excludes rows without usage from the money totals", () => {
  const rows = [
    { servedModel: "claude-haiku-4-5-20251001", usage: { inputTokens: 1000, outputTokens: 1000 } },
    { servedModel: "claude-opus-5", usage: null },
  ];
  const result = computeSavings(rows, { baselineModel: "claude-opus-5" });
  assert.equal(result.rowsWithUsage, 1);
  assert.equal(result.rowsWithoutUsage, 1);
  assert.ok(result.actualUsd > 0);
  assert.ok(result.savedUsd > 0);
});
