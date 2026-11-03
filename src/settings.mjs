import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTO_MODEL } from "./config.mjs";

export const USER_SETTINGS = join(homedir(), ".claude", "settings.json");

/**
 * Every listener this project runs binds 127.0.0.1 exclusively, so that one literal hostname
 * is sufficient to detect a daemon-resolvable base URL.
 */
function isLoopback(baseURL) {
  try {
    return new URL(baseURL).hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * The model saved as the user's default, ignoring a sentinel left behind by a session that
 * did not exit cleanly, which is not a preference worth restoring.
 */
export function readSavedModel(file = USER_SETTINGS) {
  try {
    const model = JSON.parse(readFileSync(file, "utf8")).model;
    return model === AUTO_MODEL ? undefined : model;
  } catch {
    return undefined;
  }
}

/**
 * Puts `previous` back if the settings file now holds the sentinel. Selecting a row with
 * Enter makes Claude Code save it as the default for new sessions, and a saved "jev-auto"
 * would break plain `claude`, which has no proxy to resolve it. Anything other than an exact
 * sentinel match is left alone, so a real model chosen during the session survives. This
 * function exists because plain `claude` cannot resolve "jev-auto" on its own; once the daemon
 * is installed and listening on a loopback port, it can, so the restore is skipped and the
 * sentinel is left in place as a preference the user set in the extension, not debris.
 */
export function restoreSavedModel(previous, file = USER_SETTINGS) {
  try {
    const settings = JSON.parse(readFileSync(file, "utf8"));
    if (settings.model !== AUTO_MODEL) return false;
    if (isLoopback(settings.env?.ANTHROPIC_BASE_URL)) return false;
    if (previous === undefined) delete settings.model;
    else settings.model = previous;
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
