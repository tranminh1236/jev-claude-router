# Background daemon + dashboard, for the VS Code Claude Code extension

## Intent and why

The user runs Claude Code exclusively through the VS Code "Claude Code" extension, never
`claude-cli`. `jev-claude` (and the other three launchers) only route a session that is
*started through them*: they spawn a per-session proxy on a random port, inject
`ANTHROPIC_BASE_URL` and the model-picker env vars onto that one child process, and tear the
proxy down on exit. The extension never goes through a launcher — it starts the `claude`
engine itself — so today's routing is invisible to it.

The user wants Jev's model/effort routing (already built, already working for the CLI
launchers) to apply automatically to every Claude Code session the extension opens, in every
project, without a terminal step or a wrapper command.

Scoped against two prior-art projects:

- **This repo** (`@flaviusapop/jev-router`) already does the hard part: per-turn
  classification, (model, effort) tiers, override vocabulary, sub-agent routing across four
  CLIs, and — unlike what was assumed going in — a cache-aware downgrade guard
  (`downgradeMaxContextTokens` / `cheapStreak` in `src/policy.mjs`) equivalent to the
  "cache-aware switching" feature in xafold/jev-router. Nothing there needs rebuilding.
- **xafold/jev-router** (github.com/xafold/jev-router, Rust, Claude Code only) contributes the
  two genuinely new pieces: a local analytics **dashboard** with a decision log and savings
  estimate, and a ratings-driven self-tuning loop. It has **no** background daemon either — it
  is invoked on demand the same way this repo's launchers are.

So the background daemon is new ground, built here for the extension problem specifically, not
ported from either repo.

## Goals

1. Any Claude Code session the VS Code extension opens, in any project, is routed by Jev — no
   per-project setup, no terminal step — after one install command.
2. A local dashboard (lite scope) shows what the router did: each decision's tier change,
   reason, confidence, which project it came from, and real token/cost saved versus an
   always-Opus baseline.
3. The existing CLI-launcher workflow keeps working, and a dead daemon never locks the user
   out of Claude Code.

## Non-goals (this round)

- Ratings UI and the self-tuning loop xafold's dashboard has. Deferred by the user: ship the
  read-only decision log and savings view first.
- Daemon support for Codex, Grok or opencode. The extension problem is Claude-Code-specific;
  `src/proxy.mjs` is already Claude-only (`UPSTREAM = "api.anthropic.com"`). Their decisions
  do appear in the dashboard (see the `provider` field) — only the daemon is Claude-only.
- Linux systemd units or a Windows service. The daemon process is plain Node and runs
  anywhere; only *autostart* install/uninstall is launchd-specific this round, matching the
  user's platform. Elsewhere, `jev-router daemon start` is the documented manual fallback.
- Restructuring the Jev question into atomic judgments, and the golden-set benchmark that
  change would need to be safe. Phase 2, with its own brainstorm — see below.
- Changing routing policy beyond the single gate metric named below, the long-lived-state fix,
  and the new log fields.

## Decisions the user made

- **Autostart: launchd agent**, not a manual start command — it must be listening before VS
  Code opens, since env resolution happens once at process launch.
- **Env scope: global** — one install step covers every project, via the extension or plain
  `claude`.
- **Dashboard scope: lite** — decision log + savings, no ratings/self-tune.
- **Fallback: a `SessionStart` hook that self-heals**, rather than trusting launchd alone.
- **Savings from real `usage`** read off the upstream response, not input-side arithmetic.
- **Per-project breakdown: yes**, including the hook plumbing it needs.
- **Redesigning the Jev question is phase 2**, not this round. This round takes the two cheap
  parts of it (below) and makes the log schema able to hold what phase 2 will produce.

## What the typesafe-ai skill changed

The `typesafe-ai` skill (TypeSafe's own integration guidance, installed mid-brainstorm) was
read against the existing router. It leaves the daemon, dashboard and plumbing above untouched,
but it finds two faults in the routing layer this project already ships:

1. **The question is at the wrong layer.** `QUESTIONS.model_tier` in `src/config.mjs` asks Jev
   to *pick the tier* — a decision, not a judgment. The skill's rule is that Jev supplies the
   judgments and code holds the truth table; a question shaped like "what should the agent do
   next?" means the decision belongs in code and the question should be broken into the
   judgments it depends on. This is precisely how xafold's router is built (request type,
   reading/reasoning depth, plus yes/no safety checks, combined by a rule engine) and the
   likeliest source of its claimed accuracy gap.
2. **`confidence` is the wrong gate.** `THRESHOLDS.minConfidence = 0.6` is the central gate in
   `decide()`. The skill: confidence measures how concentrated a distribution is, which is not
   how likely the answer is to be correct; the probability of the top answer is. `askJev`
   already returns `probabilities` (`src/router.mjs`) and `policy.mjs` never reads it.

Fault 1 is phase 2: restructuring the question changes every routing outcome, and the skill's
own guidance (test on the live API, re-check on cases you didn't tune, watch for thresholds
fitted to a handful of cases) means it needs a golden set — xafold's `tests/golden.jsonl` and
`jev-router golden` — built first. That gets its own brainstorm, with this round's dashboard
data as the before-picture.

In scope this round, both small:

- **Swap the gate metric only.** `decide()` reads `probabilities[choice]` instead of
  `confidence`, with every branch, threshold and fallback otherwise identical — a like-for-like
  substitution of the number the policy always *meant*, not a policy change. Covered by
  unit tests over crafted distributions (the two metrics differ most on a spread four-option
  answer, which is exactly the case the gate exists for). Tuning the threshold itself waits
  for the golden set.
- **Future-proof the log.** Decision rows carry `policyVersion`, the full `probabilities`
  distribution, and a `judgments` field (null until phase 2 fills it). Retrofitting an
  append-only log is expensive, and phase 2's whole point is comparing rulesets — which needs
  rows from before the change to compare against.

## How it works

### Env injection (the actual unlock)

The original assumption was that macOS GUI apps (VS Code from Dock/Spotlight) don't inherit
shell exports, so this would need `launchctl setenv` and a login-time agent. Checked instead:
Claude Code's `~/.claude/settings.json` already supports a top-level `"env"` object merged into
its process environment on every launch — this user's settings.json already uses it
(`"env": {"CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN": "1"}`). The VS Code extension reads that same
file; it is not a separate config surface. So global env injection is a merge into one JSON
file: no shell profile, no `launchctl setenv`, no GUI-session special-casing.

```
VS Code extension   ─┐
plain `claude`       ─┼─> ~/.claude/settings.json .env ─> ANTHROPIC_BASE_URL=http://127.0.0.1:61820
jev-claude (own proxy)┘                                   + the model-picker vars, as today
                                                                      │
                                                                      v
                                                       jev-router daemon (launchd, always up)
                                                                      │
                                                                      v
                                                               api.anthropic.com
```

### The daemon

- `src/proxy.mjs` is reused, with the long-lived-state fix below. It already serves many
  concurrent sessions from one instance (`scripts/proxy-host.mjs` proved that for two CLI
  windows); the port becomes fixed instead of `listen(0, …)`.
- New `bin/jev-daemon.mjs`: `start [--foreground]`, `stop`, `restart`, `status`, `install`,
  `uninstall`.
- Default port `61820`, overridable with `JEV_DAEMON_PORT` (away from 3000/5173/8000/8080/8765).
- State files in a new `~/.jev-router/`: `daemon.pid`, `daemon.port`, `daemon.log`,
  `decisions.jsonl`, `sessions.json`.

**Identifying our own proxy.** `proxy.mjs` answers Claude Code's `HEAD` probe with a bare 200,
which *any* server on 61820 would also answer — so a foreign listener would make `start`
no-op and `install` point every Claude Code session at a stranger. The `HEAD` response gains
one header, `x-jev-router: <version>`, keeping the 200 shape Claude Code relies on. A 200
without that header means port conflict: `start` refuses, `install` refuses to patch, both
say which port and what to do.

**`stop` vs `KeepAlive`.** `KeepAlive: true` stays (crash recovery), so a pid-file SIGTERM
alone would be respawned within seconds. When the launchd agent is installed, `stop`/`restart`
drive launchctl (`bootout` / `kickstart -k`); when it isn't — manual use, or another platform
— they use the pid file. `status` reports which of the two paths is in effect.

### Long-lived state in proxy.mjs (my call: in scope, it has to be)

`startProxy`'s state was written for a process that dies with one session: `convos` evicts past
**50 entries shared across all conversations, projects and sub-agents**, and `routedSessions`,
`subagents`, `manual` are Sets that never evict. In a daemon serving several VS Code windows
for weeks, 50 slots fill quickly, and eviction mid-turn is not benign: a follow-up request finds
no state, falls back to `current = "sonnet"`, and gets rewritten to a different model
mid-turn — breaking the very prompt cache `policy.mjs`'s downgrade guard exists to protect.

So: eviction becomes idle-time-based rather than count-based. Each entry carries `lastSeen`;
entries idle beyond a TTL (12h) are dropped, with a high hard cap (2000) evicting
least-recently-seen first as a backstop. `routedSessions`, `subagents` and `manual` become
bounded, TTL-aged maps under the same rule, so nothing grows without bound and nothing active
is ever evicted. `src/policy.mjs` and the tier logic are untouched; this is lifecycle only,
and it gets its own tests (an entry past TTL is gone; an entry in an active turn never is).

### Install / uninstall (macOS)

`install`:

1. Refuses unless a routing key is resolvable from the files `loadEnv()` reads
   (`~/.jev-router.env`, `~/.jev-claude.env`). launchd hands a job a near-empty environment, so
   a key exported only in a shell profile is invisible to the daemon and the router would proxy
   happily while routing nothing (`askJev` returns null, `decide()` keeps the current model).
   Same reasoning applies to tier overrides (`JEV_CLAUDE_STRONG_MODEL`, `JEV_DISABLE_TIERS`, …):
   the env file is the only place they take effect for the daemon, which the README must say
   plainly. The plist carries only `HOME`, `PATH` and `JEV_DAEMON_PORT`.
2. Writes `~/Library/LaunchAgents/com.flaviusapop.jev-router.daemon.plist` — `RunAtLoad`,
   `KeepAlive`, `ProgramArguments` = [resolved node binary, `bin/jev-daemon.mjs`, `start`,
   `--foreground`], stdout/stderr to `~/.jev-router/daemon.log` — then loads and starts it
   immediately rather than waiting for the next login.
3. Merges into the real `~/.claude/settings.json` (no wrapper process exists to pass
   `--settings` to):
   - `env.ANTHROPIC_BASE_URL = http://127.0.0.1:<port>`
   - `env.ANTHROPIC_MODEL = jev-auto`, only if unset
   - `env.ANTHROPIC_CUSTOM_MODEL_OPTION*` and `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` — reusing
     `autoModelEnv()` from `bin/jev-claude.mjs`, not reimplementing it
   - `hooks.SessionStart` gains one entry, `jev-router preflight` (below), appended to whatever
     is already there — this user already has other SessionStart hooks
   - `statusLine`, **only if none is set** — the same "don't clobber a deliberate choice" rule
     `jev-claude.mjs` already applies. This user already has one (caveman); install leaves it,
     and says so.
   - every other key (permissions, plugins, `autoMode`, the other hooks, …) is preserved: this
     is read-JSON → patch those fields → write-JSON, the shape `restoreSavedModel` already uses.
4. Prints what it changed and the one command that undoes it.

`uninstall` unloads and removes the plist, then removes exactly what install added — restoring
any prior value it recorded, and leaving a `statusLine` or `ANTHROPIC_MODEL` it never touched
alone.

**Node path drift.** Under nvm/fnm or a Homebrew bump, the node binary and the global
`node_modules` path move, and with `KeepAlive` a stale plist becomes a respawn loop filling
`daemon.log`. So `install` records the resolved paths and version, `status` verifies both still
exist and match the installed package, and both say "re-run `jev-router daemon install`" when
they don't. No npm `postinstall` touches launchd — silently rewriting a user's LaunchAgents on
`npm -g upgrade` is worse than one explicit command.

### Fallback: the preflight hook

Chosen by the user over trusting launchd alone, because the env patch is permanent and global
while the daemon is not: with the daemon down, every session in every project fails on a dead
port, and `jev-auto` resolves nowhere.

New `jev-router preflight`, wired as a `SessionStart` hook, on each session start:

1. Probes `127.0.0.1:<port>` for the `x-jev-router` marker. Healthy → records this session's
   `session_id` → `cwd` (below) and exits, well under the hook timeout.
2. Dead → starts the daemon and waits briefly. SessionStart runs before the session's first API
   request, so a successful resurrection fixes the session in progress, not just the next one.
3. Still dead (port conflict, broken install) → removes the env patch from `settings.json` and
   prints a visible one-line notice. The session in progress is already holding the old env, so
   it is the *next* session that comes back clean — as plain, unrouted Claude Code rather than a
   broken one. `daemon start` and `install` re-apply the patch.

### Decision log

Today `proxy.mjs` logs a decision only under `JEV_DEBUG`, as free text for a human tailing a
file. New and separate: `src/decision-log.mjs`, called from the spot in `proxy.mjs` that
already computes `{ tier, reason, confidence }` for the status line, and from the equivalent
spots in `codex-proxy.mjs` and `grok-proxy.mjs`.

One JSON object per **main-agent** decision (sub-agents skipped, as the status line already
does) appended to `~/.jev-router/decisions.jsonl`:

```json
{"ts":1762…,"provider":"claude","session":"<full session id>","convo":"6bc4b3247b8f",
 "from":"sonnet","to":"haiku","reason":"jev","contextTokens":4200,
 "policyVersion":1,"judgments":null,
 "probabilities":{"haiku":0.95,"sonnet":0.04,"opus":0.01,"fable":0.00},
 "usage":{"input":812,"output":1530,"cacheRead":18400,"cacheCreation":0},"servedModel":"claude-haiku-4-5-20251001"}
```

- `provider` is there because every proxy writes to one log — the dashboard shows CLI sessions
  and extension sessions together, with a filter.
- The full session id is stored (not truncated) because the dashboard joins it against the
  hook's session→project map; `convo` is the existing 12-char conversation key. The dashboard
  truncates for display.
- **No prompt text by default.** This project's standing rule is that prompt content is only
  recorded opt-in (`JEV_DEBUG`, `JEV_DUMP`); an always-on log is a new standing artifact on
  disk, so it gets the same treatment. A short preview is included only under
  `JEV_DASHBOARD_LOG_PROMPTS=1`.
- Writes are wrapped so a broken log can never affect a request — the rule `status.mjs`'s
  `writeStatus` already follows.
- **Trimming has a single owner.** Several proxies may append concurrently (daemon plus any
  `jev-claude` session), and a read-all/rewrite trim from N processes silently drops each
  other's appends. Appends are single lines under 4 KB (atomic on POSIX); only the daemon
  trims, to the last 20,000 lines, via write-temp-then-rename. Non-daemon writers never trim.
  No daily rotation this round — 20k decisions is months of normal use.

**Real usage capture.** The savings number needs output tokens and cache reads, which is where
the billing difference actually lives, and `TIERS` makes `opus` and `fable` the same model id
differing only in effort — so a model-price table alone cannot tell them apart. The proxy
therefore reads `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`) from the upstream SSE stream's `message_start` and final
`message_delta`, plus the served model id that `announceServedModel` already proves is
parseable. Constraints this must respect:

- The client stream is piped through untouched. Parsing happens on a tee'd copy, decompressed
  with zlib to match `content-encoding` — `accept-encoding` is *not* stripped outside
  `JEV_DEBUG`, since that would cost real bandwidth on every response.
- Any failure (unknown encoding, truncated stream, aborted turn) means no `usage` on that row.
  The dashboard treats a missing `usage` as unknown, never as zero.
- Usage arrives after the decision row is written, so the row is updated or a small follow-up
  record is appended and joined on `convo` + `ts`; the builder picks whichever keeps the writer
  append-only.

### Per-project attribution

Nothing in a `/v1/messages` body carries the workspace, so the `preflight` hook — already
running at SessionStart, already receiving `session_id` and `cwd` on stdin — writes a bounded
`session_id → cwd` map (~200 entries, LRU) to `~/.jev-router/sessions.json`. The dashboard
joins decisions to it and shows a project column and filter, displaying the basename. The map
is local-only, like every other file here.

### Dashboard (lite)

- New `bin/jev-dashboard.mjs` + `src/dashboard-server.mjs`: a small HTTP server bound to
  `127.0.0.1` only, same posture as the proxy. Default port `61821`, overridable with `--port`
  or `JEV_DASHBOARD_PORT`.
- `GET /` — one inline static page (no build step, no framework): summary strip plus a table of
  recent decisions with a project and provider filter.
- `GET /api/decisions?limit=500` — tail of the log, joined with the session→project map.
- `GET /api/summary` — counts per tier, per project, and tokens/cost saved versus an always-Opus
  baseline, computed from real `usage` and a static per-model price table (input, output and
  cache-read priced separately; rows without usage are excluded from the money total and
  counted separately, so the figure is never silently padded).
- Not under launchd: it is opened on demand with `jev-router dashboard`, like xafold's own
  dashboard command. No reason to keep an HTTP server up when nobody is looking.

### jev-claude and the saved model

`jev-claude` keeps starting its own per-session proxy when used, which is simplest and adds no
new failure mode. One carve-out is required, though: `restoreSavedModel` deletes a saved
`model: "jev-auto"` on exit, because plain `claude` cannot resolve the sentinel — but with the
daemon installed it *can*, and an extension user who deliberately saved the Jev row would lose
it the moment they ran one CLI session. So `restoreSavedModel` becomes daemon-aware: it skips
the restore when `settings.json`'s `env.ANTHROPIC_BASE_URL` points at the daemon. Touches
`src/settings.mjs` and `test/settings.test.mjs`.

### New umbrella CLI

New `bin/jev-router.mjs`, bin entry `jev-router`, a thin dispatcher only:
`jev-router daemon <start|stop|restart|status|install|uninstall>`,
`jev-router dashboard [--port <n>]`, `jev-router preflight`. No logic duplicated from the
modules it calls.

## What's left to the builder

- Plist XML details and `launchctl load` vs `bootstrap`/`bootout` across macOS versions (fail
  with a clear message if neither path works).
- The dashboard's HTML/CSS: functional and plain is enough at lite scope.
- The price table's exact numbers, labeled as list-price estimates and overridable the way tier
  models and efforts already are.
- Whether usage lands as a row update or an appended follow-up record (above).
- Test coverage: the probability gate against crafted distributions (including one where
  `confidence` and top-probability disagree), decision log (redaction default, single-owner
  trim, concurrent appends),
  daemon lifecycle (double-start no-op, port-conflict refusal, stop under and without launchd),
  settings merge (preserves unrelated keys and an existing statusLine, appends to existing
  SessionStart hooks, uninstall restores exactly), preflight's three branches, proxy state TTL
  eviction, usage parsing against captured SSE fixtures (gzip and identity), and the two
  dashboard endpoints against a fixture log.
