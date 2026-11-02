#!/usr/bin/env node
import { loadEnv } from "../src/env.mjs";
import { DEFAULT_PORT, startDaemon, stopDaemon, daemonStatus } from "../src/daemon.mjs";

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

const port = Number(flagValue("--port", DEFAULT_PORT));

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
    return true;
  }
  process.stderr.write(`[jev-daemon] could not stop it (${via}); see daemon.log\n`);
  return false;
}

async function cmdStatus() {
  const status = await daemonStatus();
  if (status.running) {
    process.stderr.write(`[jev-daemon] running on port ${status.port} (pid ${status.pid}, via ${status.via})\n`);
    return true;
  }
  process.stderr.write(`[jev-daemon] not running (port ${status.port})\n`);
  return false;
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
  default:
    process.stderr.write(`[jev-daemon] usage: jev-daemon <start|stop|restart|status> [--foreground] [--port N]\n`);
    ok = false;
}

if (!ok) process.exit(1);
