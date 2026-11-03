import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, statSync, mkdirSync, rmSync, realpathSync } from "node:fs";
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

test("the file's permission mode is preserved across a patch, not widened to the default", () => {
  const s = sandbox({ env: {} });
  chmodSync(s.file, 0o600);
  patch(s);
  assert.equal(statSync(s.file).mode & 0o777, 0o600);
});

test("corrupt bookkeeping makes unpatch throw instead of silently reporting nothing restored", () => {
  const s = sandbox({});
  patch(s);
  writeFileSync(s.bookkeeping, "{ not json");
  assert.throws(() => unpatchSettings({ file: s.file, bookkeeping: s.bookkeeping }));
  // Still patched - unpatch never got far enough to touch it.
  assert.equal(s.read().env.ANTHROPIC_BASE_URL, "http://127.0.0.1:61820");
});

test("missing port or hookCommand is rejected rather than written verbatim", () => {
  const s = sandbox({});
  assert.throws(() => patchSettings({ file: s.file, port: undefined, hookCommand: "jev-router preflight", bookkeeping: s.bookkeeping }));
  assert.throws(() => patchSettings({ file: s.file, port: 61820, hookCommand: undefined, bookkeeping: s.bookkeeping }));
  assert.deepEqual(s.read(), {});
});

test("unpatching a settings.json that no longer exists is a clean no-op, not a throw", () => {
  const s = sandbox({});
  patch(s);
  // Resolve before deleting (a deleted path can't be realpath'd), so the lookup below hits the
  // same bookkeeping key `patch` wrote - a symlinked tmpdir would otherwise resolve
  // differently once the file is gone, which is incidental to what this test means to cover.
  const resolvedFile = realpathSync(s.file);
  rmSync(s.file, { force: true });
  const { restored } = unpatchSettings({ file: resolvedFile, bookkeeping: s.bookkeeping });
  assert.deepEqual(restored, []);
  assert.deepEqual(JSON.parse(readFileSync(s.bookkeeping, "utf8")), {});
});

test("if the bookkeeping write fails, settings.json is left unpatched (bookkeeping is written first)", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-install-"));
  const file = join(dir, "settings.json");
  const original = { env: {} };
  writeFileSync(file, JSON.stringify(original, null, 2));
  const lockedDir = join(dir, "locked");
  mkdirSync(lockedDir);
  chmodSync(lockedDir, 0o500); // read + execute, no write: can't create anything inside it
  const bookkeeping = join(lockedDir, "sub", "install.json");
  try {
    assert.throws(() => patchSettings({ file, port: 61820, hookCommand: "jev-router preflight", bookkeeping }));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), original);
  } finally {
    chmodSync(lockedDir, 0o700);
  }
});

test("a hookCommand change between two patches leaves nothing behind after unpatch", () => {
  const s = sandbox({});
  patchSettings({ file: s.file, port: 1, hookCommand: "jev-router preflight --port 1", bookkeeping: s.bookkeeping });
  patchSettings({ file: s.file, port: 2, hookCommand: "jev-router preflight --port 2", bookkeeping: s.bookkeeping });
  assert.equal(s.read().hooks.SessionStart.length, 2, "both hook commands present after the second patch");
  unpatchSettings({ file: s.file, bookkeeping: s.bookkeeping });
  assert.deepEqual(s.read(), {}, "both hooks removed, and the keys this module created are gone too");
});
