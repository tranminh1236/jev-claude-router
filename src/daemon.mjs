import http from "node:http";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LABEL, guiDomain, launchdLoaded, plistPath, runLaunchctl } from "./launchd.mjs";
import { log, logTo } from "./log.mjs";
import { MARKER_HEADER, startProxy } from "./proxy.mjs";

/**
 * How long a stopping daemon lets replies already streaming finish before it exits. It serves
 * every session on the machine, so exiting at once cut all of their streams mid-reply. While it
 * drains the port reads as dead and Claude Code retries - ten attempts over about three minutes,
 * measured 2026-11-04 - so this stays well inside that: a restart costs a pause, not a reply.
 */
export const DRAIN_MS = 90_000;

// launchd refuses to bootstrap a job ("5: Input/output error") until that job's previous process
// has exited, which a drain can hold off. Bounded, because the SessionStart hook waits on this.
const BOOTSTRAP_WAIT_MS = 10_000;

const HERE = dirname(fileURLToPath(import.meta.url));
// Resolved once, relative to this file rather than process.cwd(), because a detached re-spawn
// can be launched from any working directory (launchd gives it none at all).
const DAEMON_BIN = join(HERE, "..", "bin", "jev-daemon.mjs");

/**
 * Overridable so a machine with the default port already taken by something else can move.
 * A function, not a frozen constant, so it reads JEV_DAEMON_PORT fresh on every call: callers
 * read this well after a CLI entrypoint's own loadEnv() has populated process.env from
 * ~/.jev-router.env, and a constant computed at this module's import time would miss that.
 */
export const defaultPort = () => Number(process.env.JEV_DAEMON_PORT) || 61820;

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
async function stopViaLaunchctl(home = homedir()) {
  try {
    await runLaunchctl(["bootout", `${guiDomain()}/${LABEL}`]);
  } catch {
    await runLaunchctl(["unload", "-w", plistPath(home)]);
  }
}

/** Probes until `done(state)` holds or `ms` runs out, and returns the last state seen. */
async function probeUntil(port, done, ms) {
  const deadline = Date.now() + ms;
  let state = await probe(port);
  while (!done(state) && Date.now() < deadline) {
    await sleep(100);
    state = await probe(port);
  }
  return state;
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
  // Under launchd stdout/stderr already land in daemon.log, but a hand-started daemon's only
  // land there because spawnDetached points them at it - either way, JEV_DEBUG's lines must end
  // up in one place, timestamped, or they are useless for lining up against a session.
  logTo(paths.log);
  const proxy = await startProxy({ port });
  writeFileSync(paths.pid, String(process.pid));
  writeFileSync(paths.port, String(port));
  log(`listening on 127.0.0.1:${port} (pid ${process.pid})`);

  let stopping = false;
  const shutdown = async () => {
    // A second signal means now: a person pressing Ctrl-C twice, or someone who has decided
    // the replies still streaming are not worth waiting for.
    if (stopping) process.exit(0);
    stopping = true;
    log(`stopping; letting replies in flight finish (up to ${DRAIN_MS / 1000}s)`);
    const { cut } = await proxy.shutdown({ timeoutMs: DRAIN_MS });
    log(cut ? `stopped, cutting ${cut} reply(s) still streaming` : "stopped");
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
  // detached+unref so this process's exit (or the parent shell's) can never take the daemon
  // down with it. Its output goes to daemon.log rather than nowhere: a daemon that dies before
  // its own logging is up - say, a port it cannot bind - would otherwise leave no trace at all.
  const out = openSync(paths.log, "a");
  let child;
  try {
    child = spawn(
      process.execPath,
      [DAEMON_BIN, "start", "--foreground", "--port", String(port)],
      { detached: true, stdio: ["ignore", out, out] },
    );
  } finally {
    closeSync(out);
  }
  child.unref();

  // A few seconds, not indefinite: a daemon that cannot bind its own fixed port (permissions,
  // a race with another `start`) should surface as a failure, not hang the caller.
  if ((await probeUntil(port, (s) => s === "ours", 5000)) !== "ours") {
    throw new Error(`daemon did not come up on port ${port} within 5s; check ${paths.log}`);
  }
  return { port, pid: readPidFile(paths.pid), already: false, via: "detached" };
}

/**
 * Once the agent is installed, a daemon started any other way is one nothing restarts when it
 * dies - and the agent's own job, finding the port taken, can only wait behind it. So `start`
 * (and the SessionStart hook's revive, which calls it) hands the job to launchd instead.
 */
async function startViaLaunchd({ port, paths }) {
  if (await launchdLoaded()) {
    await runLaunchctl(["kickstart", `${guiDomain()}/${LABEL}`]);
  } else {
    const deadline = Date.now() + BOOTSTRAP_WAIT_MS;
    for (;;) {
      try {
        await runLaunchctl(["bootstrap", guiDomain(), plistPath()]);
        break;
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        await sleep(250);
      }
    }
  }
  if ((await probeUntil(port, (s) => s === "ours", 5000)) !== "ours") {
    throw new Error(`the agent did not come up on port ${port} within 5s; check ${paths.log}`);
  }
  return { port, pid: readPidFile(paths.pid), already: false, via: "launchd" };
}

/**
 * Starts the daemon, or confirms it is already running. The probe - never the pid file - is
 * what decides "already running" vs. "dead": a stale pid file left behind by a SIGKILL would
 * otherwise make every subsequent `start` either no-op against nothing or signal an unrelated
 * process that happens to have reused the pid.
 */
export async function startDaemon({ port = defaultPort(), foreground = false } = {}) {
  const paths = statePaths();
  let state = await probe(port);
  if (state === "ours" && foreground) {
    // This is launchd's job, and another daemon of ours already has the port - one started by
    // hand before the agent was loaded. Exiting would have launchd restart this every ten
    // seconds for as long as that one lives, a respawn loop filling daemon.log while nothing
    // supervises the port. Waiting means the job takes over the moment the other one stops.
    mkdirSync(paths.dir, { recursive: true });
    logTo(paths.log);
    log(`port ${port} is served by pid ${readPidFile(paths.pid)}; waiting to take over when it stops`);
    while (state === "ours") {
      await sleep(1000);
      state = await probe(port);
    }
  }
  if (state === "ours") {
    return { port, pid: readPidFile(paths.pid), already: true };
  }
  if (state === "foreign") {
    throw new Error(
      `port ${port} is already in use by something that isn't jev-router. ` +
        `Set JEV_DAEMON_PORT to a free port, or stop whatever else is listening on ${port}.`,
    );
  }
  if (foreground) return runForeground({ port, paths });
  if (existsSync(plistPath())) {
    try {
      return await startViaLaunchd({ port, paths });
    } catch (err) {
      // A broken agent (a node binary that moved, say) is no reason to leave the port dead.
      log(`launchd could not start the agent (${err.message}); starting it unsupervised`);
    }
  }
  return spawnDetached({ port, paths });
}

/**
 * Stops the daemon. `KeepAlive: true` on the launchd agent would respawn a plain SIGTERM
 * within seconds, so once the agent is installed this drives `launchctl` instead and falls
 * back to the pid-file signal path otherwise (manual use, or another platform).
 */
export async function stopDaemon() {
  const paths = statePaths();
  const pid = readPidFile(paths.pid);
  const port = readPortFile(paths.port) ?? defaultPort();

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

  let via = "signal";
  if (await launchdLoaded()) {
    try {
      await stopViaLaunchctl();
      via = "launchd";
      // The job is not necessarily what holds the port: a daemon started by hand before the
      // agent was loaded keeps serving after launchd lets go. A stopping daemon closes its
      // listener at once even while it drains, so a port still answering is that other one.
      await probeUntil(port, (s) => s !== "ours", 2000);
    } catch {
      // launchctl itself refused (odd state - installed but unreachable) - fall through to the
      // signal below rather than leaving the daemon with no way to be stopped at all.
    }
  }
  if ((await probe(port)) === "ours") {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone - a stale pid file naming a process that no longer exists.
    }
  }

  // Only the port is waited on, not the process: it keeps draining its replies in the
  // background, up to DRAIN_MS, and a replacement can bind the port meanwhile.
  const state = await probeUntil(port, (s) => s !== "ours", 5000);
  cleanupFiles(paths);
  return { stopped: state !== "ours", via };
}

/**
 * Under launchd, `kickstart -k` rather than stop-then-start: stopping unloads the agent, and
 * launchd will not take it back until the old process has finished draining. Returns once the
 * replacement - a different pid - is the one serving, not merely once the port answers, which
 * the old process may still be doing for a moment after the signal.
 */
export async function restartDaemon({ port = defaultPort() } = {}) {
  const paths = statePaths();
  if (!(await launchdLoaded())) {
    await stopDaemon();
    return startDaemon({ port });
  }
  const before = readPidFile(paths.pid);
  await runLaunchctl(["kickstart", "-k", `${guiDomain()}/${LABEL}`]);
  const deadline = Date.now() + DRAIN_MS + 15_000;
  while (Date.now() < deadline) {
    const pid = readPidFile(paths.pid);
    if (pid != null && pid !== before && (await probe(port)) === "ours") {
      return { port, pid, already: false, via: "launchd" };
    }
    await sleep(200);
  }
  throw new Error(`the agent did not come back on port ${port}; check ${paths.log}`);
}

/**
 * Liveness here is the probe too, for display purposes as much as correctness: a pid file left
 * over from a killed process must never be reported as a running daemon just because the file
 * exists. `via`/`plist` read `launchdLoaded()` live rather than assuming from the plist file's
 * mere presence, so an agent that was installed and then unloaded reports "signal" correctly.
 */
export async function daemonStatus() {
  const paths = statePaths();
  const port = readPortFile(paths.port) ?? defaultPort();
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
