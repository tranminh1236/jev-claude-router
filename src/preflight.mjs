import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_PORT, probe, startDaemon } from "./daemon.mjs";
import { unpatchSettings, writeAtomic } from "./claude-settings.mjs";

// Real implementations by default so the CLI subcommand (which never passes `deps`) gets fully
// working behavior; a caller (this test file) overrides individual keys to exercise one branch
// at a time without touching an actual port or a real settings.json.
const DEFAULT_DEPS = { probe, startDaemon, unpatchSettings };

/**
 * Records which project a session belongs to, for Plan 2's dashboard to join against - not
 * read by `preflight` itself. Synchronous and self-contained (own read, own trim, own atomic
 * write) because the brief's own tests call it directly, without going through `preflight` at
 * all, to check the bounding and corruption-handling behavior in isolation.
 *
 * A map, not a list, trimmed from the front: insertion order in a plain object is already
 * "oldest first" for keys nothing has touched since, so dropping `Object.keys(map).length - max`
 * entries off the front is enough to keep the newest `max` sessions without a separate
 * timestamp field. Re-remembering an existing session id first deletes it so it moves to the
 * back, i.e. counts as freshly seen rather than ageing out at its original position.
 */
export function rememberSession({ file, sessionId, cwd, max = 200 }) {
  let map;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    map = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // Missing file (first session ever) and a corrupt one (a crash mid-write before this
    // module existed, or hand-editing) both mean "start over" - neither is worth failing a
    // hook over, per the brief's "replaced, not thrown over".
    map = {};
  }

  delete map[sessionId];
  map[sessionId] = cwd;

  const keys = Object.keys(map);
  if (keys.length > max) {
    for (const key of keys.slice(0, keys.length - max)) delete map[key];
  }

  // The directory may not exist yet (e.g. a fresh install whose daemon has never written
  // ~/.jev-router/anything) - writeAtomic has no reason to create it, since every other caller
  // of it writes alongside a file that's already there.
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(map, null, 2)}\n`);
}

/**
 * The SessionStart hook's entire job: make sure *some* daemon of ours is reachable before the
 * session's first request hits it, without ever being the reason a session fails to open.
 *
 * Three outcomes, cheapest first:
 *  - "healthy": the probe alone says a daemon of ours (or, harmlessly, someone else's server on
 *    the same port - not this hook's problem) is already up. One probe, no process spawn.
 *  - "revived": the probe says dead, `startDaemon` brings one up. This is the common case right
 *    after a reboot, before launchd's own keep-alive has had a chance to restart it.
 *  - "disarmed": `startDaemon` itself throws (port stolen by something else, a spawn that never
 *    came up). Nothing left to retry, so the settings patch comes back out - a session that
 *    starts against a dead proxy URL would otherwise hang or error on every single request,
 *    which is strictly worse than just running plain Claude Code for this and future sessions.
 *
 * The whole function is wrapped in one outer try/catch that resolves "healthy" on anything
 * unexpected: a hook is supposed to protect the session, so the one thing it must never do is
 * reject or throw and take the session down with it. Bookkeeping (`rememberSession`) gets its
 * own inner try/catch for the same reason, scoped narrowly enough that a bookkeeping failure
 * can't quietly turn a real "revived"/"disarmed" result into a misleading "healthy" one.
 */
export async function preflight({ input, port = DEFAULT_PORT, paths, deps = {} }) {
  const d = { ...DEFAULT_DEPS, ...deps };

  try {
    const sessionId = input?.session_id ?? null;
    const cwd = input?.cwd ?? null;
    const remember = () => {
      if (!sessionId) return;
      try {
        rememberSession({ file: paths.sessions, sessionId, cwd });
      } catch {
        // Nice-to-have for the dashboard, not a reason to change the outcome reported below.
      }
    };

    const state = await d.probe(port);
    if (state !== "dead") {
      remember();
      return { outcome: "healthy", notice: null };
    }

    try {
      await d.startDaemon({ port });
      remember();
      return { outcome: "revived", notice: null };
    } catch (err) {
      try {
        d.unpatchSettings({ file: paths.settings, bookkeeping: paths.bookkeeping });
      } catch {
        // Even if the settings file itself can't be touched (unwritable, already gone), the
        // notice below is still the right thing to surface - the daemon is dead either way.
      }
      return {
        outcome: "disarmed",
        notice: `jev-router: daemon would not start (${err.message}); routing is off until \`jev-daemon install\` is re-run`,
      };
    }
  } catch {
    return { outcome: "healthy", notice: null };
  }
}
