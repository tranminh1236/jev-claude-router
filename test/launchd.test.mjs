import test from "node:test";
import assert from "node:assert/strict";
import { plistFor, LABEL } from "../src/launchd.mjs";

const xml = plistFor({ node: "/opt/homebrew/bin/node", script: "/x/bin/jev-daemon.mjs", port: 61820, log: "/x/daemon.log" });

test("the agent runs the daemon in the foreground, at load, and keeps it alive", () => {
  assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>${LABEL}</string>`));
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.ok(xml.includes("<string>--foreground</string>"));
  assert.ok(xml.includes("<string>/opt/homebrew/bin/node</string>"));
});

test("launchd gets a near-empty environment, so the port travels in the plist", () => {
  // Anything exported from a shell profile is invisible to a launchd job: the key and the tier
  // overrides have to live in ~/.jev-router.env, and only the port is passed here.
  assert.match(xml, /<key>JEV_DAEMON_PORT<\/key>\s*<string>61820<\/string>/);
  assert.ok(!xml.includes("JEV_API_KEY"), "a key is never written into a plist");
});

test("both streams land in the daemon log", () => {
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/x\/daemon\.log<\/string>/);
});

test("paths with XML-significant characters are escaped", () => {
  const odd = plistFor({ node: "/x/n&d", script: "/x/<s>.mjs", port: 1, log: "/x/l" });
  assert.ok(odd.includes("/x/n&amp;d"));
  assert.ok(odd.includes("/x/&lt;s&gt;.mjs"));
});
