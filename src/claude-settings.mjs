import {
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  mkdirSync,
  accessSync,
  constants,
  realpathSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import { AUTO_MODEL, SMALLEST_CONTEXT_TOKENS } from "./config.mjs";

/**
 * Registers "Jev Router" as an extra row in Claude Code's /model picker and starts the session
 * on it. Claude Code sends the id verbatim because it does not validate model names behind a
 * custom base URL, which is what lets the proxy tell "route this" from "the user picked a
 * model". Capabilities are declared so Claude Code still composes thinking and effort for
 * the tiers that support them; the proxy strips what the routed model cannot accept.
 */
export function autoModelEnv() {
  const env = {
    ANTHROPIC_CUSTOM_MODEL_OPTION: AUTO_MODEL,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Jev Router",
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Route each turn to the cheapest model that can do it",
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES:
      "thinking,adaptive_thinking,interleaved_thinking,effort,max_effort",
  };
  // ANTHROPIC_MODEL applies to this session only and is never written to settings, so the
  // default costs the user nothing permanent. A model they set themselves still wins.
  if (!process.env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = AUTO_MODEL;
  // Claude Code cannot look the sentinel up in its catalogue, so from v2.1.277 it says so on
  // every start and assumes 200k. That assumption is right - a turn can land on Haiku at any
  // point - but it is worth stating rather than being guessed, which also settles the warning.
  if (!process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(SMALLEST_CONTEXT_TOKENS);
  }
  return env;
}

/**
 * Follows a symlinked settings file to its real target, so the atomic write below replaces
 * the file the link points at rather than the link itself. Falls back to the given path when
 * it does not exist yet (or isn't resolvable for some other reason) and lets the read below
 * raise its own clear error.
 */
function resolvePath(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

function parseSettings(resolvedFile) {
  let raw;
  try {
    raw = readFileSync(resolvedFile, "utf8");
  } catch (err) {
    throw new Error(`Cannot read settings.json at ${resolvedFile}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Refusing to patch malformed settings.json at ${resolvedFile}`);
  }
}

/**
 * Checked explicitly rather than left to the atomic rename below: `rename()` only needs write
 * permission on the containing directory, not on the file it replaces, so a read-only
 * settings.json would otherwise be silently overwritten instead of refused.
 */
function assertWritable(resolvedFile) {
  try {
    accessSync(resolvedFile, constants.W_OK);
  } catch (err) {
    throw new Error(`settings.json is not writable at ${resolvedFile}: ${err.message}`);
  }
}

function loadBookkeeping(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function saveBookkeeping(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

/** Every `hooks.SessionStart[].hooks[].command` already present, flattened for a membership check. */
function flattenHookCommands(sessionStart) {
  if (!Array.isArray(sessionStart)) return [];
  const commands = [];
  for (const entry of sessionStart) {
    for (const hook of entry?.hooks ?? []) {
      if (hook?.command) commands.push(hook.command);
    }
  }
  return commands;
}

/**
 * Pure patch step: given a freshly-read settings object, returns the object to write, the
 * keys actually touched, the keys left alone because the user already owns them, and the
 * bookkeeping to persist so `unpatchSettings` can undo exactly this. Never overwrites a key
 * that already exists - env values and the hook are each additive-only - so there is never a
 * prior value to restore, only additions to remove.
 */
function applyPatch(settings, { port, hookCommand, priorFileRecord }) {
  const changed = [];
  const skipped = [];
  const next = { ...settings };

  const envExisted = settings.env !== undefined;
  const env = { ...(settings.env ?? {}) };
  const candidates = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ...autoModelEnv(),
    // autoModelEnv()'s own ANTHROPIC_MODEL/CLAUDE_CODE_MAX_CONTEXT_TOKENS entries are gated on
    // *this process's* live environment, which is right for a single launch but wrong for a
    // permanent install: whether these two belong in settings.json must depend only on what
    // settings.json's own env block already has, which the skip-if-present loop below already
    // enforces. Restated unconditionally so the installer's own shell can never suppress them.
    ANTHROPIC_MODEL: AUTO_MODEL,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(SMALLEST_CONTEXT_TOKENS),
  };
  const addedEnvKeys = [];
  for (const [key, value] of Object.entries(candidates)) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      skipped.push(`env.${key}`);
    } else {
      env[key] = value;
      changed.push(`env.${key}`);
      addedEnvKeys.push(key);
    }
  }
  next.env = env;

  const hooksExisted = settings.hooks !== undefined;
  const sessionStartExisted = settings.hooks?.SessionStart !== undefined;
  const existingCommands = flattenHookCommands(settings.hooks?.SessionStart);
  let hookRecord = priorFileRecord.hook ?? null;
  if (existingCommands.includes(hookCommand)) {
    skipped.push("hooks.SessionStart");
  } else {
    const hooks = { ...(settings.hooks ?? {}) };
    const sessionStart = [...(settings.hooks?.SessionStart ?? [])];
    sessionStart.push({ hooks: [{ type: "command", command: hookCommand }] });
    hooks.SessionStart = sessionStart;
    next.hooks = hooks;
    changed.push("hooks.SessionStart");
    hookRecord = {
      hooksKeyCreated: !hooksExisted,
      sessionStartKeyCreated: !sessionStartExisted,
      command: hookCommand,
    };
  }

  // Never managed by this module - a status line is a deliberate user choice, and nothing in
  // this task's scope has one to offer in its place - but still surfaced so an installer knows
  // it was considered and left alone, not silently never looked at.
  if (settings.statusLine !== undefined) {
    skipped.push("statusLine");
  }

  const priorEnvKeys = priorFileRecord.envKeys ?? [];
  const envKeyCreated = priorFileRecord.envKeyCreated ?? !envExisted;
  const fileRecord = {
    envKeyCreated,
    envKeys: Array.from(new Set([...priorEnvKeys, ...addedEnvKeys])),
    hook: hookRecord,
  };

  return { settings: next, changed, skipped, fileRecord };
}

/** Removes exactly what `applyPatch` added, restoring the key itself to absent when this module created it. */
function reversePatch(settings, fileRecord) {
  const restored = [];
  const next = { ...settings };

  if (settings.env !== undefined) {
    const env = { ...settings.env };
    for (const key of fileRecord.envKeys ?? []) {
      if (Object.prototype.hasOwnProperty.call(env, key)) {
        delete env[key];
        restored.push(`env.${key}`);
      }
    }
    if (fileRecord.envKeyCreated && Object.keys(env).length === 0) {
      delete next.env;
    } else {
      next.env = env;
    }
  }

  if (fileRecord.hook && Array.isArray(settings.hooks?.SessionStart)) {
    const sessionStart = [...settings.hooks.SessionStart];
    const idx = sessionStart.findIndex(
      (entry) =>
        entry &&
        Object.keys(entry).length === 1 &&
        Array.isArray(entry.hooks) &&
        entry.hooks.length === 1 &&
        entry.hooks[0]?.type === "command" &&
        entry.hooks[0]?.command === fileRecord.hook.command,
    );
    if (idx !== -1) {
      sessionStart.splice(idx, 1);
      restored.push("hooks.SessionStart");
      const hooks = { ...settings.hooks };
      if (fileRecord.hook.sessionStartKeyCreated && sessionStart.length === 0) {
        delete hooks.SessionStart;
      } else {
        hooks.SessionStart = sessionStart;
      }
      if (fileRecord.hook.hooksKeyCreated && Object.keys(hooks).length === 0) {
        delete next.hooks;
      } else {
        next.hooks = hooks;
      }
    }
  }

  return { settings: next, restored };
}

/** Atomic temp-then-rename in the same directory, so a crash mid-write cannot truncate `resolvedFile`. */
function writeAtomic(resolvedFile, contents) {
  const dir = dirname(resolvedFile);
  const tmpFile = join(dir, `.${basename(resolvedFile)}.jev-tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmpFile, contents);
    renameSync(tmpFile, resolvedFile);
  } catch (err) {
    try {
      rmSync(tmpFile, { force: true });
    } catch {
      // Best effort; the real error below is what matters.
    }
    throw err;
  }
}

/**
 * Merges the router's env vars and preflight hook into Claude Code's own settings.json,
 * reversibly. Never overwrites a key the user (or a prior install) already set - env values
 * and the hook entry are both additive-only - and records exactly what it added in
 * `bookkeeping` so `unpatchSettings` can take it back out without guessing.
 *
 * Reads the file twice: once up front, so a malformed or unwritable file is refused before
 * anything is touched, and once again immediately before the atomic write, because Claude
 * Code can save a chosen `model` to this same file between those two points and that write
 * must survive ours.
 */
export function patchSettings({ file, port, hookCommand, bookkeeping }) {
  const resolvedFile = resolvePath(file);

  parseSettings(resolvedFile);
  assertWritable(resolvedFile);

  const record = loadBookkeeping(bookkeeping);
  const priorFileRecord = record[resolvedFile] ?? {};

  const fresh = parseSettings(resolvedFile);
  const result = applyPatch(fresh, { port, hookCommand, priorFileRecord });
  writeAtomic(resolvedFile, `${JSON.stringify(result.settings, null, 2)}\n`);

  record[resolvedFile] = result.fileRecord;
  saveBookkeeping(bookkeeping, record);

  return { changed: result.changed, skipped: result.skipped };
}

/**
 * Undoes exactly what `patchSettings` did for this file, using `bookkeeping` rather than
 * recomputing from `port`/`hookCommand` (which this function isn't even given) - the record is
 * the only source of truth for which keys this install owns.
 */
export function unpatchSettings({ file, bookkeeping }) {
  const resolvedFile = resolvePath(file);
  const record = loadBookkeeping(bookkeeping);
  const fileRecord = record[resolvedFile];
  if (!fileRecord) return { restored: [] };

  parseSettings(resolvedFile);
  assertWritable(resolvedFile);

  const fresh = parseSettings(resolvedFile);
  const result = reversePatch(fresh, fileRecord);
  writeAtomic(resolvedFile, `${JSON.stringify(result.settings, null, 2)}\n`);

  delete record[resolvedFile];
  saveBookkeeping(bookkeeping, record);

  return { restored: result.restored };
}
