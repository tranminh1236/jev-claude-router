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
