#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "../src/env.mjs";
import { defaultPort, startDaemon, stopDaemon, daemonStatus, statePaths } from "../src/daemon.mjs";
import { installAgent, uninstallAgent, verifyAgent } from "../src/launchd.mjs";
import { preflight } from "../src/preflight.mjs";
import { USER_SETTINGS } from "../src/settings.mjs";

// Same as every other launcher: a manually-run `jev-daemon start` still needs the proxy's
// own JEV_API_KEY lookup to see ~/.jev-router.env, since nothing else loads it for this process.
loadEnv();

const args = process.argv.slice(2);
const command = args[0];
const foreground = args.includes("--foreground");

function flagValue(name, fallback) {
  const i = args.indexOf(name);
  return i === -1 || i === args.length - 1 ? fallback : args[i + 1];
}

const port = Number(flagValue("--port", defaultPort()));

async function cmdStart() {
  try {
    const { port: boundPort, pid, already } = await startDaemon({ port, foreground });
    // In --foreground mode startDaemon never returns (see src/daemon.mjs) - it is the process
    // being supervised, so this line only runs for the detached path a human invokes directly.
    process.stderr.write(
      already
        ? `[jev-daemon] already running on port ${boundPort} (pid ${pid})\n`
        : `[jev-daemon] started on port ${boundPort} (pid ${pid})\n`,
    );
    return true;
  } catch (err) {
    process.stderr.write(`[jev-daemon] ${err.message}\n`);
    return false;
  }
}

async function cmdStop() {
  const { stopped, via } = await stopDaemon();
  if (via === "none") {
    process.stderr.write(`[jev-daemon] not running\n`);
    return true; // Nothing to stop is not a failure - stop is idempotent.
  }
  if (stopped) {
    process.stderr.write(`[jev-daemon] stopped (${via})\n`);
    // The proxy's base URL in settings.json never changes just because the daemon stopped -
    // any session opened before this still points at the now-dead port until it is restarted.
    process.stderr.write(`[jev-daemon] sessions already open still point at this port until you restart them\n`);
    return true;
  }
  process.stderr.write(`[jev-daemon] could not stop it (${via}); see daemon.log\n`);
  return false;
}

async function cmdStatus() {
  const status = await daemonStatus();
  if (status.running) {
    process.stderr.write(`[jev-daemon] running on port ${status.port} (pid ${status.pid}, via ${status.via})\n`);
  } else {
    process.stderr.write(`[jev-daemon] not running (port ${status.port})\n`);
  }

  const { ok, reasons } = verifyAgent({});
  if (status.plist) {
    process.stderr.write(`[jev-daemon] launchd agent: ${status.plist}\n`);
  }
  if (!ok) {
    for (const reason of reasons) {
      process.stderr.write(`[jev-daemon] launchd agent problem: ${reason}\n`);
    }
    process.stderr.write(`[jev-daemon] re-run \`jev-daemon install\`\n`);
  }

  return status.running;
}

async function cmdInstall() {
  try {
    const { plist, patched } = await installAgent({ port });
    for (const key of patched.changed) {
      process.stderr.write(`[jev-daemon] + ${key}\n`);
    }
    for (const key of patched.skipped) {
      process.stderr.write(`[jev-daemon] = ${key} (already set, left alone)\n`);
    }
    process.stderr.write(`[jev-daemon] installed ${plist}\n`);
    process.stderr.write(`[jev-daemon] undo with: jev-daemon uninstall\n`);
    return true;
  } catch (err) {
    process.stderr.write(`[jev-daemon] install failed: ${err.message}\n`);
    return false;
  }
}

/**
 * What Claude Code's SessionStart hook actually invokes. Reads the hook's JSON off stdin
 * rather than argv - that's the contract the hook itself is written against - and never exits
 * nonzero: a nonzero exit from a SessionStart hook can block the session it's supposed to be
 * protecting, which is exactly the failure mode `preflight` (src/preflight.mjs) exists to avoid.
 */
async function cmdPreflight() {
  let input;
  try {
    // readFileSync(0, ...) rather than an async stream reader - this is a one-shot hook
    // invocation, not a long-lived process, so there's nothing to gain from not blocking here.
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // Empty or malformed stdin (e.g. the hook invoked with nothing piped in during manual
    // testing) must not crash the hook - treat it as "no session info" and let preflight's own
    // probe decide the outcome.
    input = { session_id: null, cwd: null };
  }

  const daemonPaths = statePaths();
  const paths = {
    sessions: join(daemonPaths.dir, "sessions.json"),
    settings: USER_SETTINGS,
    bookkeeping: daemonPaths.install,
  };

  const { notice } = await preflight({ input, port, paths });
  if (notice) process.stderr.write(`${notice}\n`);
  return true; // Always "ok" - see the doc comment above.
}

async function cmdUninstall() {
  try {
    const { restored } = await uninstallAgent({});
    for (const key of restored) {
      process.stderr.write(`[jev-daemon] - ${key}\n`);
    }
    process.stderr.write(`[jev-daemon] uninstalled\n`);
    return true;
  } catch (err) {
    process.stderr.write(`[jev-daemon] uninstall failed: ${err.message}\n`);
    return false;
  }
}

let ok;
switch (command) {
  case "start":
    ok = await cmdStart();
    break;
  case "stop":
    ok = await cmdStop();
    break;
  case "restart":
    // Stopping first even when nothing is running is fine - cmdStop treats that as success,
    // not a reason to refuse the restart.
    await cmdStop();
    ok = await cmdStart();
    break;
  case "status":
    ok = await cmdStatus();
    break;
  case "install":
    ok = await cmdInstall();
    break;
  case "uninstall":
    ok = await cmdUninstall();
    break;
  case "preflight":
    ok = await cmdPreflight();
    break;
  default:
    process.stderr.write(
      `[jev-daemon] usage: jev-daemon <start|stop|restart|status|install|uninstall|preflight> [--foreground] [--port N]\n`,
    );
    ok = false;
}

if (!ok) process.exit(1);
