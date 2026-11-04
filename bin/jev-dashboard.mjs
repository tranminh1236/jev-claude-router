#!/usr/bin/env node
import { join } from "node:path";
import { createDashboardServer } from "../src/dashboard-server.mjs";
import { statePaths } from "../src/daemon.mjs";

const DEFAULT_PORT = 61821;

function flagValue(name, fallback) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i === -1 || i === args.length - 1 ? fallback : args[i + 1];
}

// A flag beats the environment: `--port` is what you typed just now, JEV_DASHBOARD_PORT is
// whatever you set up earlier and may have forgotten about.
const port = Number(flagValue("--port", process.env.JEV_DASHBOARD_PORT ?? DEFAULT_PORT));

const daemonPaths = statePaths();
const { port: boundPort, close } = await createDashboardServer({
  port,
  decisionsFile: daemonPaths.decisions,
  sessionsFile: join(daemonPaths.dir, "sessions.json"),
});

console.log(`[jev-dashboard] http://127.0.0.1:${boundPort}`);

let closed = false;
const shutdown = () => {
  if (closed) return;
  closed = true;
  close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
