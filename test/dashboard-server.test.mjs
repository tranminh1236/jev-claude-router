import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import http from "node:http";
import {
  readDecisions,
  readSessionsMap,
  projectOf,
  buildSummary,
  createDashboardServer,
} from "../src/dashboard-server.mjs";

function tmpFile(name) {
  const dir = mkdtempSync(join(tmpdir(), "jev-dashboard-test-"));
  return join(dir, `${name}-${randomUUID()}.jsonl`);
}

test("readDecisions joins a usage row onto its decision by reqId", () => {
  const file = tmpFile("decisions");
  writeFileSync(
    file,
    JSON.stringify({ kind: "decision", reqId: "r1", ts: 1, to: "haiku" }) +
      "\n" +
      JSON.stringify({ kind: "usage", reqId: "r1", usage: { outputTokens: 5 }, servedModel: "m1" }) +
      "\n",
  );
  const [row] = readDecisions(file);
  assert.equal(row.to, "haiku");
  assert.deepEqual(row.usage, { outputTokens: 5 });
  assert.equal(row.servedModel, "m1");
});

test("readDecisions on a missing file returns an empty array", () => {
  assert.deepEqual(readDecisions(join(tmpdir(), `nope-${randomUUID()}.jsonl`)), []);
});

test("readDecisions skips a malformed line without throwing", () => {
  const file = tmpFile("decisions");
  writeFileSync(file, "not json\n" + JSON.stringify({ kind: "decision", reqId: "r2", ts: 1, to: "sonnet" }) + "\n");
  const rows = readDecisions(file);
  assert.equal(rows.length, 1);
});

test("readDecisions skips a line that parses to a non-object without throwing", () => {
  const file = tmpFile("decisions");
  writeFileSync(file, "null\n" + "42\n" + JSON.stringify({ kind: "decision", reqId: "r4", ts: 1, to: "opus" }) + "\n");
  const rows = readDecisions(file);
  assert.equal(rows.length, 1);
});

test("projectOf falls back to unknown when cwd is missing", () => {
  assert.equal(projectOf(undefined), "unknown");
  assert.equal(projectOf("/Users/x/my-project"), "my-project");
});

test("buildSummary tallies by tier and excludes usage-less rows from savings", () => {
  const rows = [
    {
      to: "haiku",
      project: "p1",
      provider: "claude",
      servedModel: "claude-haiku-4-5-20251001",
      usage: { outputTokens: 10 },
    },
    { to: "opus", project: "p1", provider: "codex", servedModel: null, usage: null },
  ];
  const summary = buildSummary(rows, { baselineModel: "claude-opus-5" });
  assert.equal(summary.byTier.haiku, 1);
  assert.equal(summary.byProvider.codex, 1);
  assert.equal(summary.savings.rowsWithoutUsage, 1);
});

test("GET /api/decisions and /api/summary respond 200 with JSON over a joined fixture log", async (t) => {
  const decisionsFile = tmpFile("decisions");
  const sessionsFile = tmpFile("sessions");
  writeFileSync(
    decisionsFile,
    JSON.stringify({ kind: "decision", reqId: "r3", ts: 1, to: "sonnet", session: "s1" }) + "\n",
  );
  writeFileSync(sessionsFile, JSON.stringify({ s1: "/Users/x/my-project" }));

  const { port, close } = await createDashboardServer({ decisionsFile, sessionsFile });
  t.after(() => close());

  const decisionsRes = await fetch(`http://127.0.0.1:${port}/api/decisions`);
  const decisions = await decisionsRes.json();
  const summaryRes = await fetch(`http://127.0.0.1:${port}/api/summary`);
  const summary = await summaryRes.json();

  assert.equal(decisionsRes.status, 200);
  assert.equal(summaryRes.status, 200);
  assert.ok(Array.isArray(decisions));
  assert.equal(decisions[0].project, "my-project");
  assert.ok(summary.savings);
});

test("GET / returns an HTML page and an unknown path 404s", async (t) => {
  const decisionsFile = tmpFile("decisions");
  const sessionsFile = tmpFile("sessions");
  writeFileSync(decisionsFile, "");
  writeFileSync(sessionsFile, "{}");

  const { port, close } = await createDashboardServer({ decisionsFile, sessionsFile });
  t.after(() => close());

  const home = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type"), /text\/html/);
  assert.match(await home.text(), /<table/);

  const missing = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(missing.status, 404);
});

test("rejects a request whose Host header does not name this server (DNS rebinding)", async (t) => {
  const decisionsFile = tmpFile("decisions");
  const sessionsFile = tmpFile("sessions");
  writeFileSync(decisionsFile, "");
  writeFileSync(sessionsFile, "{}");

  const { port, close } = await createDashboardServer({ decisionsFile, sessionsFile });
  t.after(() => close());

  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/api/summary", headers: { host: "evil.example:80" } },
      (res) => resolve(res.statusCode),
    );
    req.on("error", reject);
    req.end();
  });
  assert.ok(status === 403 || status === 421, `expected 403/421, got ${status}`);
});

/**
 * createDashboardServer awaited `server.listen` without ever listening for the server's own
 * "error" event, so a taken port left the returned promise pending forever instead of
 * rejecting - the caller (bin/jev-dashboard.mjs) would hang rather than report EADDRINUSE.
 */
test("createDashboardServer rejects instead of hanging when the port is already in use", async (t) => {
  const decisionsFile = tmpFile("decisions");
  const sessionsFile = tmpFile("sessions");
  writeFileSync(decisionsFile, "");
  writeFileSync(sessionsFile, "{}");

  const first = await createDashboardServer({ decisionsFile, sessionsFile });
  t.after(() => first.close());

  await assert.rejects(
    () => createDashboardServer({ port: first.port, decisionsFile, sessionsFile }),
    /EADDRINUSE/,
  );
});
