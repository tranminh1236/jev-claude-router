# Decision Log and Dashboard (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every main-agent routing decision the Claude, Codex and Grok proxies make is appended to a shared local log, Claude's rows also carry real token usage and cost, and `jev-dashboard` serves a local read-only page showing the decision log and savings versus an always-Opus baseline.

**Architecture:** A new `src/decision-log.mjs` owns one JSONL file (`~/.jev-router/decisions.jsonl`) with two row kinds — `decision` (written synchronously when a main-agent turn is routed) and `usage` (appended once the upstream reply finishes, joined back to its decision by a shared `reqId`). `src/usage.mjs` holds pure text-extraction helpers so the regex logic is unit-testable without a real HTTP stream. `src/price.mjs` holds a static list-price table and the savings math. `src/dashboard-server.mjs` is a small `127.0.0.1`-only HTTP server, framework-free like the proxy, serving one inline HTML page plus two JSON endpoints that read and join the log. `bin/jev-dashboard.mjs` and a `jev-router dashboard` alias start it on demand.

**Scope cuts from the spec, made explicitly so no task tries to cover them:**
- Real `usage`/cost capture is Claude-only. Codex and Grok rows get `usage: null, servedModel: null` — the spec's own non-goals note only the Claude daemon exists, and OpenAI/xAI's streaming usage shape is a separate parsing problem with no daemon consumer yet.
- No `JEV_DASHBOARD_LOG_PROMPTS` prompt-preview feature — out of scope this round; the global constraint below ("never log prompt text") still holds without it.
- No `JEV_PRICE_*` env overrides on the price table — it is a static, labeled-as-estimate constant this round.
- No launchd/install wiring for the dashboard — it is opened on demand per the spec ("Not under launchd").

**Tech Stack:** Plain Node.js (`node:http`, `node:zlib`, `node:stream`, `node:crypto`, `node:fs`) — no new npm dependency, matching the existing proxy modules.

**Spec:** `docs/superpowers/specs/2026-11-02-daemon-dashboard-design.md`

## Global Constraints

- No new npm dependency; dashboard HTML is one inline static page, no build step, no framework (spec: "Dashboard (lite)").
- `dashboard-server.mjs`'s HTTP server binds `127.0.0.1` only — same posture as the proxy (spec: "Dashboard (lite)").
- Dashboard default port `61821`, overridable with `--port` or `JEV_DASHBOARD_PORT` (spec: "Dashboard (lite)").
- Decision log writes never log prompt text (spec: "No prompt text by default").
- Every log write is wrapped so a broken log can never affect a request (spec: "Decision log").
- Appends are single lines under 4 KB; only the daemon trims the log, to the last 20,000 lines, via write-temp-then-rename; non-daemon writers never trim (spec: "Trimming has a single owner").
- A row missing `usage` is unknown, never zero, in any savings total (spec: "Real usage capture").
- Sub-agent turns are never logged as decisions, matching what the status line already does (spec: "Decision log").

## Review Focus

- A decision-log write to an unwritable or missing directory must not throw into the request path — same "status display is cosmetic" rule `status.mjs` already follows. Pinned in Task 1's tests.
- A gzip-compressed SSE reply and an uncompressed one must both yield the same extracted usage numbers; a truncated or undecodable stream must leave `usage: null` rather than a wrong or zero value. Pinned in Task 2's tests.
- The decision log growing past 20,000 lines must end at exactly 20,000 after a trim, keeping the newest rows; a non-trimming caller appending past that count must never itself shrink the file. Pinned in Task 1's tests.
- A dashboard summary computed over rows where some lack `usage` must exclude those rows from the money total and report their count separately, never silently treating missing usage as zero cost. Pinned in Task 4's tests.
- A decision row whose `session` has no entry in the sessions map (e.g. a CLI launcher session that never ran through the `preflight` hook) must render with an "unknown" project rather than throwing when the dashboard joins it. Pinned in Task 5's tests.

---

## File Structure

- Create `src/decision-log.mjs` — `appendLine`, `trimDecisionLog`.
- Create `src/usage.mjs` — `extractUsage`, `extractServedModel`, `captureUsage`.
- Create `src/price.mjs` — `PRICE_TABLE`, `costOf`, `computeSavings`.
- Create `src/dashboard-server.mjs` — `readDecisions`, `readSessionsMap`, `buildSummary`, `createDashboardServer`, the inline HTML page.
- Create `bin/jev-dashboard.mjs` — CLI entry point.
- Modify `src/daemon.mjs` — add `decisions` to `statePaths()`.
- Modify `src/proxy.mjs` — log a `decision` row per routed main-agent turn and capture Claude's usage.
- Modify `src/codex-proxy.mjs`, `src/grok-proxy.mjs` — log a `decision` row per routed main-agent turn (no usage).
- Modify `bin/jev-daemon.mjs` — pass the decisions file and `trimDecisionLog: true` into `startProxy`.
- Modify `bin/jev-claude.mjs`, `bin/jev-codex.mjs`, `bin/jev-grok.mjs` — pass the decisions file (no trim) into their proxy starters.
- Modify `bin/jev-router.mjs` — forward `dashboard` to the new bin.
- Modify `package.json` — add the `jev-dashboard` bin entry.
- Test files: `test/decision-log.test.mjs`, `test/usage.test.mjs`, `test/price.test.mjs`, `test/dashboard-server.test.mjs`, plus additions to `test/proxy.test.mjs`, `test/codex.test.mjs`, `test/grok.test.mjs`, `test/daemon.test.mjs`.

---

### Task 1: Decision log module + `statePaths` entry

**Files:**
- Create: `src/decision-log.mjs`
- Modify: `src/daemon.mjs` (`statePaths`, currently returns `{dir, pid, port, log, install}`)
- Test: `test/decision-log.test.mjs`, `test/daemon.test.mjs`

**Interfaces:**
- Produces: `appendLine(file: string, row: object): void` — serializes `row` as one JSON line (`JSON.stringify(row) + "\n"`), `mkdirSync(dirname(file), {recursive: true})` first, wrapped in try/catch that swallows every error.
- Produces: `trimDecisionLog(file: string, maxLines = 20000): void` — reads the file, keeps the last `maxLines` lines (splitting on `"\n"`, dropping a trailing empty entry), writes them back via `writeAtomic` from `./claude-settings.mjs` (write-temp-then-rename), wrapped in try/catch; a missing file is a no-op, not an error.
- Produces: `statePaths()` gains `decisions: join(dir, "decisions.jsonl")`.

- [ ] **Step 1: Write the failing tests**

```js
// test/decision-log.test.mjs
test("appendLine writes one JSON line per call", () => {
  appendLine(file, { a: 1 });
  appendLine(file, { a: 2 });
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.deepEqual(lines.map(JSON.parse), [{ a: 1 }, { a: 2 }]);
});

test("appendLine never throws when the directory cannot be created", () => {
  assert.doesNotThrow(() => appendLine("/nonexistent-root/no/such/dir/x.jsonl", { a: 1 }));
});

test("trimDecisionLog keeps exactly the last maxLines lines", () => {
  writeFileSync(file, Array.from({ length: 25 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n");
  trimDecisionLog(file, 10);
  const lines = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 10);
  assert.deepEqual(lines[0], { i: 15 });
  assert.deepEqual(lines[9], { i: 24 });
});

test("trimDecisionLog on a missing file is a no-op", () => {
  assert.doesNotThrow(() => trimDecisionLog(join(tmpdir(), "does-not-exist.jsonl"), 10));
});
```

```js
// test/daemon.test.mjs addition
test("statePaths includes decisions.jsonl under the state dir", () => {
  const paths = statePaths("/home/x");
  assert.equal(paths.decisions, join("/home/x", ".jev-router", "decisions.jsonl"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/decision-log.test.mjs test/daemon.test.mjs`
Expected: FAIL — `decision-log.mjs` not found; `paths.decisions` undefined.

- [ ] **Step 3: Implement `appendLine` and `trimDecisionLog` in `src/decision-log.mjs`; add `decisions` to `statePaths()` in `src/daemon.mjs`**

Use `appendFileSync`/`mkdirSync` for `appendLine`. For `trimDecisionLog`, import `writeAtomic` from `./claude-settings.mjs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/decision-log.test.mjs test/daemon.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/decision-log.mjs src/daemon.mjs test/decision-log.test.mjs test/daemon.test.mjs
git commit -m "feat: add decision-log append/trim and statePaths().decisions"
```

---

### Task 2: Usage extraction + capture

**Files:**
- Create: `src/usage.mjs`
- Test: `test/usage.test.mjs`

**Interfaces:**
- Consumes: `appendLine` from Task 1 (`./decision-log.mjs`).
- Produces: `extractUsage(text: string): {inputTokens?, outputTokens?, cacheReadTokens?, cacheCreationTokens?}` — regex-extracts `"input_tokens":N`, `"output_tokens":N`, `"cache_read_input_tokens":N`, `"cache_creation_input_tokens":N` from raw decompressed SSE text, taking the **last** match found for each field (an Anthropic stream repeats `usage` across `message_start`/`message_delta`, and later values are the more complete ones); a field with no match is omitted from the result, never set to `0`.
- Produces: `extractServedModel(text: string): string | null` — first `"model":"([^"]+)"` match, or `null`.
- Produces: `captureUsage({ stream, reqId, file }): void` — tees `stream` (a Node `http.IncomingMessage`-like Readable with a `headers` object), decompresses per `content-encoding` (`gzip`/`x-gzip` → `zlib.createGunzip()`, `br` → `createBrotliDecompress()`, `deflate` → `createInflate()`, anything else → no decompression), accumulates decoded text capped at 65536 bytes (keep the tail via `.slice(-65536)` when exceeded), calls `extractUsage`/`extractServedModel` on each chunk, and on stream `"end"` appends one row via `appendLine(file, {kind: "usage", reqId, ts: Date.now(), usage: {...fields found, else omitted}, servedModel})` — **only if at least one field or the model was found**; on stream `"error"` or any internal exception, does nothing. Must never touch or delay the original response stream — it only taps a `PassThrough` fed by `stream.pipe(tee)`, never calls `stream.pause()`/`resume()` directly.

- [ ] **Step 1: Write the failing tests**

```js
// test/usage.test.mjs
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
  const stream = new PassThrough();
  stream.headers = {};
  captureUsage({ stream, reqId: "r1", file });
  stream.end(`data: {"model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":20}}\n\n`);
  await new Promise((r) => setTimeout(r, 20));
  const row = JSON.parse(readFileSync(file, "utf8").trim());
  assert.deepEqual(row, { kind: "usage", reqId: "r1", ts: row.ts, usage: { inputTokens: 10, outputTokens: 20 }, servedModel: "claude-opus-5" });
});

test("captureUsage appends a usage row for a gzip-compressed stream", async () => {
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
  const stream = new PassThrough();
  stream.headers = { "content-encoding": "gzip" };
  captureUsage({ stream, reqId: "r3", file });
  stream.end(Buffer.from("not actually gzip"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(existsSync(file), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/usage.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `extractUsage`, `extractServedModel`, `captureUsage` in `src/usage.mjs`**

Regex per field, global flag, loop matches and keep the last; `captureUsage` per the Interfaces block above, using `node:stream`'s `PassThrough` and `node:zlib`'s `createGunzip`/`createBrotliDecompress`/`createInflate`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/usage.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/usage.mjs test/usage.test.mjs
git commit -m "feat: add SSE usage/model extraction and capture"
```

---

### Task 3: Wire decision logging + usage capture into the Claude proxy

**Files:**
- Modify: `src/proxy.mjs` (`startProxy`, around line 203–341 per the current file)
- Modify: `bin/jev-daemon.mjs` (`runForeground`'s `startProxy({ port })` call, in `src/daemon.mjs`)
- Modify: `bin/jev-claude.mjs` (`startProxy()` call)
- Test: `test/proxy.test.mjs`

**Interfaces:**
- Consumes: `appendLine` (Task 1), `captureUsage` (Task 2), `statePaths` (`src/daemon.mjs`, already modified in Task 1).
- Produces: `startProxy({ port, upstream, decisionLogFile = null, trimDecisionLog: trimLog = false })` — two new options, both optional, defaulting to "logging disabled" so every existing call site and test keeps working unchanged. When `decisionLogFile` is set, a `decision` row is appended whenever the existing `fresh` value is non-null (i.e. a prompt was actually routed this turn) and the request is a main-agent turn (the same `!subagent && !state.isSubagent(key)` guard already used for `writeStatus`), and `captureUsage` is invoked on the upstream response with the same `reqId`. `trimLog` is passed straight to a `trimDecisionLog` call made once, after the `appendLine`, only when true.

- [ ] **Step 1: Write the failing test**

```js
// test/proxy.test.mjs addition
test("logs a decision row with the reqId usage capture uses, when decisionLogFile is set", async () => {
  const file = join(tmpdir(), `decisions-${Date.now()}.jsonl`);
  const { port, close } = await startProxy({ upstream: mockUpstreamUrl, decisionLogFile: file });
  await postRoutedTurn(port); // existing test helper that sends one routed /v1/messages turn
  await close();
  const row = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]);
  assert.equal(row.kind, "decision");
  assert.equal(row.provider, "claude");
  assert.ok(row.reqId);
  assert.equal(typeof row.to, "string");
});

test("never logs a decision row for a sub-agent turn", async () => {
  const file = join(tmpdir(), `decisions-${Date.now()}.jsonl`);
  const { port, close } = await startProxy({ upstream: mockUpstreamUrl, decisionLogFile: file });
  await postSubagentTurn(port); // existing sub-agent test helper
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/proxy.test.mjs`
Expected: FAIL — no `decisions-*.jsonl` is written; `row.kind` undefined.

- [ ] **Step 3: Implement the wiring in `src/proxy.mjs`, then thread the options through in `src/daemon.mjs` and `bin/jev-claude.mjs`**

In `src/proxy.mjs`:
- Add `decisionLogFile = null, trimDecisionLog: trimLog = false` to `startProxy`'s destructured options.
- Import `randomUUID` alongside the existing `createHash` import from `node:crypto`.
- Import `appendLine, trimDecisionLog` from `./decision-log.mjs` and `captureUsage` from `./usage.mjs`.
- Inside the `req.on("end", async () => {...})` handler, declare `let decisionRow = null;` near the top (beside `let out = Buffer.concat(chunks);`).
- In the branch that currently ends with `if (!subagent && !state.isSubagent(key)) { writeStatus(session, { tier, ...fresh, at: Date.now() }); }`, add right after it:
  ```js
  if (decisionLogFile && fresh) {
    decisionRow = {
      kind: "decision", reqId: randomUUID(), ts: Date.now(), provider: "claude",
      session, convo: key, from: current, to: tier, reason: fresh.reason,
      contextTokens, policyVersion: 1, judgments: null,
      probabilities: jev?.probabilities ?? null,
    };
    appendLine(decisionLogFile, decisionRow);
    if (trimLog) trimDecisionLog(decisionLogFile);
  }
  ```
  (guarded by the same `!subagent && !state.isSubagent(key)` condition that already wraps the `writeStatus` call above it — place it inside that same `if` block, not after it).
- In the response callback (`(up) => { res.writeHead(...); announceServedModel(up, "claude", up.statusCode); up.pipe(res); }`), add before `up.pipe(res)`:
  ```js
  if (decisionRow) captureUsage({ stream: up, reqId: decisionRow.reqId, file: decisionLogFile });
  ```

In `src/daemon.mjs`'s `runForeground`, change `const proxy = await startProxy({ port });` to pass `decisionLogFile: paths.decisions, trimDecisionLog: true`.

In `bin/jev-claude.mjs`, import `statePaths` from `../src/daemon.mjs` and change `const { port, close } = await startProxy();` to pass `decisionLogFile: statePaths().decisions` (no `trimDecisionLog` — the per-session launcher is never the trim owner).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/proxy.test.mjs`
Expected: PASS, and the full existing suite still passes: `npm test`

- [ ] **Step 5: Commit**

```bash
git add src/proxy.mjs src/daemon.mjs bin/jev-claude.mjs test/proxy.test.mjs
git commit -m "feat: log Claude routing decisions and capture real usage"
```

---

### Task 4: Wire decision logging into the Codex and Grok proxies

**Files:**
- Modify: `src/codex-proxy.mjs` (`startCodexProxy`)
- Modify: `src/grok-proxy.mjs` (`startGrokProxy`)
- Modify: `bin/jev-codex.mjs`, `bin/jev-grok.mjs`
- Test: `test/codex.test.mjs`, `test/grok.test.mjs`

**Interfaces:**
- Consumes: `appendLine` (Task 1), `statePaths` (`src/daemon.mjs`).
- Produces: `startCodexProxy({ ..., decisionLogFile = null })` and `startGrokProxy({ ..., decisionLogFile = null })` each gain the one new option. When set, a `decision` row (`provider: "codex"` / `"grok"`, `usage: null, servedModel: null`, otherwise the same shape as Task 3's Claude row) is appended for every routed main-agent turn — i.e. inside the existing `if (prompt) { ... }` block in each file, right after `states.set(key, tier)` / `streaks.set(key, decision.cheapStreak)`. Side requests (the `isAgentSession(body)` false branch) are never logged, matching "sub-agents skipped."

- [ ] **Step 1: Write the failing tests**

```js
// test/codex.test.mjs addition
test("logs a decision row for a routed agent turn", async () => {
  const file = join(tmpdir(), `codex-decisions-${Date.now()}.jsonl`);
  const { port, close } = await startCodexProxy({ decisionLogFile: file, route: fakeRoute /* existing test fixture */ });
  await postAgentTurn(port); // existing helper in this test file
  await close();
  const row = JSON.parse(readFileSync(file, "utf8").trim());
  assert.equal(row.provider, "codex");
  assert.equal(row.usage, null);
});
```

```js
// test/grok.test.mjs addition — same shape, provider: "grok"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/codex.test.mjs test/grok.test.mjs`
Expected: FAIL — no file written.

- [ ] **Step 3: Implement the wiring in both proxy files, then thread the option through in the two launchers**

Mirror Task 3's `decisionRow` object shape (`kind: "decision", reqId: randomUUID(), ts, provider, session: null /* neither protocol carries one the same way Claude's does */, convo: key, from: current, to: tier, reason: decision.reason, contextTokens, policyVersion: 1, judgments: null, probabilities: jev?.probabilities ?? null, usage: null, servedModel: null`) and `appendLine` it. In `bin/jev-codex.mjs` / `bin/jev-grok.mjs`, pass `decisionLogFile: statePaths().decisions` into the respective start function, importing `statePaths` from `../src/daemon.mjs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/codex.test.mjs test/grok.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/codex-proxy.mjs src/grok-proxy.mjs bin/jev-codex.mjs bin/jev-grok.mjs test/codex.test.mjs test/grok.test.mjs
git commit -m "feat: log Codex and Grok routing decisions"
```

---

### Task 5: Price table and savings math

**Files:**
- Create: `src/price.mjs`
- Test: `test/price.test.mjs`

**Interfaces:**
- Produces: `PRICE_TABLE: Record<string, {input: number, output: number, cacheRead: number}>` keyed by Claude model id, USD per million tokens, list-price estimates, covering at least `claude-haiku-4-5-20251001`, `claude-sonnet-5`, `claude-opus-5` (the ids `config.mjs`'s `TIERS` resolves to by default).
- Produces: `costOf(modelId: string, usage: {inputTokens?, outputTokens?, cacheReadTokens?, cacheCreationTokens?}): number | null` — `null` when `modelId` is not in `PRICE_TABLE` or `usage` is `null`/empty; otherwise the USD cost using `cacheCreationTokens` at the `input` rate (cache writes bill as input) and every other field at its matching rate, missing fields treated as `0`.
- Produces: `computeSavings(rows: Array<{servedModel, usage}>, { baselineModel }): {actualUsd: number, baselineUsd: number, savedUsd: number, rowsWithUsage: number, rowsWithoutUsage: number}` — iterates `rows`, skips (and counts in `rowsWithoutUsage`) any row where `costOf(row.servedModel, row.usage)` is `null`; for the rest, sums `costOf(row.servedModel, row.usage)` into `actualUsd` and `costOf(baselineModel, row.usage)` into `baselineUsd`; `savedUsd = baselineUsd - actualUsd`.

- [ ] **Step 1: Write the failing tests**

```js
// test/price.test.mjs
test("costOf prices input, output and cache-read tokens separately", () => {
  const cost = costOf("claude-haiku-4-5-20251001", { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 });
  const expected = PRICE_TABLE["claude-haiku-4-5-20251001"].input + PRICE_TABLE["claude-haiku-4-5-20251001"].output + PRICE_TABLE["claude-haiku-4-5-20251001"].cacheRead;
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/price.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `PRICE_TABLE`, `costOf`, `computeSavings` in `src/price.mjs`**

Label the table with a code comment that these are list-price estimates, overridable only by editing this file this round (per the plan's scope cuts).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/price.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/price.mjs test/price.test.mjs
git commit -m "feat: add price table and savings computation"
```

---

### Task 6: Dashboard server (read, join, summarize)

**Files:**
- Create: `src/dashboard-server.mjs`
- Test: `test/dashboard-server.test.mjs`

**Interfaces:**
- Consumes: `computeSavings` (Task 5, `./price.mjs`).
- Produces: `readDecisions(decisionsFile: string, limit = 500): Array<object>` — reads and parses the JSONL file (missing file → `[]`, malformed line → skipped, never throws), splits rows by `kind`, and for each `decision` row attaches the matching `usage`/`servedModel` from any `usage` row sharing its `reqId` (absent → both stay `null`), returning the newest `limit` merged decision rows, newest first.
- Produces: `readSessionsMap(sessionsFile: string): Record<string, string>` — parses the `session_id → cwd` JSON map `rememberSession` (`src/preflight.mjs`) writes; missing/malformed file → `{}`.
- Produces: `projectOf(cwd: string | undefined): string` — `basename(cwd)` when `cwd` is a non-empty string, else the literal string `"unknown"`.
- Produces: `buildSummary(rows: Array<object>, { baselineModel }): {byTier: Record<string, number>, byProject: Record<string, number>, byProvider: Record<string, number>, savings: ReturnType<typeof computeSavings>}` — tallies `rows` by `to` (tier), `project`, and `provider`; `savings` is `computeSavings(rows, { baselineModel })`.
- Produces: `createDashboardServer({ port = 0, decisionsFile, sessionsFile, baselineModel = "claude-opus-5" }): Promise<{port: number, close(): void}>` — same construction pattern as `startProxy` (`http.createServer`, `server.listen(port, "127.0.0.1", resolve)`), routing `GET /` to one inline HTML/CSS/vanilla-JS page (a table that polls `/api/decisions` and a summary strip that polls `/api/summary`, no build step), `GET /api/decisions` (reads `?limit=`, defaulting to 500, calls `readDecisions` joined with `readSessionsMap`/`projectOf` for a `project` field on each row, responds `application/json`), and `GET /api/summary` (calls `readDecisions(decisionsFile, 20000)` then `buildSummary`, responds `application/json`); anything else → `404`.

- [ ] **Step 1: Write the failing tests**

```js
// test/dashboard-server.test.mjs
test("readDecisions joins a usage row onto its decision by reqId", () => {
  writeFileSync(file,
    JSON.stringify({ kind: "decision", reqId: "r1", ts: 1, to: "haiku" }) + "\n" +
    JSON.stringify({ kind: "usage", reqId: "r1", usage: { outputTokens: 5 }, servedModel: "m1" }) + "\n",
  );
  const [row] = readDecisions(file);
  assert.equal(row.to, "haiku");
  assert.deepEqual(row.usage, { outputTokens: 5 });
  assert.equal(row.servedModel, "m1");
});

test("readDecisions on a missing file returns an empty array", () => {
  assert.deepEqual(readDecisions(join(tmpdir(), "nope.jsonl")), []);
});

test("readDecisions skips a malformed line without throwing", () => {
  writeFileSync(file, "not json\n" + JSON.stringify({ kind: "decision", reqId: "r2", ts: 1, to: "sonnet" }) + "\n");
  const rows = readDecisions(file);
  assert.equal(rows.length, 1);
});

test("projectOf falls back to unknown when cwd is missing", () => {
  assert.equal(projectOf(undefined), "unknown");
  assert.equal(projectOf("/Users/x/my-project"), "my-project");
});

test("buildSummary tallies by tier and excludes usage-less rows from savings", () => {
  const rows = [
    { to: "haiku", project: "p1", provider: "claude", servedModel: "claude-haiku-4-5-20251001", usage: { outputTokens: 10 } },
    { to: "opus", project: "p1", provider: "codex", servedModel: null, usage: null },
  ];
  const summary = buildSummary(rows, { baselineModel: "claude-opus-5" });
  assert.equal(summary.byTier.haiku, 1);
  assert.equal(summary.byProvider.codex, 1);
  assert.equal(summary.savings.rowsWithoutUsage, 1);
});

test("GET /api/decisions and /api/summary respond 200 with JSON over a joined fixture log", async () => {
  // write a small fixture log + sessions map, start the server on port 0
  const { port, close } = await createDashboardServer({ decisionsFile, sessionsFile });
  const decisions = await fetch(`http://127.0.0.1:${port}/api/decisions`).then((r) => r.json());
  const summary = await fetch(`http://127.0.0.1:${port}/api/summary`).then((r) => r.json());
  assert.ok(Array.isArray(decisions));
  assert.ok(summary.savings);
  await close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/dashboard-server.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `readDecisions`, `readSessionsMap`, `projectOf`, `buildSummary`, `createDashboardServer` in `src/dashboard-server.mjs`**

The inline HTML page is functional and plain per the spec's "lite scope" — a `<table>` and a summary strip, vanilla `fetch` on an interval, no CSS framework.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/dashboard-server.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard-server.mjs test/dashboard-server.test.mjs
git commit -m "feat: add dashboard server with decisions/summary endpoints"
```

---

### Task 7: `jev-dashboard` CLI + `jev-router dashboard` alias

**Files:**
- Create: `bin/jev-dashboard.mjs`
- Modify: `bin/jev-router.mjs`
- Modify: `package.json` (`bin`)
- Test: `test/launchers.test.mjs` (or a new `test/jev-dashboard.test.mjs` if the existing file's fixtures don't fit a server-process launcher)

**Interfaces:**
- Consumes: `createDashboardServer` (Task 6, `../src/dashboard-server.mjs`), `statePaths` (`../src/daemon.mjs`).
- Produces: running `node bin/jev-dashboard.mjs [--port N]` starts the server on `JEV_DASHBOARD_PORT` or `61821` (flag wins over env), prints `[jev-dashboard] http://127.0.0.1:<port>` to stdout, and exits cleanly on `SIGINT`/`SIGTERM` after calling `close()`.
- Produces: `jev-router dashboard [...]` spawns `bin/jev-dashboard.mjs` with the remaining args, mirroring the existing `daemon` alias's `spawnSync`/exit-code forwarding in `bin/jev-router.mjs` — every other first token keeps going to `jev-daemon.mjs` exactly as today.

- [ ] **Step 1: Write the failing test**

```js
// test/launchers.test.mjs addition (or new file)
test("jev-router dashboard forwards to jev-dashboard.mjs, not jev-daemon.mjs", () => {
  const result = spawnSync(process.execPath, [ROUTER_BIN, "dashboard", "--port", "0"], { timeout: 2000 });
  // jev-dashboard.mjs never exits on its own (it's a server), so a 2s timeout is expected and
  // the SIGTERM result is read; the assertion is on stdout, not the exit code.
  assert.match(result.stdout.toString(), /\[jev-dashboard\] http:\/\/127\.0\.0\.1:/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/launchers.test.mjs`
Expected: FAIL — `jev-router dashboard` prints `jev-daemon`'s usage line instead.

- [ ] **Step 3: Implement `bin/jev-dashboard.mjs`; modify `bin/jev-router.mjs`'s dispatch; add the `package.json` bin entry**

In `bin/jev-router.mjs`, add a `DASHBOARD_BIN` resolved the same way as `DAEMON_BIN`, and branch: `if (argv[0] === "dashboard") { spawn DASHBOARD_BIN with argv.slice(1) }` before the existing `daemon`/forward-to-`DAEMON_BIN` logic, keeping that existing logic untouched for every other first token.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/launchers.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/jev-dashboard.mjs bin/jev-router.mjs package.json test/launchers.test.mjs
git commit -m "feat: add jev-dashboard CLI and jev-router dashboard alias"
```
