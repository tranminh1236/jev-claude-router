import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../src/proxy.mjs";
import { startCodexProxy } from "../src/codex-proxy.mjs";
import { startGrokProxy } from "../src/grok-proxy.mjs";

/**
 * A Mac waking from sleep leaves the keep-alive pool full of sockets the other end has already
 * forgotten, so the first forward after a wake is answered with an RST rather than a reply.
 * These upstreams stand in for that: `resets` of them kill the connection before writing
 * anything, and the ones after answer normally.
 */
function flakyUpstream({ resets }) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    if (hits <= resets) return void req.socket.destroy();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"model":"claude-sonnet-5"}`);
  });
  return {
    server,
    hitCount: () => hits,
    async url() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
  };
}

/** An upstream that starts a reply, then dies mid-stream - too late to retry safely. */
function dieMidStreamUpstream() {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: partial\n\n");
    setTimeout(() => res.socket.destroy(), 10);
  });
  return {
    server,
    hitCount: () => hits,
    async url() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
  };
}

/** Rejects with `label` if `promise` has not settled within `ms` - a bounded way to assert
 *  "this does not hang" instead of waiting forever on a real one. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function post(port, { path = "/v1/messages", method = "POST", headers = {}, signal } = {}) {
  const body = JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] });
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.request(
      { host: "127.0.0.1", port, method, path, agent: false, signal, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        const parts = [];
        res.on("data", (c) => parts.push(c));
        // A reply cut mid-stream ends in `close` or `error`, never `end`, so all three have to
        // settle this or the test just hangs.
        const finish = () => done({ status: res.statusCode, text: Buffer.concat(parts).toString() });
        res.on("end", finish);
        res.on("error", finish);
        res.on("close", finish);
      },
    );
    req.on("error", (err) => done({ status: "client-error", text: err.message }));
    req.end(method === "POST" ? body : undefined);
  });
}

test("claude proxy retries a reset that arrives before any reply", async (t) => {
  const upstream = flakyUpstream({ resets: 1 });
  const url = await upstream.url();
  const proxy = await startProxy({ upstream: url });
  t.after(() => {
    proxy.close();
    upstream.server.close();
  });

  const got = await post(proxy.port);

  assert.equal(got.status, 200, "the reset should not reach Claude Code");
  assert.equal(upstream.hitCount(), 2, "exactly one retry");
});

test("claude proxy gives up after one retry", async (t) => {
  const upstream = flakyUpstream({ resets: 5 });
  const url = await upstream.url();
  const proxy = await startProxy({ upstream: url });
  t.after(() => {
    proxy.close();
    upstream.server.close();
  });

  const got = await post(proxy.port);

  assert.equal(got.status, 502);
  assert.equal(upstream.hitCount(), 2, "one attempt, one retry, then the error is reported");
});

test("claude proxy does not retry once the reply has started streaming", async (t) => {
  const upstream = dieMidStreamUpstream();
  const url = await upstream.url();
  const proxy = await startProxy({ upstream: url });
  t.after(() => {
    proxy.close();
    upstream.server.close();
  });

  await withTimeout(post(proxy.port), 1000, "client response");

  assert.equal(upstream.hitCount(), 1, "a half-sent reply must not be sent twice");
});

test("claude proxy ends the client response when the upstream dies mid-stream", async (t) => {
  const upstream = dieMidStreamUpstream();
  const url = await upstream.url();
  const proxy = await startProxy({ upstream: url });
  t.after(() => {
    proxy.close();
    upstream.server.close();
  });

  // `response.pipe(res)` does not forward the upstream's death to `res` - without a fix, this
  // request hangs forever instead of the client ever seeing the connection close.
  const got = await withTimeout(post(proxy.port), 1000, "client response");

  assert.match(got.text, /partial/, "what streamed before the upstream died is still delivered");
});

test("codex proxy ends the client response when the upstream dies mid-stream", async (t) => {
  const upstream = dieMidStreamUpstream();
  const url = await upstream.url();
  const proxy = await startCodexProxy({ chatgptBaseURL: url, apiBaseURL: url, route: async () => null });
  t.after(() => {
    proxy.close();
    upstream.server.close();
  });

  const got = await withTimeout(post(proxy.port, { path: "/responses" }), 1000, "client response");

  assert.match(got.text, /partial/, "what streamed before the upstream died is still delivered");
});

test("grok proxy ends the client response when the upstream dies mid-stream", async (t) => {
  const upstream = dieMidStreamUpstream();
  const url = await upstream.url();
  const proxy = await startGrokProxy({ baseURL: url, route: async () => null });
  t.after(() => {
    proxy.close();
    upstream.server.close();
  });

  const got = await withTimeout(post(proxy.port, { path: "/responses" }), 1000, "client response");

  assert.match(got.text, /partial/, "what streamed before the upstream died is still delivered");
});

test("codex proxy retries a reset that arrives before any reply", async (t) => {
  const upstream = flakyUpstream({ resets: 1 });
  const url = await upstream.url();
  const proxy = await startCodexProxy({ chatgptBaseURL: url, apiBaseURL: url, route: async () => null });
  t.after(() => {
    proxy.close();
    upstream.server.close();
  });

  const got = await post(proxy.port, { path: "/responses" });

  assert.equal(got.status, 200, "the reset should not reach Codex");
  assert.equal(upstream.hitCount(), 2, "exactly one retry");
});

test("grok proxy retries a reset that arrives before any reply", async (t) => {
  const upstream = flakyUpstream({ resets: 1 });
  const url = await upstream.url();
  const proxy = await startGrokProxy({ baseURL: url, route: async () => null });
  t.after(() => {
    proxy.close();
    upstream.server.close();
  });

  const got = await post(proxy.port, { path: "/responses" });

  assert.equal(got.status, 200, "the reset should not reach Grok");
  assert.equal(upstream.hitCount(), 2, "exactly one retry");
});
