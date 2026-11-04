import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeAtomic } from "./claude-settings.mjs";

/**
 * Appends one JSON-encoded row, as a single line, to `file`. Used for both `decision` and
 * `usage` rows (see src/proxy.mjs and src/usage.mjs) - several proxies may call this
 * concurrently, and appends under 4 KB are atomic on POSIX, so no locking is needed here.
 * Wrapped so a broken log (missing disk, unwritable directory) can never affect the request
 * that triggered it - the same "cosmetic, must never interfere" rule src/status.mjs follows.
 */
export function appendLine(file, row) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch {
    // A broken decision log must never take down the request it was describing.
  }
}

/**
 * Keeps only the newest `maxLines` lines of `file`, via write-temp-then-rename (writeAtomic).
 * Only the daemon calls this (src/proxy.mjs's `trimLog` option, wired from the daemon's own
 * startProxy call) - several proxies append to the same file concurrently, and a read-all/
 * rewrite trim from more than one of them would silently drop each other's appends, so there
 * is exactly one owner. A missing file is a no-op, not an error: there is nothing to trim yet.
 */
export function trimDecisionLog(file, maxLines = 20000) {
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    // A trailing empty string from the file's final newline is not a line to keep or drop.
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (lines.length <= maxLines) return;
    const kept = lines.slice(lines.length - maxLines);
    writeAtomic(file, `${kept.join("\n")}\n`);
  } catch {
    // Missing file: nothing to trim. Any other failure: leave the log as it is rather than
    // risk losing it.
  }
}

// Per-file call counters for maybeTrimDecisionLog, keyed by file path (a plain string - two
// different paths never collide, and the same path across process restarts just resumes
// counting from 0, which trimDecisionLog's own cap keeps safe either way).
const trimCallCounts = new Map();

/**
 * trimDecisionLog re-reads the whole decision log on every call, and rewrites it when over the
 * cap. The daemon calls it on every routed decision, which means re-reading a multi-megabyte
 * file on every single turn for the common case where it does nothing. This only actually calls
 * trimDecisionLog every `every`th time, bounding the log to approximately maxLines (overshooting
 * by up to `every - 1` lines between trims) in exchange for paying the read/rewrite cost rarely
 * instead of on the hot path of every request.
 */
export function maybeTrimDecisionLog(file, { maxLines = 20000, every = 500 } = {}) {
  const count = (trimCallCounts.get(file) ?? 0) + 1;
  trimCallCounts.set(file, count);
  if (count % every !== 0) return;
  trimDecisionLog(file, maxLines);
}
