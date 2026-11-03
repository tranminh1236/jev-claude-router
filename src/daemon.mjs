import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LABEL, launchdLoaded, plistPath } from "./launchd.mjs";
import { MARKER_HEADER, startProxy } from "./proxy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Resolved once, relative to this file rather than process.cwd(), because a detached re-spawn
// can be launched from any working directory (launchd gives it none at all).
const DAEMON_BIN = join(HERE, "..", "bin", "jev-daemon.mjs");

/** Overridable so a machine with the default port already taken by something else can move. */
export const DEFAULT_PORT = Number(process.env.JEV_DAEMON_PORT) || 61820;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Where the daemon keeps everything that outlives any one process: the pid and port of
 * whichever instance is currently running, its log, and (Task 5) the bookkeeping `install`
 * needs to undo itself. Centralized so every caller agrees on the layout instead of each
 * re-deriving `~/.jev-router/...`.
 */
export function statePaths(home = homedir()) {
  const dir = join(home, ".jev-router");
  return {
    dir,
    pid: join(dir, "daemon.pid"),
    port: join(dir, "daemon.port"),
    log: join(dir, "daemon.log"),
    install: join(dir, "install.json"),
  };
}

const readTrimmed = (file) => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
};

const readPidFile = (file) => {
  const raw = readTrimmed(file);
  const pid = raw ? Number(raw) : NaN;
  return Number.isInteger(pid) ? pid : null;
};

const readPortFile = (file) => {
  const raw = readTrimmed(file);
  const port = raw ? Number(raw) : NaN;
  return Number.isInteger(port) ? port : null;
};

/**
 * Stops the job the way launchd itself expects to be told, not with a bare `process.kill`:
 * `KeepAlive: true` on the agent would otherwise respawn a SIGTERM'd daemon within seconds,
 * making a plain `stop` look like it silently failed. Tries the modern `bootout` target first
 * and falls back to legacy `unload -w`, same as src/launchd.mjs's own loadJob/unloadJob, since
 * that module doesn't export either and duplicating this one call is cheaper than widening its
 * exported surface for a single caller.
 */
function stopViaLaunchctl(home = homedir()) {
  return new Promise((resolve, reject) => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    execFile("launchctl", ["bootout", `gui/${uid}/${LABEL}`], (err) => {
      if (!err) return resolve();
      execFile("launchctl", ["unload", "-w", plistPath(home)], (err2) => {
        if (err2) reject(err2);
        else resolve();
      });
    });
  });
}

const cleanupFiles = (paths) => {
  for (const file of [paths.pid, paths.port]) {
    try {
      rmSync(file);
    } catch {
      // Already gone; nothing to clean up.
    }
  }
};

/**
 * Classifies whatever is listening on `port` without trusting the pid file, which can outlive
 * the process it names - a SIGKILLed daemon's pid gets reused by an unrelated process, and a
 * pid-file check alone would then call that process "ours". `HEAD /` with the marker header is
 * the only signal that cannot lie this way: Claude Code's own probe (and a stranger's bare 200
 * to it) look identical to anything less specific.
 */
export function probe(port, { timeout = 500 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "HEAD", path: "/", timeout },
      (res) => {
        res.resume();
        resolve(res.headers[MARKER_HEADER] ? "ours" : "foreign");
      },
    );
    req.on("timeout", () => req.destroy());
    // A timeout and a connection refusal both mean nothing we can talk to is there; neither is
    // the caller's problem to handle differently.
    req.on("error", () => resolve("dead"));
    req.end();
  });
}

/**
 * The process that actually becomes the proxy: starts it on the fixed port, records this pid
 * so `status`/`stop` can display and signal it, and then blocks forever. It is meant to be run
 * either under launchd (Task 5) or as the detached child a plain `start` re-spawns below, and
 * in both cases the only clean way out is a signal - returning here would hand control back to
 * a caller (launchd, or the detached parent that already `unref()`-ed it) that has nothing
 * left to do with it.
 */
async function runForeground({ port, paths }) {
  mkdirSync(paths.dir, { recursive: true });
  const proxy = await startProxy({ port });
  writeFileSync(paths.pid, String(process.pid));
  writeFileSync(paths.port, String(port));

  const shutdown = () => {
    proxy.close();
    // Explicit 0: launchd's KeepAlive and a plain `kill` both read a nonzero exit as a crash
    // worth respawning, which a deliberate stop is not.
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return new Promise(() => {}); // deliberately never resolves - see the doc comment above.
}

async function spawnDetached({ port, paths }) {
  mkdirSync(paths.dir, { recursive: true });
  const child = spawn(
    process.execPath,
    [DAEMON_BIN, "start", "--foreground", "--port", String(port)],
    // stdio: "ignore" plus detached+unref so this process's exit (or the parent shell's) can
    // never take the daemon down with it. Nothing here is lost: once Task 5's launchd agent
    // takes over, its own plist captures stdout/stderr into daemon.log.
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  // A few seconds, not indefinite: a daemon that cannot bind its own fixed port (permissions,
  // a race with another `start`) should surface as a failure, not hang the caller.
  const deadline = Date.now() + 5000;
  let state = "dead";
  while (Date.now() < deadline) {
    state = await probe(port);
    if (state === "ours") break;
    await sleep(100);
  }
  if (state !== "ours") {
    throw new Error(`daemon did not come up on port ${port} within 5s; check ${paths.log}`);
  }
  return { port, pid: readPidFile(paths.pid), already: false };
}

/**
 * Starts the daemon, or confirms it is already running. The probe - never the pid file - is
 * what decides "already running" vs. "dead": a stale pid file left behind by a SIGKILL would
 * otherwise make every subsequent `start` either no-op against nothing or signal an unrelated
 * process that happens to have reused the pid.
 */
export async function startDaemon({ port = DEFAULT_PORT, foreground = false } = {}) {
  const paths = statePaths();
  const state = await probe(port);
  if (state === "ours") {
    return { port, pid: readPidFile(paths.pid), already: true };
  }
  if (state === "foreign") {
    throw new Error(
      `port ${port} is already in use by something that isn't jev-router. ` +
        `Set JEV_DAEMON_PORT to a free port, or stop whatever else is listening on ${port}.`,
    );
  }
  return foreground ? runForeground({ port, paths }) : spawnDetached({ port, paths });
}

/**
 * Stops the daemon. `KeepAlive: true` on the launchd agent would respawn a plain SIGTERM
 * within seconds, so once the agent is installed this drives `launchctl` instead and falls
 * back to the pid-file signal path otherwise (manual use, or another platform).
 */
export async function stopDaemon() {
  const paths = statePaths();
  const pid = readPidFile(paths.pid);
  const port = readPortFile(paths.port) ?? DEFAULT_PORT;

  if (pid == null) {
    cleanupFiles(paths);
    return { stopped: false, via: "none" };
  }

  // Confirm the pid file still names our daemon before touching anything - the same hazard
  // probe()'s doc comment calls out for startDaemon/daemonStatus applies here too: a SIGKILLed
  // daemon's pid can be reused by an unrelated process, and signaling (or stopping the launchd
  // job) on the pid file alone would then act on whatever process happened to inherit that
  // number. "foreign" is treated the same as "dead" here - there is nothing of ours left to
  // stop either way, and acting on the wrong process is strictly worse than a no-op.
  if ((await probe(port)) !== "ours") {
    cleanupFiles(paths);
    return { stopped: true, via: "none" };
  }

  const underLaunchd = await launchdLoaded();
  let via = "signal";
  if (underLaunchd) {
    try {
      await stopViaLaunchctl();
      via = "launchd";
    } catch {
      // launchctl itself refused (odd state - installed but unreachable) - fall through to the
      // signal path below rather than leaving the daemon with no way to be stopped at all.
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone - a stale pid file naming a process that no longer exists.
    }
  }

  const deadline = Date.now() + 5000;
  let state = await probe(port);
  while (Date.now() < deadline && state === "ours") {
    await sleep(100);
    state = await probe(port);
  }

  cleanupFiles(paths);
  return { stopped: state !== "ours", via };
}

/**
 * Liveness here is the probe too, for display purposes as much as correctness: a pid file left
 * over from a killed process must never be reported as a running daemon just because the file
 * exists. `via`/`plist` read `launchdLoaded()` live rather than assuming from the plist file's
 * mere presence, so an agent that was installed and then unloaded reports "signal" correctly.
 */
export async function daemonStatus() {
  const paths = statePaths();
  const port = readPortFile(paths.port) ?? DEFAULT_PORT;
  const state = await probe(port);
  const running = state === "ours";
  const underLaunchd = await launchdLoaded();
  return {
    running,
    port,
    pid: running ? readPidFile(paths.pid) : null,
    via: underLaunchd ? "launchd" : "signal",
    plist: underLaunchd ? plistPath() : null,
  };
}
