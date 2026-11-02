import test from "node:test";
import assert from "node:assert/strict";
import { createProxyState } from "../src/proxy-state.mjs";

const clock = (start = 0) => { let t = start; return { now: () => t, advance: (ms) => (t += ms) }; };

test("an entry survives any number of turns while it stays active", () => {
  const c = clock();
  const state = createProxyState({ ttlMs: 1000, now: c.now });
  state.conversation("a").tier = "opus";
  for (let i = 0; i < 10; i++) { c.advance(900); assert.equal(state.conversation("a").tier, "opus"); }
});

test("an idle entry is dropped once it passes the TTL", () => {
  const c = clock();
  const state = createProxyState({ ttlMs: 1000, now: c.now });
  state.conversation("a").tier = "opus";
  c.advance(1001);
  assert.equal(state.conversation("a").tier, null);
});

test("past the hard cap the least recently seen goes first, not the active one", () => {
  // The daemon serves every window of every project. The old count-50 cap evicted mid-turn,
  // which made a follow-up request fall back to sonnet and rewrite the model mid-task.
  const c = clock();
  const state = createProxyState({ ttlMs: 1e9, max: 2, now: c.now });
  state.conversation("a").tier = "opus";
  c.advance(1); state.conversation("b").tier = "haiku";
  c.advance(1); state.conversation("a");           // a is now the most recent
  c.advance(1); state.conversation("c").tier = "fable";
  assert.equal(state.conversation("a").tier, "opus");
  assert.equal(state.conversation("b").tier, null);
});

test("session, sub-agent and manual marks age the same way and do not grow without bound", () => {
  const c = clock();
  const state = createProxyState({ ttlMs: 1000, now: c.now });
  state.markRouted("s1"); state.markSubagent("k1"); state.markManual("k2");
  assert.deepEqual([state.isRouted("s1"), state.isSubagent("k1"), state.isManual("k2")], [true, true, true]);
  c.advance(1001);
  assert.deepEqual([state.isRouted("s1"), state.isSubagent("k1"), state.isManual("k2")], [false, false, false]);
});
