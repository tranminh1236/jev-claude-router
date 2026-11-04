import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { sanitizeSchema, newTurnPrompt, applyTier, conversationKey, sessionOf, startProxy } from "../src/proxy.mjs";

// A stand-in for api.anthropic.com: answers every request with a small JSON body, just enough
// for captureUsage to have something to read. What it returns is not under test here.
const mockUpstream = http.createServer((req, res) => {
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(`{"model":"claude-sonnet-5","usage":{"input_tokens":5,"output_tokens":10}}`);
});
await new Promise((resolve) => mockUpstream.listen(0, "127.0.0.1", resolve));
const mockUpstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;
after(() => mockUpstream.close());

function postTurn(port, body) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/messages", agent: false },
      (res) => {
        res.on("data", () => {});
        res.on("end", resolve);
        res.on("error", resolve);
      },
    );
    req.on("error", resolve);
    req.end(JSON.stringify(body));
  });
}

// One full, routable agent turn: the sentinel model, a tool so newTurnPrompt sees a real turn,
// and a fresh session/conversation so it is never mistaken for a sub-agent.
async function postRoutedTurn(port) {
  const session = randomUUID();
  await postTurn(port, {
    model: "jev-auto",
    tools: [{ name: "Bash" }],
    messages: [{ role: "user", content: "please fix the failing test" }],
    metadata: { user_id: JSON.stringify({ session_id: session }) },
  });
}

// A sub-agent spawn: the parent turn first marks the session routed (an auxiliary call with no
// tools, so it carries no prompt and is never logged itself), then a second request in the same
// session opens a brand-new conversation naming a concrete model - exactly how Claude Code
// starts a sub-agent - which `isSubagentSpawn` reads as one.
async function postSubagentTurn(port) {
  const session = randomUUID();
  await postTurn(port, {
    model: "jev-auto",
    messages: [{ role: "user", content: "aux call, no tools" }],
    metadata: { user_id: JSON.stringify({ session_id: session }) },
  });
  await postTurn(port, {
    model: "claude-sonnet-4-6",
    tools: [{ name: "Bash" }],
    messages: [{ role: "user", content: "sub-agent task" }],
    metadata: { user_id: JSON.stringify({ session_id: session }) },
  });
}

test("logs a decision row with the reqId usage capture uses, when decisionLogFile is set", async () => {
  const file = join(tmpdir(), `decisions-${Date.now()}-${randomUUID()}.jsonl`);
  const { port, close } = await startProxy({ upstream: mockUpstreamUrl, decisionLogFile: file });
  await postRoutedTurn(port);
  // captureUsage writes the usage row off the upstream response's own "end" event, which is
  // not ordered against the client response's "end" that postTurn awaits - give it a moment.
  await new Promise((r) => setTimeout(r, 20));
  await close();
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const row = lines[0];
  assert.equal(row.kind, "decision");
  assert.equal(row.provider, "claude");
  assert.ok(row.reqId);
  assert.equal(typeof row.to, "string");

  // The decision row and the usage row captureUsage writes from the same request are two
  // separate appends - the dashboard only joins them correctly if they share one reqId.
  const usageRow = lines.find((l) => l.kind === "usage");
  assert.ok(usageRow, "captureUsage never wrote a usage row");
  assert.equal(usageRow.reqId, row.reqId);
});

test("never logs a decision row for a sub-agent turn", async () => {
  const file = join(tmpdir(), `decisions-${Date.now()}-${randomUUID()}.jsonl`);
  const { port, close } = await startProxy({ upstream: mockUpstreamUrl, decisionLogFile: file });
  await postSubagentTurn(port);
  await close();
  assert.equal(existsSync(file), false);
});

test("decisionLogFile omitted logs nothing and changes no existing behavior", async () => {
  const { port, close } = await startProxy({ upstream: mockUpstreamUrl });
  await postRoutedTurn(port);
  await close();
  // no assertion beyond "did not throw" - this pins backward compatibility for every
  // existing test in this file that calls startProxy() without the new options.
});

test("only the sentinel model is routed", () => {
  assert.equal(isAuto("jev-auto"), true);
  assert.equal(isAuto("claude-opus-4-6"), false, "a model the user picked is theirs");
  assert.equal(isAuto("claude-haiku-4-5-20251001"), false, "internal Haiku calls pass through");
  assert.equal(isAuto(undefined), false);
});

test("the sentinel is not mistaken for a real tier", () => {
  assert.equal(tierOf("jev-auto"), null);
});
import { tierOf, isAuto } from "../src/config.mjs";
import { writeStatus, readStatus } from "../src/status.mjs";

test("reads the session id out of Claude Code's metadata", () => {
  const sid = "11111111-2222-4333-8444-555555555555";
  assert.equal(sessionOf({ metadata: { user_id: JSON.stringify({ session_id: sid }) } }), sid);
  assert.equal(sessionOf({ metadata: { user_id: "not-json" } }), "");
  assert.equal(sessionOf({}), "");
});

test("status round-trips per session and misses cleanly", () => {
  const sid = `test-${process.pid}`;
  writeStatus(sid, { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.deepEqual(readStatus(sid), { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.equal(readStatus("no-such-session"), null);
  assert.doesNotThrow(() => writeStatus("", { tier: "opus" }));
});

test("recognises older model versions within a tier", () => {
  assert.equal(tierOf("claude-sonnet-4-6"), "sonnet");
  assert.equal(tierOf("claude-sonnet-5"), "sonnet");
  assert.equal(tierOf("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(tierOf("claude-opus-4-1"), "opus");
  assert.equal(tierOf("claude-fable-5-1[1m]"), "fable");
  assert.equal(tierOf("gpt-9"), null);
  assert.equal(tierOf(undefined), null);
});

const withTools = (messages) => ({ tools: [{ name: "Bash" }], messages });

test("converts a draft-04 boolean exclusiveMinimum into a draft 2020-12 number", () => {
  const schema = { type: "object", properties: { topN: { minimum: 0, exclusiveMinimum: true } } };
  sanitizeSchema(schema);
  assert.deepEqual(schema.properties.topN, { exclusiveMinimum: 0 });
});

test("drops a false exclusiveMaximum and keeps the bound", () => {
  const schema = { properties: { n: { maximum: 10, exclusiveMaximum: false } } };
  sanitizeSchema(schema);
  assert.deepEqual(schema.properties.n, { maximum: 10 });
});

test("leaves an already-valid numeric bound alone", () => {
  const schema = { properties: { n: { exclusiveMinimum: 5 } } };
  sanitizeSchema(schema);
  assert.equal(schema.properties.n.exclusiveMinimum, 5);
});

test("reaches schemas nested in arrays and sub-objects", () => {
  const schema = { anyOf: [{ items: { minimum: 1, exclusiveMinimum: true } }] };
  sanitizeSchema(schema);
  assert.deepEqual(schema.anyOf[0].items, { exclusiveMinimum: 1 });
});

test("survives null and primitive nodes", () => {
  assert.doesNotThrow(() => sanitizeSchema(null));
  assert.doesNotThrow(() => sanitizeSchema({ a: null, b: 3, c: "x" }));
});

test("reads a plain string prompt as a new turn", () => {
  assert.equal(newTurnPrompt(withTools([{ role: "user", content: "fix the bug" }])), "fix the bug");
});

test("reads a text block prompt as a new turn", () => {
  const body = withTools([{ role: "user", content: [{ type: "text", text: "fix the bug" }] }]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("ignores a tool_result continuation mid-turn", () => {
  const body = withTools([
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
  ]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores auxiliary calls that carry no tools", () => {
  const body = { messages: [{ role: "user", content: "summarise this" }] };
  assert.equal(newTurnPrompt(body), null);
});

test("ignores a request whose last message is from the assistant", () => {
  const body = withTools([{ role: "assistant", content: "thinking" }]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores an empty prompt", () => {
  assert.equal(newTurnPrompt(withTools([{ role: "user", content: "   " }])), null);
});

test("survives a malformed body", () => {
  assert.equal(newTurnPrompt(undefined), null);
  assert.equal(newTurnPrompt({}), null);
  assert.equal(newTurnPrompt({ tools: [], messages: [] }), null);
});

test("strips system reminders Claude Code injects into the prompt", () => {
  const body = withTools([
    {
      role: "user",
      content: "fix the bug\n<system-reminder>be careful\nabout things</system-reminder>",
    },
  ]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("a prompt that is only a system reminder is not a turn", () => {
  const body = withTools([{ role: "user", content: "<system-reminder>noise</system-reminder>" }]);
  assert.equal(newTurnPrompt(body), null);
});

test("routing to haiku strips fields haiku cannot accept", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  };
  applyTier(body, "haiku");
  assert.equal(body.model, "claude-haiku-4-5-20251001");
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config, undefined);
  assert.equal(body.context_management, undefined);
});

test("routing to haiku keeps context-management strategies unrelated to thinking", () => {
  const body = {
    model: "claude-sonnet-4-6",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }, { type: "clear_thinking_20251015" }] },
  };
  applyTier(body, "haiku");
  assert.deepEqual(body.context_management, { edits: [{ type: "clear_tool_uses_20250919" }] });
});

test("routing sets the tier's effort, overriding whatever the CLI asked for", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
  };
  applyTier(body, "opus");
  assert.equal(body.model, "claude-opus-5");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "high" });
});

test("the long tier is the strong model thinking harder, not a costlier model", () => {
  const body = { model: "jev-auto", thinking: { type: "adaptive" } };
  applyTier(body, "fable");
  assert.equal(body.model, "claude-opus-5");
  // No effort in the request at all, so one has to be added for the tier to mean anything.
  assert.deepEqual(body.output_config, { effort: "xhigh" });
});

test("other output_config settings survive the effort being set", () => {
  const body = { model: "jev-auto", output_config: { format: { type: "json_schema" } } };
  applyTier(body, "sonnet");
  assert.deepEqual(body.output_config, { format: { type: "json_schema" }, effort: "high" });
});

test("effort is stripped for Haiku, which rejects it outright", () => {
  const body = { model: "jev-auto", output_config: { effort: "high" } };
  applyTier(body, "haiku");
  assert.equal(body.model, "claude-haiku-4-5-20251001");
  // The whole object goes when effort was all it held; an empty one is not worth sending.
  assert.equal(body.output_config, undefined);
});

test("an unknown tier leaves the request untouched", () => {
  const body = { model: "claude-sonnet-4-6", thinking: { type: "adaptive" } };
  applyTier(body, "nonsense");
  assert.equal(body.model, "claude-sonnet-4-6");
});

test("routing to haiku clamps max_tokens composed for a bigger tier", () => {
  const body = { model: "claude-sonnet-4-6", max_tokens: 128000 };
  applyTier(body, "haiku");
  assert.equal(body.max_tokens, 64000);
});

test("routing to haiku leaves max_tokens alone when already under the cap", () => {
  const body = { model: "claude-sonnet-4-6", max_tokens: 40000 };
  applyTier(body, "haiku");
  assert.equal(body.max_tokens, 40000, "the clamp only lowers a value over the cap, never raises one");
});

test("routing to sonnet leaves max_tokens at exactly the cap", () => {
  const body = { model: "jev-auto", max_tokens: 128000 };
  applyTier(body, "sonnet");
  assert.equal(body.max_tokens, 128000, "exactly at the cap is not over it");
});

test("a body with no max_tokens is left untouched", () => {
  const body = { model: "jev-auto" };
  applyTier(body, "haiku");
  assert.equal("max_tokens" in body, false, "the clamp must not invent a max_tokens field");
});

test("an unknown tier leaves max_tokens alone too", () => {
  const body = { model: "claude-sonnet-4-6", max_tokens: 128000 };
  applyTier(body, "nonsense");
  assert.equal(body.max_tokens, 128000);
});

test("a conversation keeps one key as it grows, and differs from a sub-agent", () => {
  const main = { messages: [{ role: "user", content: "main task" }] };
  const grown = {
    messages: [{ role: "user", content: "main task" }, { role: "assistant", content: "ok" }],
  };
  const sub = { messages: [{ role: "user", content: "sub-agent task" }] };
  assert.equal(conversationKey(main), conversationKey(grown));
  assert.notEqual(conversationKey(main), conversationKey(sub));
});

test("the key ignores the cache_control breakpoint Claude Code moves between requests", () => {
  const first = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing", cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
      },
    ],
  };
  const later = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing" },
        ],
      },
      { role: "assistant", content: "working" },
    ],
  };
  assert.equal(conversationKey(first), conversationKey(later));
});

test("the same opening text in two sessions gets two keys", () => {
  const mk = (id) => ({
    metadata: { user_id: JSON.stringify({ session_id: id }) },
    messages: [{ role: "user", content: "same opening" }],
  });
  assert.notEqual(conversationKey(mk("a")), conversationKey(mk("b")));
});

test("the key survives metadata that is not JSON", () => {
  const body = { metadata: { user_id: "not-json" }, messages: [{ role: "user", content: "hi" }] };
  assert.doesNotThrow(() => conversationKey(body));
});

test("a trailing system message does not hide the user's turn", () => {
  // Claude Code appends hook output as a mid-conversation system message. Any SessionStart
  // hook produces one on the first request of every session, so reading only the last
  // message meant that session never routed at all.
  const body = {
    tools: [{ name: "Read" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Debug the deadlock" }] },
      { role: "system", content: [{ type: "text", text: "SessionStart hook: ready" }] },
    ],
  };
  assert.equal(newTurnPrompt(body), "Debug the deadlock");

  // Several of them, and one that is a plain string, are stepped over just the same.
  body.messages.push({ role: "system", content: "another hook fired" });
  assert.equal(newTurnPrompt(body), "Debug the deadlock");

  // A tool continuation is still not a new turn, however many system messages follow it.
  body.messages.splice(1, 0, {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "1", content: "done" }],
  });
  assert.equal(newTurnPrompt(body), null);

  // A system message alone is not a turn either.
  assert.equal(newTurnPrompt({ tools: [{ name: "Read" }], messages: [{ role: "system", content: "x" }] }), null);
});
