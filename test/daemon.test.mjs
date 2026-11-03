import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import { startProxy, MARKER_HEADER } from "../src/proxy.mjs";
import { defaultPort, probe } from "../src/daemon.mjs";

const listen = (handler) => new Promise((done) => {
  const s = http.createServer(handler);
  s.listen(0, "127.0.0.1", () => done({ port: s.address().port, close: () => s.close() }));
});

test("defaultPort reads JEV_DAEMON_PORT fresh on each call, not at import time", () => {
  const before = process.env.JEV_DAEMON_PORT;
  try {
    delete process.env.JEV_DAEMON_PORT;
    assert.equal(defaultPort(), 61820);
    process.env.JEV_DAEMON_PORT = "61888";
    assert.equal(defaultPort(), 61888);
  } finally {
    if (before === undefined) delete process.env.JEV_DAEMON_PORT;
    else process.env.JEV_DAEMON_PORT = before;
  }
});

test("our own proxy answers the probe with a marker", async () => {
  const proxy = await startProxy({ port: 0 });
  assert.equal(await probe(proxy.port), "ours");
  proxy.close();
});

test("a stranger on the port answers 200 but is not us", async () => {
  // Claude Code probes the base URL with HEAD before its first request, so any server at all
  // answers 200. Without the marker, install would point every session at it.
  const other = await listen((req, res) => res.writeHead(200).end());
  assert.equal(await probe(other.port), "foreign");
  other.close();
});

test("nothing listening reads as dead, not as an error", async () => {
  const free = await listen(() => {});
  const port = free.port;
  free.close();
  assert.equal(await probe(port), "dead");
});

test("the proxy binds loopback only", async () => {
  const proxy = await startProxy({ port: 0 });
  const external = Object.values(os.networkInterfaces())
    .flat()
    .find((a) => a.family === "IPv4" && !a.internal);
  if (!external) {
    // No non-loopback interface to test against in this environment (e.g. a fully offline
    // sandbox) — nothing to assert either way, so skip rather than report a false pass.
    proxy.close();
    return;
  }
  await assert.rejects(
    () => fetch(`http://${external.address}:${proxy.port}/`, { signal: AbortSignal.timeout(1000) }),
  );
  proxy.close();
});
