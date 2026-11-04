import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "jev-daemon.mjs");

// Stands in for /bin/launchctl. The real agent shares the production label, and the live daemon
// on 61820 may be serving the very session running these tests, so neither may ever be reached:
// every test runs under a throwaway HOME with this first on PATH. State lives in
// $FAKE_LAUNCHCTL_DIR - `loaded` (agent registered), `jobpid` (the process "launchd" runs),
// `port` (what the job serves), `busy` (how many bootstraps still fail the way launchd does while
// the job's previous process has not exited yet), `calls.log`. The job it runs is the real
// daemon, `jev-daemon start --foreground`, exactly as the plist runs it.
const FAKE_LAUNCHCTL = String.raw`
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const dir = process.env.FAKE_LAUNCHCTL_DIR;
const args = process.argv.slice(2);
appendFileSync(join(dir, "calls.log"), args.join(" ") + "\n");
const file = (name) => join(dir, name);
const read = (name) => (existsSync(file(name)) ? readFileSync(file(name), "utf8").trim() : null);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jobPid = () => Number(read("jobpid")) || null;
const startJob = () => {
  const child = spawn(process.execPath, [process.env.FAKE_DAEMON_BIN, "start", "--foreground", "--port", read("port")],
    { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(file("jobpid"), String(child.pid));
};

if (args[0] === "list") process.exit(args[1] && !existsSync(file("loaded")) ? 113 : 0);
if (args[0] === "bootstrap") {
  const busy = Number(read("busy") ?? 0);
  if (busy > 0) {
    writeFileSync(file("busy"), String(busy - 1));
    process.stderr.write("Bootstrap failed: 5: Input/output error\n");
    process.exit(5);
  }
  writeFileSync(file("loaded"), "");
  startJob();
  process.exit(0);
}
if (args[0] === "bootout") {
  rmSync(file("loaded"), { force: true });
  const pid = jobPid();
  if (pid && alive(pid)) process.kill(pid, "SIGTERM");
  process.exit(0);
}
if (args[0] === "kickstart") {
  if (!existsSync(file("loaded"))) process.exit(113);
  const pid = jobPid();
  if (pid && alive(pid)) {
    if (!args.includes("-k")) process.exit(0);
    process.kill(pid, "SIGTERM"); // launchd starts the replacement only once this one exits
    while (alive(pid)) await sleep(50);
  }
  startJob();
  process.exit(0);
}
process.exit(1);
`;

const ROOT = mkdtempSync(join(tmpdir(), "jev-lifecycle-"));
const FAKE_BIN = join(ROOT, "bin");
mkdirSync(FAKE_BIN);
writeFileSync(join(FAKE_BIN, "fake-launchctl.mjs"), FAKE_LAUNCHCTL);
writeFileSync(
  join(FAKE_BIN, "launchctl"),
  `#!/bin/sh\nexec "${process.execPath}" "${join(FAKE_BIN, "fake-launchctl.mjs")}" "$@"\n`,
);
chmodSync(join(FAKE_BIN, "launchctl"), 0o755);
process.env.PATH = `${FAKE_BIN}:${process.env.PATH}`;
process.env.FAKE_DAEMON_BIN = DAEMON_BIN;
delete process.env.JEV_DAEMON_PORT;
delete process.env.JEV_DEBUG;

// Isolated before the modules under test load, so nothing they compute can see the real HOME.
let home = join(ROOT, "boot");
mkdirSync(home);
process.env.HOME = home;

const { probe, startDaemon, stopDaemon, restartDaemon, statePaths } = await import("../src/daemon.mjs");
const { startProxy } = await import("../src/proxy.mjs");
const { plistPath } = await import("../src/launchd.mjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  assert.fail(`timed out after ${ms}ms waiting for ${what}`);
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const readPid = () => {
  try {
    return Number(readFileSync(statePaths().pid, "utf8").trim()) || null;
  } catch {
    return null;
  }
};

/** A fresh HOME and fake-launchd state per test; every daemon it started is killed afterwards. */
async function fresh(t, { installed = false, loaded = false } = {}) {
  home = mkdtempSync(join(ROOT, "home-"));
  process.env.HOME = home;
  const fake = join(home, "fake-launchd");
  mkdirSync(fake);
  process.env.FAKE_LAUNCHCTL_DIR = fake;
  const port = await freePort();
  writeFileSync(join(fake, "port"), String(port));
  if (installed) {
    mkdirSync(dirname(plistPath()), { recursive: true });
    writeFileSync(plistPath(), "<plist/>");
  }
  if (loaded) writeFileSync(join(fake, "loaded"), "");
  const spawned = [];
  t.after(() => {
    const pids = [...spawned, readPid()];
    try {
      pids.push(Number(readFileSync(join(fake, "jobpid"), "utf8")));
    } catch {}
    for (const pid of pids) {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    }
  });
  const calls = () => {
    try {
      return readFileSync(join(fake, "calls.log"), "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  const foreground = () => {
    const child = spawn(process.execPath, [DAEMON_BIN, "start", "--foreground", "--port", String(port)], {
      env: { ...process.env },
      stdio: "ignore",
    });
    spawned.push(child.pid);
    return child;
  };
  return { port, fake, calls, foreground, log: () => readFileSync(statePaths().log, "utf8") };
}

const exitOf = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

test("a running daemon writes timestamped lines to daemon.log", async (t) => {
  const { port, foreground, log } = await fresh(t);
  const child = foreground();
  await waitFor(async () => (await probe(port)) === "ours", 5000, "the daemon to come up");
  await waitFor(() => existsSync(statePaths().log), 2000, "daemon.log");
  assert.match(log(), new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[^ ]+ .*listening.*${port}.*pid ${child.pid}`, "m"));
});

test("a daemon started in the background leaves the reason it died in daemon.log", async (t) => {
  const { port } = await fresh(t);
  // Something that accepts connections and never answers: the probe times out and reads it as
  // dead, so a daemon is spawned, and that daemon then cannot bind the port.
  const hung = net.createServer(() => {}).listen(port, "127.0.0.1");
  t.after(() => hung.close());
  await new Promise((resolve) => hung.once("listening", resolve));

  await assert.rejects(() => startDaemon({ port }), /did not come up/);
  assert.match(readFileSync(statePaths().log, "utf8"), /EADDRINUSE/);
});

test("a supervised daemon waits for a hand-started one to let go of the port, then takes over", async (t) => {
  const { port, foreground } = await fresh(t);
  const handStarted = await startProxy({ port });
  t.after(() => handStarted.close());

  // launchd's KeepAlive restarts a job that exits, so exiting here would be a respawn loop.
  const job = foreground();
  await sleep(1500);
  assert.equal(job.exitCode, null, "the supervised daemon exited instead of waiting");
  assert.equal(job.signalCode, null);

  handStarted.close();
  await waitFor(async () => readPid() === job.pid && (await probe(port)) === "ours", 5000, "the takeover");

  job.kill("SIGTERM");
  assert.deepEqual(await exitOf(job), { code: 0, signal: null });
});

test("start goes through launchd once the agent is installed, instead of an unsupervised process", async (t) => {
  const { port, fake, calls } = await fresh(t, { installed: true });
  const result = await startDaemon({ port });
  assert.equal(result.via, "launchd");
  assert.ok(calls().some((c) => c.startsWith("bootstrap ")), `no bootstrap in ${calls()}`);
  const job = Number(readFileSync(join(fake, "jobpid"), "utf8"));
  await waitFor(() => readPid() === job, 2000, "the launchd job to be the one serving");
  assert.equal(await probe(port), "ours");
});

test("start retries while launchd still holds the job's previous process", async (t) => {
  const { port, fake } = await fresh(t, { installed: true });
  writeFileSync(join(fake, "busy"), "2");
  const result = await startDaemon({ port });
  assert.equal(result.via, "launchd");
  assert.equal(await probe(port), "ours");
});

test("stop also stops a hand-started daemon still holding the port after launchd lets go", async (t) => {
  const { port, foreground } = await fresh(t, { installed: true, loaded: true });
  const handStarted = foreground();
  await waitFor(async () => readPid() === handStarted.pid && (await probe(port)) === "ours", 5000, "the daemon");

  const { stopped } = await stopDaemon();
  assert.equal(stopped, true);
  assert.equal(await probe(port), "dead");
  assert.deepEqual(await exitOf(handStarted), { code: 0, signal: null });
});

test("restart under launchd swaps the process but keeps the agent loaded", async (t) => {
  const { port, fake, calls } = await fresh(t, { installed: true });
  await startDaemon({ port });
  const before = Number(readFileSync(join(fake, "jobpid"), "utf8"));
  await waitFor(() => readPid() === before, 2000, "the first job to serve");

  await restartDaemon({ port });
  const after = readPid();
  assert.notEqual(after, before, "restart returned while the old process was still the one serving");
  assert.equal(after, Number(readFileSync(join(fake, "jobpid"), "utf8")));
  assert.equal(await probe(port), "ours");
  assert.ok(existsSync(join(fake, "loaded")), "restart unloaded the agent");
  assert.ok(!calls().some((c) => c.startsWith("bootout")), `restart booted the agent out: ${calls()}`);
});
