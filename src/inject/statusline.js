// src/inject/statusline.js — installs/uninstalls the Claude Code statusLine integration.
// Generates a self-contained render script (always exits 0, buffers stdin) and
// wires it into ~/.claude/settings.json under the camelCase `statusLine` key.
//
// NON-DESTRUCTIVE: if the user already has a statusLine command, we record it to
// PREV_STATUSLINE_PATH and the generated render script RUNS that prior command
// (piping Claude Code's stdin to it) and prints its output FIRST, then prints the
// ContextSpin snippet on its own line beneath. The user's statusline is composed
// with ours, never discarded.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  STATE_DIR,
  STATUSLINE_SH,
  STATUSLINE_JS,
  PREV_STATUSLINE_PATH,
  CACHE_PATH,
  CONFIG_PATH,
  CLAUDE_SETTINGS_PATH,
} from "../config.js";

/**
 * Build the source text of the Node ESM render script that Claude Code invokes
 * for each status-bar refresh.
 *
 * Runtime behavior of the generated script:
 *  - Reads and BUFFERS all of stdin (Claude Code pipes a JSON payload). We must
 *    consume it so the writer never gets EPIPE; we also feed it to a wrapped
 *    prior statusline command (below).
 *  - If PREV_STATUSLINE_PATH exists and names a command, spawns that command via
 *    the shell, writes the buffered stdin to ITS stdin, captures its stdout with
 *    a short timeout (killed on timeout), and prints that output VERBATIM first
 *    (it may be multiple lines). Any failure here is swallowed.
 *  - Reads the cache (tolerating a missing file).
 *  - Reads `cooldownAfterShown` from the config (fallback 3).
 *  - Selects snippets where shownCount < cooldownAfterShown, picks the one with
 *    the LOWEST shownCount then the most recent fetchedAt, bumps its shownCount,
 *    and writes the cache back atomically.
 *  - Prints that snippet's text on its OWN line beneath the prior output; prints
 *    nothing for the ContextSpin line if none eligible.
 *  - Wraps EVERYTHING so any error still exits 0 with whatever output succeeded
 *    (the prior statusline must never be lost and the bar must never break).
 *
 * The cache, config, and prev-statusline paths are baked into the script as
 * string literals so the generated file is fully self-contained with no imports
 * beyond node builtins.
 *
 * @param {string} cachePath - Absolute path to the snippet cache JSON file.
 * @param {string} configPath - Absolute path to the ContextSpin config JSON file.
 * @param {string} prevPath - Absolute path to the prev-statusline JSON file.
 * @returns {string} The ESM source of the render script.
 */
function buildRenderScript(cachePath, configPath, prevPath) {
  const CACHE = JSON.stringify(cachePath);
  const CONFIG = JSON.stringify(configPath);
  const PREV = JSON.stringify(prevPath);
  return `// contextspin statusline-render.js (generated) — composes any prior
// statusline with one ContextSpin snippet line. MUST always exit 0 and never
// lose the prior statusline's output, so the user's status bar never breaks.
import fs from "node:fs";
import { spawn } from "node:child_process";

const CACHE_PATH = ${CACHE};
const CONFIG_PATH = ${CONFIG};
const PREV_STATUSLINE_PATH = ${PREV};

/** Buffer ALL of stdin into a Buffer. Resolves on end/close/error/timeout. */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    };
    try {
      const stdin = process.stdin;
      stdin.on("error", () => finish());
      stdin.on("data", (chunk) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      );
      stdin.on("end", () => finish());
      stdin.on("close", () => finish());
      stdin.resume();
      // Safety timer: don't hang forever if no EOF arrives.
      setTimeout(finish, 250).unref?.();
    } catch {
      finish();
    }
  });
}

/**
 * Run the recorded prior statusline command, feeding it the buffered stdin, and
 * resolve with its captured stdout (string). Swallows every failure -> "".
 */
function runPrevStatusline(stdinBuf) {
  return new Promise((resolve) => {
    let prev;
    try {
      const raw = fs.readFileSync(PREV_STATUSLINE_PATH, "utf8");
      prev = JSON.parse(raw);
    } catch {
      resolve("");
      return;
    }
    const command = prev && typeof prev.command === "string" ? prev.command : "";
    if (!command) {
      resolve("");
      return;
    }
    let child;
    try {
      child = spawn(command, { shell: true });
    } catch {
      resolve("");
      return;
    }
    let out = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(out);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish();
    }, 2000);
    if (timer.unref) timer.unref();
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
    }
    if (child.stderr) child.stderr.on("data", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      finish();
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish();
    });
    try {
      if (child.stdin) {
        child.stdin.on("error", () => {});
        if (stdinBuf && stdinBuf.length) child.stdin.write(stdinBuf);
        child.stdin.end();
      }
    } catch {
      // ignore: prior command may not read stdin
    }
  });
}

/** Atomically replace a JSON file (write tmp then rename). The temp name is
// per-process so this render script and the daemon never share one .tmp and
// tear each other's cache writes. */
function writeJsonAtomic(filePath, data) {
  const tmp = filePath + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, filePath);
}

/** Compute the ContextSpin snippet line (may be ""); bumps shownCount. */
function contextSpinLine() {
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return "";
  }
  const snippets = Array.isArray(cache && cache.snippets) ? cache.snippets : [];
  if (snippets.length === 0) return "";

  // cooldownAfterShown from config (fallback 3).
  let cooldownAfterShown = 3;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const v = cfg && cfg.snippets && cfg.snippets.cooldownAfterShown;
    if (typeof v === "number" && Number.isFinite(v)) cooldownAfterShown = v;
  } catch {
    // keep fallback
  }

  const eligible = snippets.filter(
    (s) => s && typeof s.text === "string" && (s.shownCount || 0) < cooldownAfterShown
  );
  if (eligible.length === 0) return "";

  eligible.sort((a, b) => {
    const ca = a.shownCount || 0;
    const cb = b.shownCount || 0;
    if (ca !== cb) return ca - cb;
    const ta = Date.parse(a.fetchedAt || "") || 0;
    const tb = Date.parse(b.fetchedAt || "") || 0;
    return tb - ta;
  });
  const chosen = eligible[0];

  chosen.shownCount = (chosen.shownCount || 0) + 1;
  try {
    writeJsonAtomic(CACHE_PATH, cache);
  } catch {
    // If we cannot persist, still show the snippet this time.
  }

  return String(chosen.text).replace(/\\r?\\n/g, " ");
}

/** Write a string to stdout, awaiting the flush callback. */
function writeOut(text) {
  return new Promise((resolve) => {
    try {
      process.stdout.write(text, resolve);
    } catch {
      resolve();
    }
  });
}

async function main() {
  const stdinBuf = await readStdin();

  // (a) Prior statusline output FIRST (verbatim, possibly multi-line).
  let prevOut = "";
  try {
    prevOut = await runPrevStatusline(stdinBuf);
  } catch {
    prevOut = "";
  }

  // (b) ContextSpin snippet line.
  let line = "";
  try {
    line = contextSpinLine();
  } catch {
    line = "";
  }

  // (c) Compose: prior output, then our line on its own line beneath. We only
  // insert a separating newline when there is prior output that does not
  // already end in one, so a lone ContextSpin line stays a single clean line.
  let composed = prevOut;
  if (line) {
    if (composed && !composed.endsWith("\\n")) composed += "\\n";
    composed += line;
  }
  if (composed) await writeOut(composed);
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
 * @property {boolean} composed - Whether we wrapped an existing statusline
 *   (its output is composed above the ContextSpin line).
 * @property {string|null} warning - Human-readable warning, or null.
 */

/**
 * Install the ContextSpin statusline integration (NON-DESTRUCTIVE):
 *  - Writes the self-contained render script to STATUSLINE_JS.
 *  - Writes an executable bash wrapper to STATUSLINE_SH that execs the render
 *    script with stderr silenced.
 *  - If an existing statusLine command (other than ours) is present, RECORDS it
 *    to PREV_STATUSLINE_PATH (once — idempotent; never captures our own command)
 *    so the render script can run it and prepend its output. Also backs up
 *    settings.json to the .contextspin.bak once, as before.
 *  - Patches ~/.claude/settings.json so `statusLine` points at our wrapper, with
 *    `refreshInterval` in SECONDS (from config.injection.refresh).
 *
 * @param {object} config - Normalized ContextSpin config (uses injection.refresh).
 * @returns {Promise<InstallStatuslineResult>}
 */
export async function installStatusline(config) {
  await fsp.mkdir(STATE_DIR, { recursive: true });

  // (1) Patch Claude settings — first detect/record any existing statusline so
  // the generated render script can compose it. (We read settings before
  // writing the render script so a re-run never captures our own command.)
  await fsp.mkdir(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  const settings = await readJsonSafe(CLAUDE_SETTINGS_PATH, {});
  const settingsObj = settings && typeof settings === "object" ? settings : {};

  let backedUp = false;
  let composed = false;
  let warning = null;

  const existing = settingsObj.statusLine;
  if (
    existing &&
    typeof existing === "object" &&
    existing.command &&
    existing.command !== STATUSLINE_SH
  ) {
    // NON-DESTRUCTIVE: record the prior command so we run it and prepend its
    // output. We're inside the `existing.command !== STATUSLINE_SH` branch, so
    // this never records our own wrapper. Refresh the record if the prior
    // command changed out-of-band (otherwise a stale prior would keep running).
    let recordedPrev = null;
    try {
      recordedPrev = JSON.parse(fs.readFileSync(PREV_STATUSLINE_PATH, "utf8"));
    } catch {
      recordedPrev = null;
    }
    if (!recordedPrev || recordedPrev.command !== String(existing.command)) {
      await writeJsonAtomic(PREV_STATUSLINE_PATH, {
        command: String(existing.command),
        type: existing.type || "command",
      });
    }
    composed = true;

    const backupPath = CLAUDE_SETTINGS_PATH + ".contextspin.bak";
    if (!fs.existsSync(backupPath)) {
      await fsp.copyFile(CLAUDE_SETTINGS_PATH, backupPath);
      backedUp = true;
    }
    warning =
      `Existing statusLine command (\`${existing.command}\`) is preserved: ` +
      `ContextSpin runs it and shows its output above the ContextSpin line. ` +
      `A backup of your settings is at ${backupPath}. Run \`contextspin uninject\` to restore it.`;
  } else if (existing && typeof existing === "object" && existing.command === STATUSLINE_SH) {
    // Already ours: a prior command may have been recorded on a previous run.
    composed = fs.existsSync(PREV_STATUSLINE_PATH);
  }

  // (2) Render script (now knows the prev-statusline path).
  const renderSource = buildRenderScript(CACHE_PATH, CONFIG_PATH, PREV_STATUSLINE_PATH);
  await fsp.writeFile(STATUSLINE_JS, renderSource);

  // (3) Bash wrapper. Silence stderr so node warnings never reach the status bar.
  const shSource = `#!/usr/bin/env bash\nexec node ${JSON.stringify(STATUSLINE_JS)} 2>/dev/null\n`;
  await fsp.writeFile(STATUSLINE_SH, shSource);
  await fsp.chmod(STATUSLINE_SH, 0o755);

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
    composed,
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

/** Best-effort removal of the recorded prev-statusline file. */
async function removePrevStatusline() {
  try {
    await fsp.unlink(PREV_STATUSLINE_PATH);
  } catch {
    // best effort (may not exist)
  }
}

/**
 * Uninstall the ContextSpin statusline integration. If the current
 * `statusLine.command` is ours, restore the `.contextspin.bak` backup when
 * present (which brings back the prior command), otherwise just drop the
 * `statusLine` key. Always removes the recorded prev-statusline file.
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
      await removePrevStatusline();
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
  await removePrevStatusline();
  return {
    removed: true,
    restored: false,
    settingsPath: CLAUDE_SETTINGS_PATH,
    note: "Removed the ContextSpin statusLine entry.",
  };
}
