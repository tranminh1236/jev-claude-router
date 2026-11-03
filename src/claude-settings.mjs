import {
  readFileSync,
  renameSync,
  rmSync,
  mkdirSync,
  accessSync,
  existsSync,
  statSync,
  chmodSync,
  openSync,
  writeSync,
  closeSync,
  fsyncSync,
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

/**
 * `port`/`hookCommand` land verbatim in `settings.json` with no further validation past this
 * point - an `undefined` port would otherwise write `ANTHROPIC_BASE_URL:
 * "http://127.0.0.1:undefined"` into the user's real settings, and an `undefined` hookCommand
 * would append a hook entry with no `command` at all.
 */
function validatePatchArgs({ port, hookCommand }) {
  if (port === undefined || port === null || port === "") {
    throw new Error("patchSettings: a port is required");
  }
  if (!hookCommand) {
    throw new Error("patchSettings: a hookCommand is required");
  }
}

function loadBookkeeping(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // Genuinely "no record yet" - the only case where pretending there's an empty record is
    // safe. Anything else (permissions, a directory where the file should be, ...) is hidden
    // the same way below.
    if (err.code === "ENOENT") return {};
    throw new Error(`Cannot read bookkeeping at ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Deliberately NOT swallowed into `{}`: a corrupt record is indistinguishable from "no
    // record" to the caller, and treating it that way turns `unpatchSettings` into a silent
    // no-op on a file that is, in fact, still fully patched. Throwing instead reports the
    // un-reversible state rather than hiding it.
    throw new Error(`Corrupt bookkeeping at ${path}: ${err.message}`);
  }
}

function saveBookkeeping(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  // Atomic for the same reason settings.json itself is: Blocking 2 and 3 both hinge on this
  // record's integrity, so it shouldn't be the one write in this module that can be torn by a
  // crash mid-write.
  writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
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
  const priorHooks = priorFileRecord.hooks ?? [];
  let addedHookCommand = null;
  if (existingCommands.includes(hookCommand)) {
    skipped.push("hooks.SessionStart");
  } else {
    const hooks = { ...(settings.hooks ?? {}) };
    const sessionStart = [...(settings.hooks?.SessionStart ?? [])];
    sessionStart.push({ hooks: [{ type: "command", command: hookCommand }] });
    hooks.SessionStart = sessionStart;
    next.hooks = hooks;
    changed.push("hooks.SessionStart");
    addedHookCommand = hookCommand;
  }

  // Never managed by this module - a status line is a deliberate user choice, and nothing in
  // this task's scope has one to offer in its place - but still surfaced so an installer knows
  // it was considered and left alone, not silently never looked at.
  if (settings.statusLine !== undefined) {
    skipped.push("statusLine");
  }

  const priorEnvKeys = priorFileRecord.envKeys ?? [];
  const envKeyCreated = priorFileRecord.envKeyCreated ?? !envExisted;
  // hooksKeyCreated/sessionStartKeyCreated are locked in from the first install the same way
  // envKeyCreated already is: a later install that finds `hooks`/`SessionStart` already
  // present - because THIS module created them last time, not the user - still knows it owns
  // the key and will remove it on unpatch. `hooks` accumulates every command this module has
  // ever appended across installs (not just the most recent one), so a `hookCommand` change
  // between installs (e.g. a new port baked into the command) doesn't orphan the previous
  // entry: unpatch removes every command ever recorded here, not just the current one.
  const hooksKeyCreated = priorFileRecord.hooksKeyCreated ?? !hooksExisted;
  const sessionStartKeyCreated = priorFileRecord.sessionStartKeyCreated ?? !sessionStartExisted;
  const hooks = Array.from(new Set([...priorHooks, ...(addedHookCommand ? [addedHookCommand] : [])]));

  const fileRecord = {
    envKeyCreated,
    envKeys: Array.from(new Set([...priorEnvKeys, ...addedEnvKeys])),
    hooksKeyCreated,
    sessionStartKeyCreated,
    hooks,
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

  const hookCommands = fileRecord.hooks ?? [];
  if (hookCommands.length > 0 && Array.isArray(settings.hooks?.SessionStart)) {
    const sessionStart = [...settings.hooks.SessionStart];
    let removedAny = false;
    for (const command of hookCommands) {
      const idx = sessionStart.findIndex(
        (entry) =>
          entry &&
          Object.keys(entry).length === 1 &&
          Array.isArray(entry.hooks) &&
          entry.hooks.length === 1 &&
          entry.hooks[0]?.type === "command" &&
          entry.hooks[0]?.command === command,
      );
      if (idx !== -1) {
        sessionStart.splice(idx, 1);
        removedAny = true;
      }
    }
    if (removedAny) {
      restored.push("hooks.SessionStart");
      const hooks = { ...settings.hooks };
      if (fileRecord.sessionStartKeyCreated && sessionStart.length === 0) {
        delete hooks.SessionStart;
      } else {
        hooks.SessionStart = sessionStart;
      }
      if (fileRecord.hooksKeyCreated && Object.keys(hooks).length === 0) {
        delete next.hooks;
      } else {
        next.hooks = hooks;
      }
    }
  }

  return { settings: next, restored };
}

/**
 * Atomic temp-then-rename in the same directory, so a crash mid-write cannot truncate
 * `resolvedFile`. Preserves the target's existing permission bits - defaulting to `0600` when
 * it doesn't exist yet, rather than the process's default-umask mode - because `settings.json`
 * is exactly where people put `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`, and a rename-over
 * would otherwise silently widen a `0600` file to `0644`. The temp file is created with `wx`
 * so the write can't land on a pre-existing file or a pre-planted symlink at that path, and its
 * data (plus, best-effort, the directory entry) is fsynced before the rename, so the write
 * survives a crash rather than merely avoiding a truncation.
 */
function writeAtomic(resolvedFile, contents) {
  const dir = dirname(resolvedFile);
  const tmpFile = join(dir, `.${basename(resolvedFile)}.jev-tmp-${process.pid}-${Date.now()}`);

  let mode = 0o600;
  try {
    mode = statSync(resolvedFile).mode & 0o777;
  } catch {
    // Target doesn't exist yet - default to 0600 rather than the open, umask-dependent mode a
    // freshly created file would otherwise get.
  }

  const fd = openSync(tmpFile, "wx", mode);
  try {
    try {
      writeSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Belt-and-suspenders: `open()`'s mode argument is still subject to umask, so pin the
    // exact bits explicitly rather than relying on that call alone.
    chmodSync(tmpFile, mode);
    renameSync(tmpFile, resolvedFile);
    try {
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Best effort only - the rename itself already happened.
    }
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
 * Reads the file once, validates and diffs against that single snapshot, then writes the
 * bookkeeping record *before* settings.json itself (see the comment above that write for why).
 * There is no second read-and-reapply here: this does not protect against a concurrent
 * writer - if Claude Code itself saves a chosen `model` to this same file between our read and
 * our rename, that write is lost. This module only guards against the file being malformed,
 * unwritable, or torn by its own write; a race with another process editing the same file at
 * the same time is out of scope.
 */
export function patchSettings({ file, port, hookCommand, bookkeeping }) {
  validatePatchArgs({ port, hookCommand });
  const resolvedFile = resolvePath(file);

  const fresh = parseSettings(resolvedFile);
  assertWritable(resolvedFile);

  const record = loadBookkeeping(bookkeeping);
  const priorFileRecord = record[resolvedFile] ?? {};

  const result = applyPatch(fresh, { port, hookCommand, priorFileRecord });

  // Bookkeeping is written before settings.json, not after: if this write throws (disk full,
  // ~/.jev-router unwritable, a pre-existing install.json this process can't touch), settings
  // stays unpatched and nothing is lost - the record never named a patch that didn't happen.
  // The reverse order is the dangerous one: settings already patched with no record of it is
  // permanently unreversible, and (per `loadBookkeeping` above) now loudly so instead of
  // silently so, but still unreversible. Writing the record first means the only failure mode
  // left is a record that claims a patch which never landed, and unpatching that is a harmless
  // no-op - there is nothing in the file for it to find and remove.
  record[resolvedFile] = result.fileRecord;
  saveBookkeeping(bookkeeping, record);

  writeAtomic(resolvedFile, `${JSON.stringify(result.settings, null, 2)}\n`);

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

  if (!existsSync(resolvedFile)) {
    // Nothing to reverse - the file this record describes is simply gone. Treat that as
    // already clean rather than throwing from `parseSettings` below, which would otherwise
    // leave a record that can never be cleared because the delete beneath it never runs.
    delete record[resolvedFile];
    saveBookkeeping(bookkeeping, record);
    return { restored: [] };
  }

  const fresh = parseSettings(resolvedFile);
  assertWritable(resolvedFile);

  const result = reversePatch(fresh, fileRecord);
  writeAtomic(resolvedFile, `${JSON.stringify(result.settings, null, 2)}\n`);

  delete record[resolvedFile];
  saveBookkeeping(bookkeeping, record);

  return { restored: result.restored };
}
