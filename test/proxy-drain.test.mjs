import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../src/proxy.mjs";
import { probe } from "../src/daemon.mjs";

// An upstream that streams its answer in two halves, `gapMs` apart: long enough to start
// stopping the proxy in between, the way a restart lands in the middle of a model's reply.
async function slowUpstream(gapMs) {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("first-half\n");
    setTimeout(() => res.end("second-half\n"), gapMs);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

// One request through the proxy. `firstChunk` settles once the reply has started streaming;
// `body` settles with whatever arrived and whether the reply arrived whole.
function stream(port) {
  let started;
  const firstChunk = new Promise((resolve) => (started = resolve));
  const body = new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/other", agent: false },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
          started();
        });
        res.on("error", () => {});
        res.on("close", () => resolve({ text, complete: res.complete }));
      },
    );
    req.on("error", () => resolve({ text: "", complete: false }));
    req.end("{}");
  });
  return { firstChunk, body };
}

test("stopping the proxy lets a reply already streaming finish, and takes no new requests", async (t) => {
  const upstream = await slowUpstream(400);
  t.after(upstream.close);
  const proxy = await startProxy({ port: 0, upstream: upstream.origin });
  const inFlight = stream(proxy.port);
  await inFlight.firstChunk;

  const stopped = proxy.shutdown({ timeoutMs: 5000 });
  assert.equal(await probe(proxy.port), "dead", "a stopping proxy must refuse new connections");

  const got = await inFlight.body;
  assert.equal(got.complete, true, "the reply in flight was cut");
  assert.equal(got.text, "first-half\nsecond-half\n");
  assert.deepEqual(await stopped, { cut: 0 });
});

test("a reply still streaming when the drain window closes is cut, and counted", async (t) => {
  const upstream = await slowUpstream(3000);
  t.after(upstream.close);
  const proxy = await startProxy({ port: 0, upstream: upstream.origin });
  const inFlight = stream(proxy.port);
  await inFlight.firstChunk;

  const started = Date.now();
  const result = await proxy.shutdown({ timeoutMs: 200 });
  assert.deepEqual(result, { cut: 1 });
  assert.ok(Date.now() - started < 2000, "the drain window is a ceiling, not a wait for the upstream");
  assert.equal((await inFlight.body).complete, false);
});

test("stopping an idle proxy does not wait out the drain window", async () => {
  const proxy = await startProxy({ port: 0 });
  const started = Date.now();
  assert.deepEqual(await proxy.shutdown({ timeoutMs: 5000 }), { cut: 0 });
  assert.ok(Date.now() - started < 1000);
});
