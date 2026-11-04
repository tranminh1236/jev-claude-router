// Shared, idle-time-aged state for the proxy's conversations, sessions, sub-agents and
// manual overrides. The proxy runs as a long-lived daemon serving every window of every
// project, so state can no longer be capped by request count or evicted per-process: an
// entry must survive for as long as its conversation stays active, and age out only once
// it goes idle past `ttlMs`. Sweeping happens lazily on access rather than on a timer, so
// the daemon never holds the event loop open with an interval and can still exit cleanly
// on SIGTERM.
export function createProxyState({ ttlMs = 12 * 60 * 60 * 1000, max = 2000, now = Date.now } = {}) {
  // One Map per kind, each value carrying `lastSeen`; any read that counts as activity
  // touches it, which is what lets eviction order by idle time instead of insertion order.
  const conversations = new Map();
  const routed = new Map();
  const subagents = new Map();
  const manual = new Map();

  const sweep = (map) => {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of map) {
      if (entry.lastSeen < cutoff) map.delete(key);
      else break; // Map iterates in insertion order; re-inserting on touch keeps it idle-ordered.
    }
    while (map.size > max) map.delete(map.keys().next().value);
  };

  const touch = (map, key, makeValue) => {
    sweep(map);
    let entry = map.get(key);
    if (entry) {
      map.delete(key); // re-insert so insertion order tracks recency (LRU for the cap).
    } else {
      entry = makeValue();
    }
    entry.lastSeen = now();
    map.set(key, entry);
    return entry;
  };

  const has = (map, key) => {
    sweep(map);
    return map.has(key);
  };

  const mark = (map, key) => {
    touch(map, key, () => ({}));
  };

  return {
    // Tier routed for each conversation's turn in flight, reused by its follow-up requests
    // and by the cache-rebuild guard, which needs to know what the prompt cache was built
    // on. Aged out after the TTL instead of capped by count, so a daemon serving many
    // projects can't evict a conversation mid-turn.
    conversation(key) {
      return touch(conversations, key, () => ({ tier: null, cheapStreak: 0 }));
    },
    // Read-only existence check: does not create an entry and does not touch `lastSeen`.
    hasConversation(key) {
      return has(conversations, key);
    },
    forget(key) {
      conversations.delete(key);
    },
    // Sessions in which the sentinel has been seen, so a concrete model arriving later can
    // be told apart: inside one of these a brand-new conversation is a sub-agent Claude
    // Code spawned. Aged out after the TTL.
    isRouted(session) {
      return has(routed, session);
    },
    markRouted(session) {
      mark(routed, session);
    },
    // Conversation keys known to belong to a sub-agent, so their follow-up requests keep
    // the tier chosen for them without re-asking Jev, and never touch the main agent's
    // status line. Aged out after the TTL.
    isSubagent(key) {
      return has(subagents, key);
    },
    markSubagent(key) {
      mark(subagents, key);
    },
    // Conversation keys the user took over with /model. Kept apart from `conversations`,
    // which ages its entries out independently, because a choice the user made should
    // outlast the conversation's own entry until the TTL.
    isManual(key) {
      return has(manual, key);
    },
    markManual(key) {
      mark(manual, key);
    },
    size() {
      return conversations.size;
    },
  };
}
