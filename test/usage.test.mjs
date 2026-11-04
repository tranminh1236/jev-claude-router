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

/**
 * The capture tee shares one readable with the client's own response, so an abandoned tee
 * applies backpressure to the stream the user is reading. A decompressor that errors mid-reply
 * (a `content-encoding` the body does not actually match) must not freeze that reply.
 */
test("a decompression failure never stalls the real response stream", async () => {
  const file = freshFile();
  const stream = new PassThrough();
  stream.headers = { "content-encoding": "gzip" };
  const sink = new PassThrough();
  let received = 0;
  sink.on("data", (chunk) => {
    received += chunk.length;
  });

  captureUsage({ stream, reqId: "r4", file });
  stream.pipe(sink);

  const head = Buffer.from("not actually gzip");
  stream.write(head);
  // The decompressor's error is asynchronous, and the hazard is what happens to the rest of
  // the reply afterwards - so the body goes out in chunks once the failure has already landed.
  await new Promise((r) => setTimeout(r, 20));

  const chunk = Buffer.alloc(32 * 1024, 0x61);
  const chunks = 16; // 512KB total, well past a PassThrough's 16KB highWaterMark.
  for (let i = 0; i < chunks; i++) {
    stream.write(chunk);
    await new Promise((r) => setImmediate(r));
  }
  stream.end();

  const ended = new Promise((resolve) => sink.on("end", resolve));
  const timedOut = Symbol("timeout");
  const outcome = await Promise.race([
    ended.then(() => "ended"),
    new Promise((r) => setTimeout(() => r(timedOut), 2000)),
  ]);

  const total = head.length + chunk.length * chunks;
  assert.equal(outcome, "ended", `the client stream stalled after ${received} of ${total} bytes`);
  assert.equal(received, total);
});

/**
 * Anthropic sends `message_start` - which carries the served model, input tokens and both
 * cache counts - at the very front of the stream, and the output-token total at the very end.
 * A long reply puts tens of kilobytes between them, so capture that only looks at a trailing
 * window loses the model and the input side of the bill for exactly the expensive turns.
 */
test("captureUsage keeps the model and input tokens across a long stream", async () => {
  const file = freshFile();
  const stream = new PassThrough();
  stream.headers = {};
  captureUsage({ stream, reqId: "r5", file });

  stream.write(
    `event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-4-5-20251001","usage":{"input_tokens":812,"cache_read_input_tokens":18400,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n`,
  );
  for (let i = 0; i < 2000; i++) {
    stream.write(`event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"token ${i} of padding"}}\n\n`);
  }
  stream.end(`event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4000}}\n\n`);

  await new Promise((r) => setTimeout(r, 50));
  const row = JSON.parse(readFileSync(file, "utf8").trim());
  assert.equal(row.servedModel, "claude-haiku-4-5-20251001");
  assert.deepEqual(row.usage, {
    inputTokens: 812,
    outputTokens: 4000,
    cacheReadTokens: 18400,
    cacheCreationTokens: 0,
  });
});
