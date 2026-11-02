# Extension Routing Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every Claude Code session — including ones the VS Code extension opens, in any project — through a long-lived local Jev proxy, installed once.

**Architecture:** A background daemon runs `src/proxy.mjs` on a fixed loopback port under a launchd agent. One install command merges `ANTHROPIC_BASE_URL`, the model-picker vars and a `SessionStart` preflight hook into `~/.claude/settings.json`, whose `env` block Claude Code applies to every launch — CLI or extension. The preflight hook resurrects a dead daemon, and un-patches the settings if it cannot, so a broken daemon never locks the user out. Two routing-layer corrections come with it: the proxy's per-conversation state becomes idle-time-aged instead of count-capped (a daemon lives for weeks), and `decide()` gates on the top answer's probability instead of the distribution's concentration.

**Tech Stack:** Node 22+, ESM `.mjs`, `node --test`, zero new runtime dependencies (`@typesafe-ai/sdk` remains the only one), macOS launchd for autostart.

**Spec:** `docs/superpowers/specs/2026-11-02-daemon-dashboard-design.md`

Decision logging, upstream `usage` capture and the dashboard are **Plan 2** — the spec's observability half, shippable on its own. This plan stops at the point where extension sessions are routed.

## Global Constraints

- Node.js `>=22` (`package.json` `engines`); ESM only, `.mjs` everywhere.
- No new runtime dependencies. Dev-time: `node --test` only.
- Every listener binds `127.0.0.1` exclusively.
- Routing is fail-open: every error path keeps the model the session already had.
- No prompt text and no credential is ever written to disk by code added here.
- New source files go in `src/` as kebab-case `.mjs`; tests in `test/<name>.test.mjs` using `node:test` + `node:assert/strict`.
- Daemon fixed port: default `61820`, overridable with `JEV_DAEMON_PORT`.
- Daemon state directory: `~/.jev-router/` holding `daemon.pid`, `daemon.port`, `daemon.log`, `install.json`, `sessions.json`.
- launchd label: `com.flaviusapop.jev-router.daemon`; plist at `~/Library/LaunchAgents/<label>.plist`.
- Comment style follows this codebase: say *why*, with the measurement or failure that motivated it, not *what*.

## Review Focus

1. **Port already owned by a stranger.** A 200 to `HEAD` without the `x-jev-router` marker must make `start` and `install` refuse and name the port — never no-op into pointing Claude Code at a foreign server. (Task 3, Task 5)
2. **`~/.claude/settings.json` is malformed, missing, read-only or a symlink.** Patching must fail loudly and leave the file exactly as it was; a crash mid-write that truncates this file breaks all of Claude Code. Atomic temp-then-rename, symlink target preserved. (Task 4)
3. **Claude Code writes that same file concurrently** (it saves `model` when a picker row is chosen with Enter). A read-modify-write must re-read immediately before the rename and must never drop a key it did not set. (Task 4)
4. **`launchctl` missing, failing, or not macOS.** Install must not leave a half-state: either plist loaded *and* settings patched, or neither, with a message saying which. (Task 5)
5. **Stale pid file** — the daemon was SIGKILLed, the OS reused its pid. `status` and `start` must verify liveness by the marker probe, not by pid existence, or `start` silently no-ops forever. (Task 3)

---

### Task 1: Gate on the top answer's probability

**Files:**
- Modify: `src/config.mjs` (`THRESHOLDS.minConfidence`)
- Modify: `src/policy.mjs:96-102` (the confidence branch in `decide`)
- Test: `test/probability.test.mjs` (create)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `THRESHOLDS.minTopProbability` (number, replaces `minConfidence`); `decide()`'s signature is unchanged, and its `jev` argument now reads `{choice, confidence?, probabilities?}` where `probabilities[choice]` wins when present.

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/policy.mjs";
import { THRESHOLDS } from "../src/config.mjs";

const ALL = ["haiku", "sonnet", "opus", "fable"];
const at = (jev, current = "opus") =>
  decide({ prompt: "what changed here", jev, current, available: ALL, contextTokens: 0 });

test("a spread distribution does not downgrade, even at high confidence", () => {
  // confidence measures how concentrated the distribution is, not how likely the top answer
  // is to be right. These two disagree exactly where the gate matters.
  const jev = { choice: "haiku", confidence: 0.95, probabilities: { haiku: 0.4, sonnet: 0.35, opus: 0.2, fable: 0.05 } };
  assert.equal(at(jev).tier, "opus");
  assert.equal(at(jev).reason, "low-confidence-no-downgrade/no-change");
});

test("a settled distribution downgrades, even at low confidence", () => {
  const jev = { choice: "haiku", confidence: 0.2, probabilities: { haiku: 0.9, sonnet: 0.06, opus: 0.03, fable: 0.01 } };
  assert.equal(at(jev).tier, "haiku");
  assert.equal(at(jev).reason, "jev");
});

test("an answer with no probabilities still works off confidence", () => {
  assert.equal(at({ choice: "haiku", confidence: 0.95 }).tier, "haiku");
  assert.equal(at({ choice: "haiku", confidence: 0.3 }).tier, "opus");
});

test("the threshold is named for what it now measures", () => {
  assert.equal(typeof THRESHOLDS.minTopProbability, "number");
  assert.equal(THRESHOLDS.minConfidence, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/probability.test.mjs`
Expected: FAIL — the spread distribution downgrades, and `minTopProbability` is undefined.

- [ ] **Step 3: Rename `THRESHOLDS.minConfidence` to `minTopProbability` (value unchanged at `0.6`) and read the gate from `jev.probabilities?.[jev.choice] ?? jev.confidence` in `decide()`**

Every other branch, threshold, reason string and fallback in `decide()` stays byte-identical: this is a substitution of the number the policy always meant, not a policy change. Keep the `confidence` fallback so an answer without a distribution still routes. Update the comment on the threshold to say why probability, not concentration, is the right measure, and update `src/router.mjs`'s doc comment where it describes what the policy layer reads.

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS. `test/policy.test.mjs` and `test/ratchet.test.mjs` pass unchanged — they supply `confidence` only, which still works. If either referenced `minConfidence` by name, update that reference.

- [ ] **Step 5: Commit**

```bash
git add src/config.mjs src/policy.mjs src/router.mjs test/probability.test.mjs
git commit -m "fix: gate routing on the top answer's probability, not its confidence"
```

---

### Task 2: Age the proxy's state by idle time, not by count

**Files:**
- Create: `src/proxy-state.mjs`
- Modify: `src/proxy.mjs:183-203` (replace the four inline collections), `src/proxy.mjs:222-289` (call sites)
- Test: `test/proxy-state.test.mjs` (create)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `createProxyState({ ttlMs = 12 * 60 * 60 * 1000, max = 2000, now = Date.now } = {})` returning
  `{ conversation(key), isRouted(session), markRouted(session), isSubagent(key), markSubagent(key), isManual(key), markManual(key), forget(key), size() }`.
  `conversation(key)` returns the same mutable `{ tier, cheapStreak }` object for a key until it is evicted, and touches its `lastSeen`. Eviction drops entries idle past `ttlMs`; past `max` live entries, the least-recently-seen goes first.

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createProxyState } from "../src/proxy-state.mjs";

const clock = (start = 0) => { let t = start; return { now: () => t, advance: (ms) => (t += ms) }; };

test("an entry survives any number of turns while it stays active", () => {
  const c = clock();
  const state = createProxyState({ ttlMs: 1000, now: c.now });
  state.conversation("a").tier = "opus";
  for (let i = 0; i < 10; i++) { c.advance(900); assert.equal(state.conversation("a").tier, "opus"); }
});

test("an idle entry is dropped once it passes the TTL", () => {
  const c = clock();
  const state = createProxyState({ ttlMs: 1000, now: c.now });
  state.conversation("a").tier = "opus";
  c.advance(1001);
  assert.equal(state.conversation("a").tier, null);
});

test("past the hard cap the least recently seen goes first, not the active one", () => {
  // The daemon serves every window of every project. The old count-50 cap evicted mid-turn,
  // which made a follow-up request fall back to sonnet and rewrite the model mid-task.
  const c = clock();
  const state = createProxyState({ ttlMs: 1e9, max: 2, now: c.now });
  state.conversation("a").tier = "opus";
  c.advance(1); state.conversation("b").tier = "haiku";
  c.advance(1); state.conversation("a");           // a is now the most recent
  c.advance(1); state.conversation("c").tier = "fable";
  assert.equal(state.conversation("a").tier, "opus");
  assert.equal(state.conversation("b").tier, null);
});

test("session, sub-agent and manual marks age the same way and do not grow without bound", () => {
  const c = clock();
  const state = createProxyState({ ttlMs: 1000, now: c.now });
  state.markRouted("s1"); state.markSubagent("k1"); state.markManual("k2");
  assert.deepEqual([state.isRouted("s1"), state.isSubagent("k1"), state.isManual("k2")], [true, true, true]);
  c.advance(1001);
  assert.deepEqual([state.isRouted("s1"), state.isSubagent("k1"), state.isManual("k2")], [false, false, false]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/proxy-state.test.mjs`
Expected: FAIL with "Cannot find module '../src/proxy-state.mjs'".

- [ ] **Step 3: Implement `createProxyState` in `src/proxy-state.mjs`**

One `Map` per kind, each value carrying `lastSeen`; a read touches it. Sweep lazily on access rather than on a timer — a daemon must not hold the event loop open with an interval, and the spec's `--foreground` launchd job should exit cleanly on SIGTERM.

- [ ] **Step 4: Rewire `src/proxy.mjs` onto it**

Replace `convos`/`routedSessions`/`subagents`/`manual` and the local `stateFor` with one `createProxyState()`; `startProxy` keeps its current signature. The `manual` semantics the file documents at length (a pick outlives eviction of the conversation) now mean "outlives it until the TTL", which the comment there must say.

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS, including `test/subagent.test.mjs` and `test/proxy.test.mjs` unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/proxy-state.mjs src/proxy.mjs test/proxy-state.test.mjs
git commit -m "fix: age proxy state by idle time so a long-lived daemon cannot evict an active turn"
```

---

### Task 3: The daemon, on a fixed port, identifiable

**Files:**
- Modify: `src/proxy.mjs` (`startProxy` gains a port; the `HEAD` reply gains a marker header)
- Create: `src/daemon.mjs`, `bin/jev-daemon.mjs`
- Modify: `package.json` (`bin`, `files`)
- Test: `test/daemon.test.mjs` (create)

**Interfaces:**
- Consumes: `createProxyState` (Task 2) via `startProxy`.
- Produces:
  - `startProxy({ port = 0 } = {})` → `{ port, close }` (unchanged shape).
  - `MARKER_HEADER = "x-jev-router"` exported from `src/proxy.mjs`.
  - From `src/daemon.mjs`: `DEFAULT_PORT`, `statePaths(home)` → `{ dir, pid, port, log, install }`, `probe(port)` → `Promise<"ours" | "foreign" | "dead">`, `startDaemon({ port, foreground })` → `Promise<{port, pid, already: boolean}>`, `stopDaemon()` → `Promise<{stopped: boolean, via: "launchd" | "signal" | "none"}>`, `daemonStatus()` → `Promise<{running, port, pid, via, plist}>`.

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy, MARKER_HEADER } from "../src/proxy.mjs";
import { probe } from "../src/daemon.mjs";

const listen = (handler) => new Promise((done) => {
  const s = http.createServer(handler);
  s.listen(0, "127.0.0.1", () => done({ port: s.address().port, close: () => s.close() }));
});

test("our own proxy answers the probe with a marker", async () => {
  const proxy = await startProxy({ port: 0 });
  assert.equal(await probe(proxy.port), "ours");
  proxy.close();
});

test("a stranger on the port answers 200 but is not us", async () => {
  // Claude Code probes the base URL with HEAD before its first request, so any server at all
  // answers 200. Without the marker, install would point every session at it.
  const other = await listen((req, res) => res.writeHead(200).end());
  assert.equal(await probe(other.port), "foreign");
  other.close();
});

test("nothing listening reads as dead, not as an error", async () => {
  const free = await listen(() => {});
  const port = free.port;
  free.close();
  assert.equal(await probe(port), "dead");
});

test("the proxy binds loopback only", async () => {
  const proxy = await startProxy({ port: 0 });
  await assert.rejects(() => fetch(`http://${(await import("node:os")).hostname()}:${proxy.port}/`));
  proxy.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/daemon.test.mjs`
Expected: FAIL — `MARKER_HEADER` and `src/daemon.mjs` do not exist.

- [ ] **Step 3: Add the port argument and the marker to `src/proxy.mjs`**

`startProxy({ port = 0 } = {})`, and the existing `HEAD` branch answers `200` with `{ [MARKER_HEADER]: version }` read from `package.json`. Keep the 200 status and empty body Claude Code already depends on.

- [ ] **Step 4: Implement `src/daemon.mjs`**

`probe` sends `HEAD /` to `127.0.0.1:<port>` with a short timeout and classifies by the marker. `startDaemon` probes first (`"ours"` → `{already: true}`; `"foreign"` → throw naming the port and `JEV_DAEMON_PORT`), then starts: in `foreground` it is the proxy and writes the pid/port files, otherwise it re-spawns itself detached with `--foreground` and waits for the probe to turn `"ours"`. Liveness is always the probe, never the pid file, which may be stale after a SIGKILL and a reused pid. `stopDaemon` prefers launchd when the plist is loaded (Task 5 supplies `launchdLoaded()`; until then, signal only) and falls back to SIGTERM from the pid file, cleaning both files either way.

- [ ] **Step 5: Implement `bin/jev-daemon.mjs`**

`start [--foreground] [--port N]`, `stop`, `restart`, `status`. `loadEnv()` first, exactly as the other launchers do. Human-readable one-line output per command; non-zero exit on refusal. `install`/`uninstall` arrive in Task 5.

- [ ] **Step 6: Add the bin entry**

`package.json`: `"jev-daemon": "bin/jev-daemon.mjs"`, and `bin`/`src` are already in `files`.

- [ ] **Step 7: Run the suite and the daemon by hand**

Run: `node --test` then `node bin/jev-daemon.mjs start --port 61899 && node bin/jev-daemon.mjs status && node bin/jev-daemon.mjs stop`
Expected: tests PASS; status reports running on 61899 then stop reports it stopped.

- [ ] **Step 8: Commit**

```bash
git add src/proxy.mjs src/daemon.mjs bin/jev-daemon.mjs package.json test/daemon.test.mjs
git commit -m "feat: run the proxy as a daemon on a fixed, identifiable port"
```

---

### Task 4: Patch and un-patch Claude Code's settings

**Files:**
- Create: `src/claude-settings.mjs`
- Test: `test/claude-settings.test.mjs` (create)

**Interfaces:**
- Consumes: `autoModelEnv()` — extracted from `bin/jev-claude.mjs:23-41` into `src/claude-settings.mjs` and imported back by the launcher, so the picker vars have one definition.
- Produces: `patchSettings({ file, port, hookCommand, bookkeeping })` → `{ changed: string[], skipped: string[] }` and `unpatchSettings({ file, bookkeeping })` → `{ restored: string[] }`. `bookkeeping` is the path to `~/.jev-router/install.json`, where prior values and "this key was ours" records live — never inside `settings.json` itself.

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchSettings, unpatchSettings } from "../src/claude-settings.mjs";

const sandbox = (settings) => {
  const dir = mkdtempSync(join(tmpdir(), "jev-install-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify(settings, null, 2));
  return { file, bookkeeping: join(dir, "install.json"), read: () => JSON.parse(readFileSync(file, "utf8")) };
};
const patch = (s) => patchSettings({ file: s.file, port: 61820, hookCommand: "jev-router preflight", bookkeeping: s.bookkeeping });

test("patches env and the hook while preserving every unrelated key", () => {
  const s = sandbox({
    env: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" },
    permissions: { allow: ["Bash(rtk git *)"] },
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "gbrain hook session-start" }] }] },
    enabledPlugins: { "caveman@caveman": true },
  });
  patch(s);
  const out = s.read();
  assert.equal(out.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:61820");
  assert.equal(out.env.ANTHROPIC_MODEL, "jev-auto");
  assert.equal(out.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, "1");
  assert.equal(out.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, "Jev Router");
  assert.equal(out.hooks.SessionStart.length, 2, "appended, never replaced");
  assert.deepEqual(out.permissions.allow, ["Bash(rtk git *)"]);
  assert.deepEqual(out.enabledPlugins, { "caveman@caveman": true });
});

test("a status line the user chose is left alone and reported as skipped", () => {
  const s = sandbox({ statusLine: { type: "command", command: "caveman-statusline.sh" } });
  const { skipped } = patch(s);
  assert.equal(s.read().statusLine.command, "caveman-statusline.sh");
  assert.ok(skipped.includes("statusLine"));
});

test("a model the user already set is not overwritten", () => {
  const s = sandbox({ env: { ANTHROPIC_MODEL: "claude-opus-5" } });
  patch(s);
  assert.equal(s.read().env.ANTHROPIC_MODEL, "claude-opus-5");
});

test("unpatch removes exactly what patch added and restores what it replaced", () => {
  const before = { env: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "gbrain hook session-start" }] }] } };
  const s = sandbox(before);
  patch(s);
  unpatchSettings({ file: s.file, bookkeeping: s.bookkeeping });
  assert.deepEqual(s.read(), before);
});

test("a malformed settings file is refused without being touched", () => {
  const s = sandbox({});
  writeFileSync(s.file, "{ not json");
  assert.throws(() => patch(s), /settings\.json/);
  assert.equal(readFileSync(s.file, "utf8"), "{ not json");
});

test("an unwritable settings file is refused without being truncated", () => {
  const s = sandbox({ env: {} });
  chmodSync(s.file, 0o444);
  assert.throws(() => patch(s));
  assert.deepEqual(JSON.parse(readFileSync(s.file, "utf8")), { env: {} });
  chmodSync(s.file, 0o644);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/claude-settings.test.mjs`
Expected: FAIL with "Cannot find module '../src/claude-settings.mjs'".

- [ ] **Step 3: Implement `patchSettings` / `unpatchSettings` in `src/claude-settings.mjs`**

Read, parse, patch in memory, write to a temp file in the same directory and `rename` over the target — atomic, so a crash cannot truncate the file every Claude Code session depends on. Re-read immediately before the rename and re-apply onto that content, because Claude Code writes `model` to this same file when a picker row is chosen. Resolve a symlinked path first so the link is followed, not replaced. Record in `bookkeeping` which keys were added and any prior value, so `unpatchSettings` can restore exactly and leave anything it did not set alone.

- [ ] **Step 4: Move `autoModelEnv()` into this module and import it in `bin/jev-claude.mjs`**

Same values; `bin/jev-claude.mjs` keeps behaving identically, now with one source for the picker vars.

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS, `test/launchers.test.mjs` included.

- [ ] **Step 6: Commit**

```bash
git add src/claude-settings.mjs bin/jev-claude.mjs test/claude-settings.test.mjs
git commit -m "feat: merge routing config into Claude Code's own settings, reversibly"
```

---

### Task 5: Install and uninstall the launchd agent

**Files:**
- Create: `src/launchd.mjs`
- Modify: `bin/jev-daemon.mjs` (`install`, `uninstall`, and `status` reporting plist health), `src/daemon.mjs` (`stopDaemon` uses `launchdLoaded()`)
- Test: `test/launchd.test.mjs` (create)

**Interfaces:**
- Consumes: `patchSettings`/`unpatchSettings` (Task 4), `probe`/`statePaths` (Task 3), `jevKey`/`loadEnv` (`src/env.mjs`), `ENV_FILE_HINT`.
- Produces: `LABEL`, `plistPath(home)`, `plistFor({ node, script, port, log })` → XML string, `launchdLoaded()` → `Promise<boolean>`, `installAgent({ port, home })` → `Promise<{plist, patched}>`, `uninstallAgent({ home })`, `verifyAgent({ home })` → `{ ok, reasons: string[] }`.

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { plistFor, LABEL } from "../src/launchd.mjs";

const xml = plistFor({ node: "/opt/homebrew/bin/node", script: "/x/bin/jev-daemon.mjs", port: 61820, log: "/x/daemon.log" });

test("the agent runs the daemon in the foreground, at load, and keeps it alive", () => {
  assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>${LABEL}</string>`));
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.ok(xml.includes("<string>--foreground</string>"));
  assert.ok(xml.includes("<string>/opt/homebrew/bin/node</string>"));
});

test("launchd gets a near-empty environment, so the port travels in the plist", () => {
  // Anything exported from a shell profile is invisible to a launchd job: the key and the tier
  // overrides have to live in ~/.jev-router.env, and only the port is passed here.
  assert.match(xml, /<key>JEV_DAEMON_PORT<\/key>\s*<string>61820<\/string>/);
  assert.ok(!xml.includes("JEV_API_KEY"), "a key is never written into a plist");
});

test("both streams land in the daemon log", () => {
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/x\/daemon\.log<\/string>/);
});

test("paths with XML-significant characters are escaped", () => {
  const odd = plistFor({ node: "/x/n&d", script: "/x/<s>.mjs", port: 1, log: "/x/l" });
  assert.ok(odd.includes("/x/n&amp;d"));
  assert.ok(odd.includes("/x/&lt;s&gt;.mjs"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/launchd.test.mjs`
Expected: FAIL with "Cannot find module '../src/launchd.mjs'".

- [ ] **Step 3: Implement `src/launchd.mjs`**

`plistFor` builds the XML with every interpolated value escaped. `installAgent` ordering matters, because a half-install is the failure mode the spec names: refuse first if `jevKey()` is unresolvable from the files `loadEnv()` reads (message points at `ENV_FILE_HINT()`), refuse if `probe(port)` is `"foreign"`, then write and load the plist and start the job, and only once the probe reads `"ours"` call `patchSettings`. If loading fails, remove the plist and leave the settings untouched. `verifyAgent` checks that the plist's node binary and script path still exist and that the recorded version matches the installed `package.json` — `nvm`/Homebrew move these, and `KeepAlive` turns a stale path into a respawn loop. `launchctl` absent or non-macOS fails with one clear line and no state change.

- [ ] **Step 4: Wire `install`, `uninstall` and `status` into `bin/jev-daemon.mjs`**

`install` prints each key it changed, each it skipped, and the single command that undoes it. `status` adds the plist's health from `verifyAgent`, saying "re-run `jev-daemon install`" when it fails. `stopDaemon` now prefers `launchctl` when `launchdLoaded()`, and `stop` warns that sessions already open keep pointing at the port until a restart.

- [ ] **Step 5: Run the suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/launchd.mjs src/daemon.mjs bin/jev-daemon.mjs test/launchd.test.mjs
git commit -m "feat: install the daemon as a launchd agent and patch settings in one step"
```

---

### Task 6: The preflight hook

**Files:**
- Create: `src/preflight.mjs`
- Modify: `bin/jev-daemon.mjs` (expose `preflight` so the hook has a command to call)
- Test: `test/preflight.test.mjs` (create)

**Interfaces:**
- Consumes: `probe`, `startDaemon`, `statePaths` (Task 3); `unpatchSettings` (Task 4).
- Produces: `preflight({ input, port, paths, deps })` → `Promise<{outcome: "healthy" | "revived" | "disarmed", notice: ?string}>`, where `input` is the hook's stdin JSON (`{session_id, cwd}`) and `deps` is `{probe, startDaemon, unpatchSettings}` for injection. Also `rememberSession({ file, sessionId, cwd, max = 200 })`, which Plan 2's dashboard joins against.

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight, rememberSession } from "../src/preflight.mjs";

const paths = () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-preflight-"));
  return { sessions: join(dir, "sessions.json"), settings: join(dir, "settings.json"), bookkeeping: join(dir, "install.json") };
};
const input = { session_id: "ses-1", cwd: "/Users/it/Documents/MySource/jev-router" };

test("a healthy daemon costs one probe and records the session's project", async () => {
  const p = paths();
  const out = await preflight({ input, port: 1, paths: p, deps: { probe: async () => "ours" } });
  assert.equal(out.outcome, "healthy");
  assert.equal(JSON.parse(readFileSync(p.sessions, "utf8"))["ses-1"], input.cwd);
});

test("a dead daemon is started, which fixes the session already starting", async () => {
  let started = 0;
  const out = await preflight({
    input, port: 1, paths: paths(),
    deps: { probe: async () => (started ? "ours" : "dead"), startDaemon: async () => { started++; return { already: false }; } },
  });
  assert.equal(out.outcome, "revived");
  assert.equal(started, 1);
});

test("a daemon that cannot be revived disarms the patch so the next session is plain Claude Code", async () => {
  let unpatched = 0;
  const out = await preflight({
    input, port: 1, paths: paths(),
    deps: { probe: async () => "dead", startDaemon: async () => { throw new Error("port 61820 is taken"); }, unpatchSettings: () => unpatched++ },
  });
  assert.equal(out.outcome, "disarmed");
  assert.equal(unpatched, 1);
  assert.match(out.notice, /61820|routing is off/i);
});

test("the session map is bounded and keeps the newest entries", () => {
  const file = join(mkdtempSync(join(tmpdir(), "jev-sessions-")), "sessions.json");
  for (let i = 0; i < 5; i++) rememberSession({ file, sessionId: `s${i}`, cwd: `/p/${i}`, max: 3 });
  const map = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(Object.keys(map).length, 3);
  assert.equal(map.s4, "/p/4");
  assert.equal(map.s0, undefined);
});

test("a corrupt session map is replaced, not thrown over", () => {
  const file = join(mkdtempSync(join(tmpdir(), "jev-sessions-")), "sessions.json");
  writeFileSync(file, "{{{");
  rememberSession({ file, sessionId: "s1", cwd: "/p" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).s1, "/p");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/preflight.test.mjs`
Expected: FAIL with "Cannot find module '../src/preflight.mjs'".

- [ ] **Step 3: Implement `src/preflight.mjs`**

The three branches above, in that order. It must stay well inside a hook timeout, so the probe and the post-start wait are short and the whole thing is best-effort: an unexpected failure resolves `healthy` rather than rejecting, because a hook that throws must never be what stops a session from opening. `rememberSession` is insertion-ordered, trimmed from the front, and rewrites atomically.

- [ ] **Step 4: Add the `preflight` subcommand to `bin/jev-daemon.mjs`**

Reads the hook JSON from stdin, calls `preflight`, prints `notice` when there is one, always exits 0.

- [ ] **Step 5: Run the suite and the hook by hand**

Run: `node --test` then `echo '{"session_id":"x","cwd":"/tmp"}' | node bin/jev-daemon.mjs preflight`
Expected: tests PASS; the command prints nothing or one notice line, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/preflight.mjs bin/jev-daemon.mjs test/preflight.test.mjs
git commit -m "feat: add a preflight hook that revives the daemon or disarms the patch"
```

---

### Task 7: `jev-router` umbrella command and the README

**Files:**
- Create: `bin/jev-router.mjs`
- Modify: `package.json` (`bin`), `README.md`
- Test: `test/launchers.test.mjs` (extend)

**Interfaces:**
- Consumes: every subcommand from Tasks 3, 5 and 6.
- Produces: `jev-router daemon <start|stop|restart|status|install|uninstall>`, `jev-router preflight`. A thin dispatcher: it re-executes `bin/jev-daemon.mjs` with the remaining arguments and nothing more.

- [ ] **Step 1: Write the failing test**

Extend `test/launchers.test.mjs` in its existing style (it already runs each launcher for real):

```js
test("jev-router dispatches daemon subcommands and refuses unknown ones", () => {
  const ok = spawnSync(process.execPath, [join(HERE, "..", "bin", "jev-router.mjs"), "daemon", "status"], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /daemon/i);
  const bad = spawnSync(process.execPath, [join(HERE, "..", "bin", "jev-router.mjs"), "nonsense"], { encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /usage/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/launchers.test.mjs`
Expected: FAIL — `bin/jev-router.mjs` does not exist.

- [ ] **Step 3: Implement `bin/jev-router.mjs` and add the `jev-router` bin entry**

- [ ] **Step 4: Document it in `README.md`**

A new section after "Quick start", in the README's existing voice, covering: the one-command install, that it routes the VS Code extension and plain `claude` alike because Claude Code applies `settings.json`'s `env` on every launch, which keys install touches and which it leaves alone, that the key and every tier override must live in `~/.jev-router.env` because launchd hands the job a near-empty environment, what the preflight hook does on a dead daemon, and `uninstall`. Add `JEV_DAEMON_PORT` to the configuration table.

- [ ] **Step 5: Run the suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bin/jev-router.mjs package.json README.md test/launchers.test.mjs
git commit -m "feat: add the jev-router command and document daemon installation"
```

---

### Task 8: Keep the saved picker row when the daemon is installed

**Files:**
- Modify: `src/settings.mjs` (`restoreSavedModel`)
- Test: `test/settings.test.mjs` (extend)

**Interfaces:**
- Consumes: nothing new; it reads `env.ANTHROPIC_BASE_URL` out of the settings file it already opens.
- Produces: `restoreSavedModel(previous, file = USER_SETTINGS)` unchanged in signature, now returning `false` without writing when that file's `env.ANTHROPIC_BASE_URL` points at a loopback port — the daemon can resolve the sentinel, so the saved row is a working preference, not debris.

- [ ] **Step 1: Write the failing test**

```js
test("a saved sentinel is kept when the daemon is installed", () => {
  const file = fileWith({ model: "jev-auto", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:61820" } });
  assert.equal(restoreSavedModel("opus", file), false);
  assert.equal(modelIn(file), "jev-auto", "the extension user's own choice survives a CLI session");
});

test("a saved sentinel is still cleaned up when nothing can resolve it", () => {
  const file = fileWith({ model: "jev-auto", env: { ANTHROPIC_BASE_URL: "https://api.example.com" } });
  assert.equal(restoreSavedModel("opus", file), true);
  assert.equal(modelIn(file), "opus");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/settings.test.mjs`
Expected: FAIL — the sentinel is removed in the first test.

- [ ] **Step 3: Add the loopback check to `restoreSavedModel`**

Comment says why: `restoreSavedModel` exists because plain `claude` cannot resolve `jev-auto`, and with the daemon installed it can — so the restore would be deleting a preference the user set in the extension.

- [ ] **Step 4: Run the suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings.mjs test/settings.test.mjs
git commit -m "fix: keep a saved Jev Router row when the daemon can resolve it"
```
