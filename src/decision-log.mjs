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
