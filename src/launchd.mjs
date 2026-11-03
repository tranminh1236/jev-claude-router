import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { patchSettings, unpatchSettings, writeAtomic } from "./claude-settings.mjs";
import { probe, statePaths } from "./daemon.mjs";
import { ENV_FILE_HINT, jevKey, loadEnv } from "./env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Resolved the same way src/daemon.mjs resolves DAEMON_BIN - relative to this file, not
// process.cwd(), because launchd gives the job no working directory at all.
const DAEMON_BIN = join(HERE, "..", "bin", "jev-daemon.mjs");
const PACKAGE_JSON = join(HERE, "..", "package.json");

export const LABEL = "com.flaviusapop.jev-router.daemon";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function plistPath(home = homedir()) {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

// "&" must go first: the other four replacements each introduce a literal "&", and escaping
// those too would turn "&lt;" into "&amp;lt;" instead of leaving it alone.
function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * launchd hands a job HOME/PATH from its own near-empty environment, not whatever a shell
 * profile exports - so this plist's EnvironmentVariables dict is the only way those two reach
 * the daemon at all. The port travels the same way, for the same reason. The routing key and
 * any tier override never do: they live in `~/.jev-router.env`, read by `loadEnv()` inside the
 * daemon process itself once it starts, never baked into a plist that `ps`, a backup, or
 * anyone with read access to ~/Library/LaunchAgents could read back out.
 */
export function plistFor({ node, script, port, log }) {
  const home = homedir();
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `    <key>Label</key>`,
    `    <string>${escapeXml(LABEL)}</string>`,
    `    <key>ProgramArguments</key>`,
    `    <array>`,
    `        <string>${escapeXml(node)}</string>`,
    `        <string>${escapeXml(script)}</string>`,
    `        <string>start</string>`,
    `        <string>--foreground</string>`,
    `    </array>`,
    `    <key>RunAtLoad</key>`,
    `    <true/>`,
    `    <key>KeepAlive</key>`,
    `    <true/>`,
    `    <key>StandardOutPath</key>`,
    `    <string>${escapeXml(log)}</string>`,
    `    <key>StandardErrorPath</key>`,
    `    <string>${escapeXml(log)}</string>`,
    `    <key>EnvironmentVariables</key>`,
    `    <dict>`,
    `        <key>HOME</key>`,
    `        <string>${escapeXml(home)}</string>`,
    `        <key>PATH</key>`,
    `        <string>${escapeXml(path)}</string>`,
    `        <key>JEV_DAEMON_PORT</key>`,
    `        <string>${port}</string>`,
    `    </dict>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

const isMacOS = () => process.platform === "darwin";
// Per-user agents live in the gui/<uid> domain from 10.11 on - the only target bootstrap/bootout
// accept for anything under ~/Library/LaunchAgents.
const guiDomain = () => `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;

/**
 * Refuses up front, before anything is written, rather than discovering mid-install that
 * launchd simply isn't available here - the failure mode Review Focus #4 names: either the
 * plist is loaded and settings are patched, or neither is, never a half-state.
 */
async function assertLaunchctlUsable() {
  if (!isMacOS()) {
    throw new Error("jev-daemon install/uninstall needs launchd, which only macOS has.");
  }
  try {
    await run("launchctl", ["list"]);
  } catch (err) {
    throw new Error(`launchctl is not usable on this machine: ${err.message}`);
  }
}

/**
 * Tried as `bootstrap`/`bootout` first (the modern, documented path since 10.11) and falls
 * back to the legacy `load -w`/`unload -w` only if that fails - left to the builder per the
 * spec's own "what's left" list, since which one actually exists varies by macOS version and
 * neither failing cleanly is the case that must produce one clear message, not a silent no-op.
 */
async function loadJob(plist) {
  await unloadJob(plist, LABEL).catch(() => {});
  try {
    await run("launchctl", ["bootstrap", guiDomain(), plist]);
  } catch (bootstrapErr) {
    try {
      await run("launchctl", ["load", "-w", plist]);
    } catch (loadErr) {
      throw new Error(
        `launchctl could not load the agent (bootstrap: ${bootstrapErr.message}; load: ${loadErr.message})`,
      );
    }
  }
}

async function unloadJob(plist, label) {
  try {
    await run("launchctl", ["bootout", `${guiDomain()}/${label}`]);
  } catch (bootoutErr) {
    try {
      await run("launchctl", ["unload", "-w", plist]);
    } catch (unloadErr) {
      throw new Error(
        `launchctl could not unload the agent (bootout: ${bootoutErr.message}; unload: ${unloadErr.message})`,
      );
    }
  }
}

/** Whether the agent is currently registered with launchd - not whether its job is healthy. */
export async function launchdLoaded(label = LABEL) {
  if (!isMacOS()) return false;
  try {
    await run("launchctl", ["list", label]);
    return true;
  } catch {
    return false;
  }
}

function packageVersion() {
  try {
    return JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).version;
  } catch {
    return null;
  }
}

// install.json already holds patchSettings/unpatchSettings's own per-file bookkeeping, keyed
// by resolved settings-file path (always an absolute filesystem path, so this literal can never
// collide with one). Reusing the same file - rather than a second one - means a single read of
// either module's own loadBookkeeping/this module's reader always sees the other's writes too,
// instead of two files that can drift out of sync with each other.
const LAUNCHD_RECORD_KEY = "__launchd__";

function readBookkeepingFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  return JSON.parse(raw); // corrupt is surfaced, not swallowed - same stance claude-settings.mjs takes
}

function writeBookkeepingFile(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
}

function saveLaunchdRecord(path, data) {
  const record = readBookkeepingFile(path);
  record[LAUNCHD_RECORD_KEY] = data;
  writeBookkeepingFile(path, record);
}

function removeLaunchdRecord(path) {
  let record;
  try {
    record = readBookkeepingFile(path);
  } catch {
    return; // Nothing this function can fix; uninstall's own unpatchSettings call still runs.
  }
  if (record[LAUNCHD_RECORD_KEY] === undefined) return;
  delete record[LAUNCHD_RECORD_KEY];
  writeBookkeepingFile(path, record);
}

/** May throw on a corrupt bookkeeping file - callers decide whether that's fatal or a reason. */
function loadLaunchdRecord(path) {
  return readBookkeepingFile(path)[LAUNCHD_RECORD_KEY];
}

/**
 * Installs the launchd agent and patches settings.json in one step, ordered so a failure
 * anywhere leaves neither change behind: refuse first on anything that would make the install
 * pointless or dangerous (no key to route with, a stranger already on the port), only then
 * write and load the plist, confirm the job actually came up as ours before touching settings
 * at all, and roll every launchd-side change back out on any later failure - including a
 * `patchSettings` failure, so a daemon left running under launchd with unpatched settings never
 * happens either.
 */
export async function installAgent({ port, home = homedir() } = {}) {
  await assertLaunchctlUsable();

  loadEnv();
  if (!jevKey()) {
    throw new Error(
      `no routing key found; put JEV_API_KEY (or TYPESAFE_API_KEY) in ${ENV_FILE_HINT()}`,
    );
  }

  const initialState = await probe(port);
  if (initialState === "foreign") {
    throw new Error(
      `port ${port} is already in use by something that isn't jev-router; refusing to install`,
    );
  }

  const paths = statePaths(home);
  mkdirSync(paths.dir, { recursive: true });

  const plist = plistPath(home);
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, plistFor({ node: process.execPath, script: DAEMON_BIN, port, log: paths.log }));

  const settingsFile = join(home, ".claude", "settings.json");
  const rollback = async () => {
    let unloadErr = null;
    try {
      await unloadJob(plist, LABEL);
    } catch (err) {
      unloadErr = err;
    }
    rmSync(plist, { force: true });
    removeLaunchdRecord(paths.install);
    try {
      unpatchSettings({ file: settingsFile, bookkeeping: paths.install });
    } catch {
      // Best effort: in the common case patchSettings never ran (or never got past its own
      // first write) and there is nothing here for this to undo.
    }
    return unloadErr;
  };

  try {
    await loadJob(plist);

    const deadline = Date.now() + 5000;
    let state = "dead";
    while (Date.now() < deadline) {
      state = await probe(port);
      if (state === "ours") break;
      await sleep(100);
    }
    if (state !== "ours") {
      throw new Error(`the agent did not come up on port ${port} within 5s; see ${paths.log}`);
    }

    saveLaunchdRecord(paths.install, {
      node: process.execPath,
      script: DAEMON_BIN,
      version: packageVersion(),
    });

    const patched = patchSettings({
      file: settingsFile,
      port,
      hookCommand: "jev-router preflight",
      bookkeeping: paths.install,
    });

    return { plist, patched };
  } catch (err) {
    const unloadErr = await rollback();
    if (unloadErr) {
      err.message += ` (rollback could not unload the agent: ${unloadErr.message}; run \`launchctl bootout ${guiDomain()}/${LABEL}\` by hand)`;
    }
    throw err;
  }
}

/** Unloads and removes the plist, then removes exactly what `installAgent` added to settings. */
export async function uninstallAgent({ home = homedir() } = {}) {
  const plist = plistPath(home);
  const paths = statePaths(home);

  // Best effort: a job already gone, or a launchctl that can't be reached, is not a reason
  // to leave the plist file and the settings patch behind - there is nothing left to protect
  // by refusing to clean up. Attempted even when the plist is already gone - `bootout` finds
  // the job by label, not by the plist file, so a job orphaned by a rollback that deleted the
  // plist but couldn't unload it is still reachable here.
  await unloadJob(plist, LABEL).catch(() => {});
  if (existsSync(plist)) {
    rmSync(plist, { force: true });
  }
  removeLaunchdRecord(paths.install);

  const { restored } = unpatchSettings({
    file: join(home, ".claude", "settings.json"),
    bookkeeping: paths.install,
  });

  return { restored };
}

/**
 * Catches node/Homebrew drift under nvm/fnm or a Homebrew bump, where the resolved node binary
 * or this package's own script path moves out from under an already-loaded plist - with
 * `KeepAlive: true`, a stale path there is a respawn loop filling daemon.log forever rather
 * than a clean failure.
 */
export function verifyAgent({ home = homedir() } = {}) {
  const reasons = [];
  const plist = plistPath(home);
  if (!existsSync(plist)) {
    reasons.push(`no launchd agent installed (no plist at ${plist})`);
    return { ok: false, reasons };
  }

  const paths = statePaths(home);
  let record;
  try {
    record = loadLaunchdRecord(paths.install);
  } catch (err) {
    reasons.push(`install record at ${paths.install} is corrupt: ${err.message}`);
    return { ok: false, reasons };
  }
  if (!record) {
    reasons.push(`no install record at ${paths.install}`);
    return { ok: false, reasons };
  }

  if (!existsSync(record.node)) {
    reasons.push(`node binary moved: ${record.node} no longer exists`);
  }
  if (!existsSync(record.script)) {
    reasons.push(`jev-daemon script moved: ${record.script} no longer exists`);
  }
  const currentVersion = packageVersion();
  if (record.version !== currentVersion) {
    reasons.push(`installed for version ${record.version}, running ${currentVersion}`);
  }

  return { ok: reasons.length === 0, reasons };
}
