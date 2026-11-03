#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolved relative to this file, not process.cwd() - jev-router lives in bin/ beside
// jev-daemon.mjs, so this always finds it regardless of where the installed binary is invoked
// from.
const DAEMON_BIN = fileURLToPath(new URL("./jev-daemon.mjs", import.meta.url));

const argv = process.argv.slice(2);

// "daemon" is a cosmetic alias: `jev-router daemon status` forwards to `jev-daemon.mjs status`
// after stripping the leading token, and prints one line naming what it forwarded. Every other
// first token - including "preflight" and anything unrecognized - is forwarded completely
// unchanged; jev-daemon.mjs's own switch already has a native "preflight" case and its own
// default case already writes a `usage:` line to stderr and exits 1 for anything else.
let forwarded = argv;
if (argv[0] === "daemon") {
  forwarded = argv.slice(1);
  console.log(`[jev-router] daemon ${forwarded.join(" ")}`);
}

const result = spawnSync(process.execPath, [DAEMON_BIN, ...forwarded], { stdio: "inherit" });

if (result.error) {
  process.stderr.write(`[jev-router] could not start jev-daemon: ${result.error.message}\n`);
  process.exit(1);
}

// A null status means the child was killed by a signal rather than exiting normally - treat
// that as failure rather than defaulting to a success exit code.
process.exit(result.signal ? 1 : (result.status ?? 1));
