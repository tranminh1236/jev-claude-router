import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { extractUsage, extractServedModel, captureUsage } from "../src/usage.mjs";

const dir = mkdtempSync(join(tmpdir(), "jev-usage-"));
let n = 0;
const freshFile = () => join(dir, `decisions-${n++}.jsonl`);

test("extractUsage reads token fields and keeps the last match per field", () => {
  const text = `data: {"usage":{"input_tokens":100,"cache_read_input_tokens":50}}\n\ndata: {"usage":{"output_tokens":42}}\n\n`;
  assert.deepEqual(extractUsage(text), { inputTokens: 100, cacheReadTokens: 50, outputTokens: 42 });
});

test("extractUsage omits fields that never appeared", () => {
  assert.deepEqual(extractUsage(`{"usage":{"output_tokens":5}}`), { outputTokens: 5 });
});

test("extractUsage on garbage text returns an empty object", () => {
  assert.deepEqual(extractUsage("not json at all"), {});
});

test("extractServedModel reads the first model id", () => {
  assert.equal(extractServedModel(`{"model":"claude-opus-5"}`), "claude-opus-5");
});

test("extractServedModel returns null when absent", () => {
  assert.equal(extractServedModel("no model here"), null);
});

test("captureUsage appends a usage row for an uncompressed stream", async () => {
  const file = freshFile();
  const stream = new PassThrough();
  stream.headers = {};
  captureUsage({ stream, reqId: "r1", file });
  stream.end(`data: {"model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":20}}\n\n`);
  await new Promise((r) => setTimeout(r, 20));
  const row = JSON.parse(readFileSync(file, "utf8").trim());
  assert.deepEqual(row, { kind: "usage", reqId: "r1", ts: row.ts, usage: { inputTokens: 10, outputTokens: 20 }, servedModel: "claude-opus-5" });
});

test("captureUsage appends a usage row for a gzip-compressed stream", async () => {
  const file = freshFile();
  const payload = gzipSync(`data: {"usage":{"output_tokens":7}}\n\n`);
  const stream = new PassThrough();
  stream.headers = { "content-encoding": "gzip" };
  captureUsage({ stream, reqId: "r2", file });
  stream.end(payload);
  await new Promise((r) => setTimeout(r, 20));
  const row = JSON.parse(readFileSync(file, "utf8").trim());
  assert.deepEqual(row.usage, { outputTokens: 7 });
});

test("captureUsage writes nothing when decompression fails", async () => {
  const file = freshFile();
  const stream = new PassThrough();
  stream.headers = { "content-encoding": "gzip" };
  captureUsage({ stream, reqId: "r3", file });
  stream.end(Buffer.from("not actually gzip"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(existsSync(file), false);
});
