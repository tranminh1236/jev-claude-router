import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine, trimDecisionLog } from "../src/decision-log.mjs";

const dir = mkdtempSync(join(tmpdir(), "jev-decision-log-"));
const file = join(dir, "decisions.jsonl");

test("appendLine writes one JSON line per call", () => {
  appendLine(file, { a: 1 });
  appendLine(file, { a: 2 });
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ a: 1 }, { a: 2 }]);
});

test("appendLine never throws when the directory cannot be created", () => {
  assert.doesNotThrow(() => appendLine("/nonexistent-root/no/such/dir/x.jsonl", { a: 1 }));
});

test("trimDecisionLog keeps exactly the last maxLines lines", () => {
  const trimFile = join(dir, "trim.jsonl");
  writeFileSync(trimFile, Array.from({ length: 25 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n");
  trimDecisionLog(trimFile, 10);
  const lines = readFileSync(trimFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 10);
  assert.deepEqual(lines[0], { i: 15 });
  assert.deepEqual(lines[9], { i: 24 });
});

test("trimDecisionLog on a missing file is a no-op", () => {
  assert.doesNotThrow(() => trimDecisionLog(join(dir, "does-not-exist.jsonl"), 10));
  assert.equal(existsSync(join(dir, "does-not-exist.jsonl")), false);
});
