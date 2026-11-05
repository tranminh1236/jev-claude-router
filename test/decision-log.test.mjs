import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine, trimDecisionLog, maybeTrimDecisionLog } from "../src/decision-log.mjs";

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

/**
 * Security review: decisions.jsonl now carries a slice of the user's own prompt text
 * (promptPreview, src/proxy.mjs). Created world-readable (the open()/umask default), any
 * other local account can read it. appendLine must pin it owner-only on creation.
 */
test("appendLine creates a new file owner-read/write only, not world-readable", () => {
  const freshFile = join(dir, `fresh-${Date.now()}.jsonl`);
  appendLine(freshFile, { a: 1 });
  const mode = statSync(freshFile).mode & 0o777;
  assert.equal(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
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

/**
 * The hot path calls this on every routed decision, and trimDecisionLog re-reads (and, when
 * over the cap, rewrites) the whole file - cheap once, not thousands of times per session.
 * maybeTrimDecisionLog only pays that cost every `every`th call; the calls between are free.
 */
test("maybeTrimDecisionLog only trims every Nth call, not every call", () => {
  const throttleFile = join(dir, "throttle.jsonl");
  writeFileSync(throttleFile, Array.from({ length: 10 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n");
  for (let i = 0; i < 4; i++) maybeTrimDecisionLog(throttleFile, { maxLines: 5, every: 5 });
  let lines = readFileSync(throttleFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 10, "untrimmed before the 5th call");

  maybeTrimDecisionLog(throttleFile, { maxLines: 5, every: 5 });
  lines = readFileSync(throttleFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 5, "trimmed on the 5th call");
});
