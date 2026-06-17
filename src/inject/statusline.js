// src/inject/statusline.js — installs/uninstalls the Claude Code statusLine integration.
// Generates a self-contained render script (always exits 0, reads+discards stdin)
// and wires it into ~/.claude/settings.json under the camelCase `statusLine` key.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  STATE_DIR,
  STATUSLINE_SH,
  STATUSLINE_JS,
  CACHE_PATH,
  CONFIG_PATH,
  CLAUDE_SETTINGS_PATH,
} from "../config.js";

/**
 * Build the source text of the Node ESM render script that Claude Code invokes
 * for each status-bar refresh.
 *
 * Runtime behavior of the generated script:
 *  - Reads and DISCARDS all of stdin (Claude Code pipes a JSON payload; we never
 *    use it, but we must drain it so the writer never gets EPIPE).
 *  - Reads the cache (tolerating a missing file -> exit 0 silently).
 *  - Reads `cooldownAfterShown` from the config (fallback 3).
 *  - Selects snippets where shownCount < cooldownAfterShown, picks the one with
 *    the LOWEST shownCount then the most recent fetchedAt, bumps its shownCount,
 *    and writes the cache back atomically.
 *  - Prints that snippet's text on a single line; prints nothing if none eligible.
 *  - Wraps EVERYTHING so any error still exits 0 with no output (never breaks the
 *    user's status bar).
 *
 * The cache and config paths are baked into the script as string literals so the
 * generated file is fully self-contained and has no import dependencies.
 *
 * @param {string} cachePath - Absolute path to the snippet cache JSON file.
 * @param {string} configPath - Absolute path to the ContextSpin config JSON file.
 * @returns {string} The ESM source of the render script.
 */
function buildRenderScript(cachePath, configPath) {
  const CACHE = JSON.stringify(cachePath);
  const CONFIG = JSON.stringify(configPath);
  return `// contextspin statusline-render.js (generated) — prints one context snippet.
// MUST always exit 0 and print nothing on error so the status bar never breaks.
import fs from "node:fs";

const CACHE_PATH = ${CACHE};
const CONFIG_PATH = ${CONFIG};

/** Drain and discard stdin so Claude Code's JSON pipe never gets EPIPE. */
function drainStdin() {
  return new Promise((resolve) => {
    try {
      const stdin = process.stdin;
      stdin.on("error", () => {});
      stdin.on("data", () => {});
      stdin.on("end", () => resolve());
      stdin.on("close", () => resolve());
      stdin.resume();
      // Safety timer: don't hang forever if no EOF arrives.
      setTimeout(resolve, 250).unref?.();
    } catch {
      resolve();
    }
  });
}

/** Atomically replace a JSON file (write tmp then rename). */
function writeJsonAtomic(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, filePath);
}

async function main() {
  await drainStdin();

  // Missing cache -> nothing to show.
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return; // no output
  }
  const snippets = Array.isArray(cache && cache.snippets) ? cache.snippets : [];
  if (snippets.length === 0) return;

  // cooldownAfterShown from config (fallback 3).
  let cooldownAfterShown = 3;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const v = cfg && cfg.snippets && cfg.snippets.cooldownAfterShown;
    if (typeof v === "number" && Number.isFinite(v)) cooldownAfterShown = v;
  } catch {
    // keep fallback
  }

  // Eligible: shownCount < cooldownAfterShown.
  const eligible = snippets.filter(
    (s) => s && typeof s.text === "string" && (s.shownCount || 0) < cooldownAfterShown
  );
  if (eligible.length === 0) return;

  // Pick lowest shownCount, then most recent fetchedAt.
  eligible.sort((a, b) => {
    const ca = a.shownCount || 0;
    const cb = b.shownCount || 0;
    if (ca !== cb) return ca - cb;
    const ta = Date.parse(a.fetchedAt || "") || 0;
    const tb = Date.parse(b.fetchedAt || "") || 0;
    return tb - ta;
  });
  const chosen = eligible[0];

  // Bump shownCount on the chosen snippet within the original array and persist.
  chosen.shownCount = (chosen.shownCount || 0) + 1;
  try {
    writeJsonAtomic(CACHE_PATH, cache);
  } catch {
    // If we cannot persist, still show the snippet this time.
  }

  // Single line of output. Await the write callback so the bytes are flushed to
  // the pipe before process.exit (which does not wait for async stdout writes).
  await new Promise((resolve) => {
    process.stdout.write(String(chosen.text).replace(/\\r?\\n/g, " "), resolve);
  });
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
`;
}

/**
 * Read a JSON file, returning a fallback value on any read/parse error.
 * @param {string} filePath
 * @param {*} fallback
 * @returns {Promise<*>}
 */
async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Atomically write a pretty-printed JSON file (write tmp then rename).
 * @param {string} filePath
 * @param {*} data
 * @returns {Promise<void>}
 */
async function writeJsonAtomic(filePath, data) {
  const tmp = filePath + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, filePath);
}

/**
 * @typedef {Object} InstallStatuslineResult
 * @property {string} statuslineSh - Path to the generated bash wrapper.
 * @property {string} statuslineJs - Path to the generated Node render script.
 * @property {string} settingsPath - Path to the patched Claude settings file.
 * @property {boolean} backedUp - Whether an existing statusLine was backed up.
 * @property {string|null} warning - Human-readable warning, or null.
 */

/**
 * Install the ContextSpin statusline integration:
 *  - Writes the self-contained render script to STATUSLINE_JS.
 *  - Writes an executable bash wrapper to STATUSLINE_SH that execs the render
 *    script with stderr silenced.
 *  - Patches ~/.claude/settings.json so `statusLine` points at our wrapper, with
 *    `refreshInterval` in SECONDS (from config.injection.refresh). If an existing
 *    statusLine command (other than ours) is present, it is backed up once.
 *
 * @param {object} config - Normalized ContextSpin config (uses injection.refresh).
 * @returns {Promise<InstallStatuslineResult>}
 */
export async function installStatusline(config) {
  await fsp.mkdir(STATE_DIR, { recursive: true });

  // (1) Render script.
  const renderSource = buildRenderScript(CACHE_PATH, CONFIG_PATH);
  await fsp.writeFile(STATUSLINE_JS, renderSource);

  // (2) Bash wrapper. Silence stderr so node warnings never reach the status bar.
  const shSource = `#!/usr/bin/env bash\nexec node ${JSON.stringify(STATUSLINE_JS)} 2>/dev/null\n`;
  await fsp.writeFile(STATUSLINE_SH, shSource);
  await fsp.chmod(STATUSLINE_SH, 0o755);

  // (3) Patch Claude settings.
  await fsp.mkdir(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  const settings = await readJsonSafe(CLAUDE_SETTINGS_PATH, {});
  const settingsObj = settings && typeof settings === "object" ? settings : {};

  let backedUp = false;
  let warning = null;

  const existing = settingsObj.statusLine;
  if (
    existing &&
    typeof existing === "object" &&
    existing.command &&
    existing.command !== STATUSLINE_SH
  ) {
    const backupPath = CLAUDE_SETTINGS_PATH + ".contextspin.bak";
    if (!fs.existsSync(backupPath)) {
      await fsp.copyFile(CLAUDE_SETTINGS_PATH, backupPath);
      backedUp = true;
    }
    warning =
      `Existing statusLine command was overwritten (\`${existing.command}\`). ` +
      `A backup of your settings is at ${backupPath}. Run \`contextspin uninject\` to restore it.`;
  }

  const refresh =
    config && config.injection && typeof config.injection.refresh === "number"
      ? config.injection.refresh
      : 30;

  settingsObj.statusLine = {
    type: "command",
    command: STATUSLINE_SH,
    padding: 0,
    refreshInterval: refresh, // SECONDS
  };

  await writeJsonAtomic(CLAUDE_SETTINGS_PATH, settingsObj);

  return {
    statuslineSh: STATUSLINE_SH,
    statuslineJs: STATUSLINE_JS,
    settingsPath: CLAUDE_SETTINGS_PATH,
    backedUp,
    warning,
  };
}

/**
 * @typedef {Object} UninstallStatuslineResult
 * @property {boolean} removed - Whether our statusLine entry was removed.
 * @property {boolean} restored - Whether settings were restored from backup.
 * @property {string} settingsPath - Path to the Claude settings file.
 * @property {string|null} note - Human-readable note, or null.
 */

/**
 * Uninstall the ContextSpin statusline integration. If the current
 * `statusLine.command` is ours, restore the `.contextspin.bak` backup when
 * present, otherwise just drop the `statusLine` key.
 *
 * @returns {Promise<UninstallStatuslineResult>}
 */
export async function uninstallStatusline() {
  const settings = await readJsonSafe(CLAUDE_SETTINGS_PATH, null);
  if (!settings || typeof settings !== "object") {
    return {
      removed: false,
      restored: false,
      settingsPath: CLAUDE_SETTINGS_PATH,
      note: "No Claude settings file found; nothing to uninstall.",
    };
  }

  const current = settings.statusLine;
  const isOurs =
    current && typeof current === "object" && current.command === STATUSLINE_SH;

  if (!isOurs) {
    return {
      removed: false,
      restored: false,
      settingsPath: CLAUDE_SETTINGS_PATH,
      note: "statusLine is not managed by ContextSpin; left unchanged.",
    };
  }

  const backupPath = CLAUDE_SETTINGS_PATH + ".contextspin.bak";
  if (fs.existsSync(backupPath)) {
    const backup = await readJsonSafe(backupPath, null);
    if (backup && typeof backup === "object") {
      await writeJsonAtomic(CLAUDE_SETTINGS_PATH, backup);
      try {
        await fsp.unlink(backupPath);
      } catch {
        // best effort
      }
      return {
        removed: true,
        restored: true,
        settingsPath: CLAUDE_SETTINGS_PATH,
        note: "Restored previous Claude settings from backup.",
      };
    }
  }

  delete settings.statusLine;
  await writeJsonAtomic(CLAUDE_SETTINGS_PATH, settings);
  return {
    removed: true,
    restored: false,
    settingsPath: CLAUDE_SETTINGS_PATH,
    note: "Removed the ContextSpin statusLine entry.",
  };
}
