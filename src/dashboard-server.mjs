import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { computeSavings } from "./price.mjs";

/**
 * Reads the decision log, joining each `decision` row with the `usage` row sharing its
 * `reqId` (if any). Missing file -> []. A malformed line is skipped, never thrown over: the
 * dashboard reads a log a live proxy may be appending to concurrently.
 */
export function readDecisions(decisionsFile, limit = 500) {
  if (!existsSync(decisionsFile)) return [];
  let text;
  try {
    text = readFileSync(decisionsFile, "utf8");
  } catch {
    return [];
  }

  const decisions = [];
  const usageByReqId = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.kind === "decision") decisions.push(row);
    else if (row.kind === "usage") usageByReqId.set(row.reqId, row);
  }

  const merged = decisions.map((row) => {
    const usageRow = usageByReqId.get(row.reqId);
    return {
      ...row,
      usage: usageRow?.usage ?? null,
      servedModel: usageRow?.servedModel ?? null,
    };
  });

  merged.reverse();
  return merged.slice(0, limit);
}

/** Parses the `session_id -> cwd` map `rememberSession` (src/preflight.mjs) writes. */
export function readSessionsMap(sessionsFile) {
  if (!existsSync(sessionsFile)) return {};
  try {
    const parsed = JSON.parse(readFileSync(sessionsFile, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function projectOf(cwd) {
  return typeof cwd === "string" && cwd ? basename(cwd) : "unknown";
}

export function buildSummary(rows, { baselineModel }) {
  const byTier = {};
  const byProject = {};
  const byProvider = {};
  for (const row of rows) {
    if (row.to) byTier[row.to] = (byTier[row.to] ?? 0) + 1;
    if (row.project) byProject[row.project] = (byProject[row.project] ?? 0) + 1;
    if (row.provider) byProvider[row.provider] = (byProvider[row.provider] ?? 0) + 1;
  }
  return { byTier, byProject, byProvider, savings: computeSavings(rows, { baselineModel }) };
}

const PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Jev Router Dashboard</title></head>
<body>
<h1>Jev Router</h1>
<div id="summary"></div>
<table id="decisions">
  <thead><tr><th>Time</th><th>Provider</th><th>Project</th><th>From</th><th>To</th><th>Reason</th><th>Served</th></tr></thead>
  <tbody></tbody>
</table>
<script>
async function refresh() {
  const [decisions, summary] = await Promise.all([
    fetch('/api/decisions').then((r) => r.json()),
    fetch('/api/summary').then((r) => r.json()),
  ]);
  document.querySelector('#summary').textContent =
    'Saved $' + summary.savings.savedUsd.toFixed(4) + ' (' + summary.savings.rowsWithUsage + ' rows with usage)';
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const tbody = document.querySelector('#decisions tbody');
  tbody.innerHTML = decisions.map((row) =>
    '<tr><td>' + esc(new Date(row.ts).toLocaleTimeString()) + '</td><td>' + esc(row.provider) +
    '</td><td>' + esc(row.project) + '</td><td>' + esc(row.from) + '</td><td>' + esc(row.to) +
    '</td><td>' + esc(row.reason) + '</td><td>' + esc(row.servedModel) + '</td></tr>'
  ).join('');
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

export async function createDashboardServer({
  port = 0,
  decisionsFile,
  sessionsFile,
  baselineModel = "claude-opus-5",
} = {}) {
  const withProjects = (limit) => {
    const sessions = readSessionsMap(sessionsFile);
    return readDecisions(decisionsFile, limit).map((row) => ({
      ...row,
      project: projectOf(sessions[row.session]),
    }));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
      return;
    }

    if (url.pathname === "/api/decisions") {
      const limit = Number(url.searchParams.get("limit")) || 500;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(withProjects(limit)));
      return;
    }

    if (url.pathname === "/api/summary") {
      const rows = withProjects(20000);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(buildSummary(rows, { baselineModel })));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}
