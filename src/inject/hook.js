// src/inject/hook.js — manage ContextSpin's SessionStart hook in the user
// ~/.claude/settings.json. Used by `contextspin install` / `uninstall` (the curl
// flow) so ContextSpin self-heals every session without the plugin/marketplace.

import fs from "node:fs";
import path from "node:path";
import { CLAUDE_SETTINGS_PATH } from "../config.js";

/**
 * Read+parse a JSON file, returning a fallback on any read/parse error.
 * @param {string} filePath
 * @param {*} fallback
 * @returns {*}
 */
function readJsonSafeSync(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Build the SessionStart hook command, pinned to an EXACT version (never
 * `@latest` or a range) so a future release never runs without a deliberate
 * re-install. Runs from a neutral dir so npx can't resolve a confused local
 * package (Exit 127).
 * @param {string} version - The exact package version to pin (e.g. "0.6.3").
 * @returns {string}
 */
export function sessionStartHookCmd(version) {
  return `cd /tmp && npx --yes contextspin@${version} ensure >/dev/null 2>&1; exit 0`;
}

/**
 * Whether a SessionStart entry already runs ContextSpin (any version).
 * @param {*} entry
 * @returns {boolean}
 */
export function entryRunsContextspin(entry) {
  return !!(
    entry &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some(
      (h) => h && typeof h.command === "string" && h.command.includes("contextspin"),
    )
  );
}

/**
 * Upsert the ContextSpin SessionStart hook into the user settings, pinned to
 * `version`. JSON-merge (preserves every other key and any non-ours hooks).
 * Drops any prior ContextSpin entry (e.g. an older pinned version) so
 * re-installing a newer version re-pins cleanly. Idempotent when already current.
 * @param {string} version
 * @param {string} [settingsPath=CLAUDE_SETTINGS_PATH]
 * @returns {boolean} true if the file was changed (added or re-pinned).
 */
export function addSessionStartHook(version, settingsPath = CLAUDE_SETTINGS_PATH) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const settings = readJsonSafeSync(settingsPath, {});
  const obj = settings && typeof settings === "object" ? settings : {};
  obj.hooks = obj.hooks && typeof obj.hooks === "object" ? obj.hooks : {};
  const arr = Array.isArray(obj.hooks.SessionStart) ? obj.hooks.SessionStart : [];

  const desired = sessionStartHookCmd(version);
  const existing = arr.find(entryRunsContextspin);
  const alreadyCurrent =
    existing &&
    Array.isArray(existing.hooks) &&
    existing.hooks.some((h) => h && h.command === desired);
  if (alreadyCurrent) return false;

  const others = arr.filter((e) => !entryRunsContextspin(e));
  others.push({
    matcher: "",
    hooks: [{ type: "command", command: desired, timeout: 15 }],
  });
  obj.hooks.SessionStart = others;
  fs.writeFileSync(settingsPath, JSON.stringify(obj, null, 2));
  return true;
}

/**
 * Remove any ContextSpin SessionStart hook from the user settings (JSON-merge,
 * best-effort). Prunes empty containers.
 * @param {string} [settingsPath=CLAUDE_SETTINGS_PATH]
 * @returns {boolean} true if a hook was removed.
 */
export function removeSessionStartHook(settingsPath = CLAUDE_SETTINGS_PATH) {
  const settings = readJsonSafeSync(settingsPath, null);
  if (!settings || typeof settings !== "object" || !settings.hooks) return false;
  const arr = Array.isArray(settings.hooks.SessionStart)
    ? settings.hooks.SessionStart
    : [];
  const kept = arr.filter((e) => !entryRunsContextspin(e));
  if (kept.length === arr.length) return false;
  if (kept.length > 0) settings.hooks.SessionStart = kept;
  else delete settings.hooks.SessionStart;
  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return true;
}
