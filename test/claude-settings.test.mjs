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
