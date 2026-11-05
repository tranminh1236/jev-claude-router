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
    if (!row || typeof row !== "object") continue;
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
<head>
<meta charset="utf-8"><title>Jev Router Dashboard</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  #summary { color: #555; margin-bottom: 1rem; }
  .controls { display: flex; gap: 1rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; }
  .controls label { font-size: 0.85rem; color: #555; }
  select, input { padding: 0.3rem 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; }
  input#filter-keyword { min-width: 16rem; }
  table { border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  thead th {
    text-align: left; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em;
    color: #666; background: #f0f0f0; padding: 0.5rem 0.75rem; position: sticky; top: 0;
  }
  tbody td { padding: 0.4rem 0.75rem; border-top: 1px solid #eee; font-size: 0.9rem; }
  tbody tr:nth-child(even) { background: #fcfcfc; }
  tbody tr:hover { background: #f5f8ff; }
</style>
</head>
<body>
<h1>Jev Router</h1>
<div id="summary"></div>
<div class="controls">
  <label>Project <select id="filter-project"><option value="">All</option></select></label>
  <label>Provider <select id="filter-provider"><option value="">All</option></select></label>
  <input id="filter-keyword" type="text" placeholder="Filter by keyword (reason, model, project...)">
</div>
<table id="decisions">
  <thead><tr><th>Time</th><th>Provider</th><th>Project</th><th>From</th><th>To</th><th>Confidence</th><th>Reason</th><th>Served</th></tr></thead>
  <tbody></tbody>
</table>
<script>
let lastDecisions = [];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function populateFilter(select, values) {
  const current = select.value;
  const unique = Array.from(new Set(values.filter((v) => v != null))).sort();
  select.innerHTML = '<option value="">All</option>' +
    unique.map((v) => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
  if (unique.includes(current)) select.value = current;
}

function matchesKeyword(row, keyword) {
  if (!keyword) return true;
  const haystack = [row.project, row.provider, row.from, row.to, row.reason, row.servedModel]
    .map((v) => String(v ?? '').toLowerCase())
    .join(' ');
  return haystack.includes(keyword.toLowerCase());
}

function render() {
  const projectFilter = document.querySelector('#filter-project').value;
  const providerFilter = document.querySelector('#filter-provider').value;
  const keyword = document.querySelector('#filter-keyword').value.trim();
  const rows = lastDecisions
    .filter((row) =>
      (!projectFilter || row.project === projectFilter) &&
      (!providerFilter || row.provider === providerFilter) &&
      matchesKeyword(row, keyword)
    )
    .sort((a, b) => b.ts - a.ts);
  const tbody = document.querySelector('#decisions tbody');
  tbody.innerHTML = rows.map((row) =>
    '<tr><td>' + esc(new Date(row.ts).toLocaleTimeString()) + '</td><td>' + esc(row.provider) +
    '</td><td>' + esc(row.project) + '</td><td>' + esc(row.from) + '</td><td>' + esc(row.to) +
    '</td><td>' + esc(row.confidence != null ? row.confidence.toFixed(2) : '') +
    '</td><td>' + esc(row.reason) + '</td><td>' + esc(row.servedModel) + '</td></tr>'
  ).join('');
}

async function refresh() {
  const [decisions, summary] = await Promise.all([
    fetch('/api/decisions').then((r) => r.json()),
    fetch('/api/summary').then((r) => r.json()),
  ]);
  lastDecisions = decisions;
  document.querySelector('#summary').textContent =
    'Saved $' + summary.savings.savedUsd.toFixed(4) + ' (' + summary.savings.rowsWithUsage + ' rows with usage, ' +
    summary.savings.rowsWithoutUsage + ' without)';
  populateFilter(document.querySelector('#filter-project'), decisions.map((row) => row.project));
  populateFilter(document.querySelector('#filter-provider'), decisions.map((row) => row.provider));
  render();
}
document.querySelector('#filter-project').addEventListener('change', render);
document.querySelector('#filter-provider').addEventListener('change', render);
document.querySelector('#filter-keyword').addEventListener('input', render);
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

  // A browser tab on an attacker-controlled page can be made to issue a request whose
  // hostname later re-resolves to 127.0.0.1 (DNS rebinding), which same-origin policy does
  // not stop at the DNS layer. The dashboard carries routing history, so a mismatched Host
  // header - anything but this process's own loopback address and port - is refused outright.
  const hostOk = (req) => {
    const host = req.headers.host ?? "";
    const [hostname, hostPort] = host.split(":");
    const localPort = String(req.socket.localPort);
    return (hostname === "127.0.0.1" || hostname === "localhost") && hostPort === localPort;
  };

  const server = http.createServer((req, res) => {
    try {
      if (!hostOk(req)) {
        res.writeHead(421, { "content-type": "text/plain" });
        res.end("misdirected request");
        return;
      }

      const url = new URL(req.url, "http://localhost");

      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE);
        return;
      }

      if (url.pathname === "/api/decisions") {
        const limit = Number(url.searchParams.get("limit")) || 500;
        res.writeHead(200, { "content-type": "application/json", "x-content-type-options": "nosniff" });
        res.end(JSON.stringify(withProjects(limit)));
        return;
      }

      if (url.pathname === "/api/summary") {
        const rows = withProjects(20000);
        res.writeHead(200, { "content-type": "application/json", "x-content-type-options": "nosniff" });
        res.end(JSON.stringify(buildSummary(rows, { baselineModel })));
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`internal error: ${err.message}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return { port: server.address().port, close: () => server.close() };
}
