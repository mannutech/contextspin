// src/inject/statusline.js — installs/uninstalls the Claude Code statusLine integration.
// Generates a self-contained render script (always exits 0, buffers stdin) and
// wires it into a Claude Code settings file under the camelCase `statusLine` key.
//
// SCOPE-AWARE + NON-DESTRUCTIVE:
//
//  - User scope (no project dir): we patch the user ~/.claude/settings.json.
//  - Project scope (a projectDir is known, e.g. CLAUDE_PROJECT_DIR in a hook):
//    we patch <projectDir>/.claude/settings.local.json. That file is gitignored
//    and OUTRANKS the project's tracked .claude/settings.json — so a repo that
//    ships its own statusLine in settings.json no longer SHADOWS ContextSpin.
//
//  - In either scope, if a statusLine command (other than ours) is currently
//    effective, we record it in a PREV map (keyed by the absolute project dir,
//    with "" reserved for the user scope) and the generated render script RUNS
//    that prior command (piping Claude Code's stdin to it) and prints its output
//    FIRST, then prints the ContextSpin snippet line on its own line beneath. The
//    prior statusline is composed with ours, never discarded.
//
//  - The render script picks the prior PER PROJECT at render time: it parses the
//    stdin payload for the project dir and looks the prior command up in the PREV
//    map by that dir, falling back to the user ("") entry.

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
  DEFAULT_SNIPPETS,
  WIRED_STATUSLINES_PATH,
  REFRESH_LOCK_PATH,
  REFRESH_LOCK_TTL_MS,
  DEFAULT_DAEMONLESS,
} from "../config.js";
import { fileURLToPath } from "node:url";

/**
 * Build the source text of the Node ESM render script that Claude Code invokes
 * for each status-bar refresh.
 *
 * Runtime behavior of the generated script:
 *  - Reads and BUFFERS all of stdin (Claude Code pipes a JSON payload). We must
 *    consume it so the writer never gets EPIPE; we also feed it to a wrapped
 *    prior statusline command (below).
 *  - Tolerantly JSON-parses the buffered stdin to find the project dir (trying
 *    workspace.project_dir, then workspace.current_dir, then cwd), then looks up
 *    the prior command in the PREV map by that dir, falling back to the user ("")
 *    entry. If a prior command is found, it spawns that command via the shell,
 *    writes the buffered stdin to ITS stdin, captures its stdout with a 2000ms
 *    timeout (SIGKILL on timeout), and prints that output VERBATIM first (it may
 *    be multiple lines). Any failure here is swallowed.
 *  - Reads the cache (tolerating a missing file).
 *  - Reads `cooldownAfterShown` from the config (fallback 5).
 *  - Selects snippets where shownCount < cooldownAfterShown, picks the one with
 *    the LOWEST shownCount then the most recent fetchedAt, bumps its shownCount,
 *    and writes the cache back atomically.
 *  - Prints that snippet's text on its OWN line beneath the prior output; prints
 *    nothing for the ContextSpin line if none eligible.
 *  - Wraps EVERYTHING so any error still exits 0 with whatever output succeeded
 *    (the prior statusline must never be lost and the bar must never break).
 *
 * The cache, config, and prev-statusline-map paths are baked into the script as
 * string literals so the generated file is fully self-contained with no imports
 * beyond node builtins.
 *
 * @param {string} cachePath - Absolute path to the snippet cache JSON file.
 * @param {string} configPath - Absolute path to the ContextSpin config JSON file.
 * @param {string} prevPath - Absolute path to the prev-statusline MAP JSON file.
 * @returns {string} The ESM source of the render script.
 */
function buildRenderScript(cachePath, configPath, prevPath, opts = {}) {
  const CACHE = JSON.stringify(cachePath);
  const CONFIG = JSON.stringify(configPath);
  const PREV = JSON.stringify(prevPath);
  const DEFAULTS = JSON.stringify(DEFAULT_SNIPPETS);
  const DAEMONLESS = opts.daemonless ? "true" : "false";
  const REFRESH_ENTRY = JSON.stringify(opts.refreshEntry || "");
  const LOCK = JSON.stringify(opts.lockPath || "");
  const LOCK_TTL = String(typeof opts.lockTtlMs === "number" ? opts.lockTtlMs : 60000);
  return `// contextspin statusline-render.mjs (generated) — composes any prior
// statusline (looked up per-project) with one ContextSpin snippet line. MUST
// always exit 0 and never lose the prior statusline's output, so the user's
// status bar never breaks.
import fs from "node:fs";
import { spawn } from "node:child_process";

const CACHE_PATH = ${CACHE};
const CONFIG_PATH = ${CONFIG};
const PREV_STATUSLINE_PATH = ${PREV};
const DEFAULT_SNIPPETS = ${DEFAULTS};

// DAEMONLESS engine: when true, this render does stale-while-revalidate — it
// serves the cached snippet instantly and triggers a detached one-shot refresh
// when a source is due (lock-guarded so frequent renders never overlap).
const DAEMONLESS = ${DAEMONLESS};
const REFRESH_ENTRY = ${REFRESH_ENTRY};
const REFRESH_LOCK_PATH = ${LOCK};
const REFRESH_LOCK_TTL_MS = ${LOCK_TTL};

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
 * Tolerantly parse the buffered stdin payload for the project dir. Tries
 * workspace.project_dir, then workspace.current_dir, then cwd. Returns "" on any
 * failure (which falls back to the user-scope prev entry).
 */
function projectDirFromStdin(stdinBuf) {
  try {
    const payload = JSON.parse(stdinBuf.toString("utf8"));
    const ws = payload && typeof payload.workspace === "object" ? payload.workspace : {};
    const dir =
      (ws && ws.project_dir) ||
      (ws && ws.current_dir) ||
      (payload && payload.cwd) ||
      "";
    return typeof dir === "string" ? dir : "";
  } catch {
    return "";
  }
}

/**
 * Read the prev-statusline MAP (keyed by absolute project dir, with "" for the
 * user scope). Tolerates a missing/old file. An OLD single-object file (one with
 * a top-level \`command\` field) is migrated in-memory to the "" (user) entry.
 * Returns an object map (possibly empty); never throws.
 */
function readPrevMap() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(PREV_STATUSLINE_PATH, "utf8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object") return {};
  // Migrate an old single-object record to the user ("") entry.
  if (typeof raw.command === "string") {
    return { "": { command: raw.command, type: raw.type || "command" } };
  }
  return raw;
}

/**
 * Resolve the prior statusline command for a given project dir from the map,
 * falling back to the user ("") entry. Returns "" when none is recorded.
 */
function priorCommandFor(projectDir) {
  const map = readPrevMap();
  // Try the raw dir, then its realpath (the install side keys by realpath, so a
  // symlinked root still matches), then fall back to the user ("") entry.
  const candidates = [];
  if (projectDir) {
    candidates.push(projectDir);
    try { candidates.push(fs.realpathSync(projectDir)); } catch {}
  }
  candidates.push("");
  for (const k of candidates) {
    const entry = map[k];
    if (entry && typeof entry === "object" && typeof entry.command === "string") {
      return entry.command;
    }
  }
  return "";
}

/**
 * Run the recorded prior statusline command, feeding it the buffered stdin, and
 * resolve with its captured stdout (string). Swallows every failure -> "".
 */
function runPrevStatusline(command, stdinBuf) {
  return new Promise((resolve) => {
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

/**
 * Pick a rotating built-in default snippet text. NEVER exhausts (defaults are
 * always available) — this is the guarantee that the status bar is never empty.
 * Persists a rotating index back into the cache object (caller writes it).
 */
function defaultLine(cache) {
  if (!Array.isArray(DEFAULT_SNIPPETS) || DEFAULT_SNIPPETS.length === 0) return "";
  const n = DEFAULT_SNIPPETS.length;
  const idx = Number.isInteger(cache && cache._defaultIndex) ? cache._defaultIndex : 0;
  const text = DEFAULT_SNIPPETS[((idx % n) + n) % n];
  if (cache && typeof cache === "object") {
    cache._defaultIndex = (idx + 1) % n;
    try {
      writeJsonAtomic(CACHE_PATH, cache);
    } catch {
      // best effort — still show the default this render
    }
  }
  return String(text).replace(/\\r?\\n/g, " ");
}

/**
 * Compute the ContextSpin snippet line. ALWAYS returns a non-empty string: a
 * live snippet when one is eligible, otherwise a rotating built-in default so the
 * status bar is never blank.
 */
function contextSpinLine() {
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    cache = {};
  }
  if (!cache || typeof cache !== "object") cache = {};
  const snippets = Array.isArray(cache.snippets) ? cache.snippets : [];

  // cooldownAfterShown from config (fallback 5).
  let cooldownAfterShown = 5;
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
  // No live snippet to show -> fall back to a rotating built-in default.
  if (eligible.length === 0) return defaultLine(cache);

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

/**
 * Wrap the ContextSpin line in a compact, "boxed" ANSI style — bright italic
 * text between cyan bars — so it stands out from the prior statusline. Honors
 * \`injection.style: false\` in the config to opt out (plain text). Any error
 * falls back to the plain text.
 */
function styleLine(text) {
  if (!text) return text;
  let enabled = true;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (cfg && cfg.injection && cfg.injection.style === false) enabled = false;
  } catch {
    // keep enabled
  }
  if (!enabled) return text;
  const BAR = "\\x1b[36m"; // cyan
  const BODY = "\\x1b[3;96m"; // italic + bright cyan
  const RESET = "\\x1b[0m";
  return BAR + "┃" + RESET + " " + BODY + text + RESET + " " + BAR + "┃" + RESET;
}

/**
 * DAEMONLESS stale-while-revalidate: if any source is past its cooldown and no
 * fresh refresh is in flight, spawn a detached one-shot refresh. Never blocks
 * the render (fire-and-forget) and never throws.
 */
function maybeTriggerRefresh() {
  if (!DAEMONLESS || !REFRESH_ENTRY) return;
  try {
    // Is any source due? (sourceId is the source's index in the config.)
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch {
      return;
    }
    const sources = Array.isArray(cfg && cfg.sources) ? cfg.sources : [];
    if (sources.length === 0) return;

    let lastRun = {};
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
      if (c && c.meta && typeof c.meta.lastRun === "object") lastRun = c.meta.lastRun;
    } catch {
      // no cache yet -> everything is due
    }

    const now = Date.now();
    let due = false;
    for (let i = 0; i < sources.length; i++) {
      const cd = (typeof sources[i].cooldown === "number" ? sources[i].cooldown : 300) * 1000;
      if (now - (lastRun[i] || 0) >= cd) {
        due = true;
        break;
      }
    }
    if (!due) return;

    // Skip if a fresh refresh is already in flight.
    try {
      const t = Number(fs.readFileSync(REFRESH_LOCK_PATH, "utf8"));
      if (Number.isFinite(t) && now - t < REFRESH_LOCK_TTL_MS) return;
    } catch {
      // no/!readable lock -> proceed
    }

    const child = spawn(process.execPath, [REFRESH_ENTRY], {
      detached: true,
      stdio: "ignore",
      env: Object.assign({}, process.env, {
        CONTEXTSPIN_CONFIG: CONFIG_PATH,
        CONTEXTSPIN_CACHE: CACHE_PATH,
      }),
    });
    child.unref();
  } catch {
    // never let revalidation break the render
  }
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

  // (a) Prior statusline output FIRST (verbatim, possibly multi-line), looked up
  // per-project from the PREV map.
  let prevOut = "";
  try {
    const projectDir = projectDirFromStdin(stdinBuf);
    const command = priorCommandFor(projectDir);
    prevOut = await runPrevStatusline(command, stdinBuf);
  } catch {
    prevOut = "";
  }

  // (b) ContextSpin snippet line (always non-empty; styled).
  let line = "";
  try {
    line = styleLine(contextSpinLine());
  } catch {
    line = "";
  }

  // (b2) DAEMONLESS: kick off a background refresh if anything is due. Detached
  // and non-blocking — the line above is served immediately from cache.
  try {
    maybeTriggerRefresh();
  } catch {
    // ignore
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
 * Synchronous JSON read returning a fallback on any read/parse error.
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
 * Read the prev-statusline MAP from disk: an object keyed by absolute project
 * dir (with "" reserved for the user scope), each value { command, type }.
 *
 * Tolerates a missing/unparseable file (-> {}). Migrates an OLD single-object
 * file (one with a top-level `command` field) by treating it as the "" (user)
 * entry. Never throws.
 *
 * @returns {Record<string, {command: string, type: string}>}
 */
function readPrevMap() {
  const raw = readJsonSafeSync(PREV_STATUSLINE_PATH, null);
  if (!raw || typeof raw !== "object") return {};
  // Migrate an old single-object record to the user ("") entry.
  if (typeof raw.command === "string") {
    return { "": { command: raw.command, type: raw.type || "command" } };
  }
  return raw;
}

/**
 * Persist the prev-statusline MAP atomically.
 * @param {Record<string, {command: string, type: string}>} map
 * @returns {Promise<void>}
 */
async function writePrevMap(map) {
  await writeJsonAtomic(PREV_STATUSLINE_PATH, map);
}

/**
 * Read the wired-statuslines registry: an array of scope KEYS ("" for user
 * scope, else an absolute project dir). Tolerates a missing/bad file (-> []).
 * @returns {string[]}
 */
function readWiredList() {
  const raw = readJsonSafeSync(WIRED_STATUSLINES_PATH, null);
  return Array.isArray(raw) ? raw.filter((k) => typeof k === "string") : [];
}

/**
 * Record a scope KEY in the wired-statuslines registry (idempotent).
 * @param {string} key - "" for user scope, else an absolute project dir.
 * @returns {Promise<void>}
 */
async function addWired(key) {
  const list = readWiredList();
  if (!list.includes(key)) {
    list.push(key);
    await writeJsonAtomic(WIRED_STATUSLINES_PATH, list);
  }
}

/**
 * Resolve the statusLine command currently configured in a settings file (if
 * any), ignoring our own wrapper. Returns null when the file has no usable
 * non-ours statusLine command.
 *
 * @param {string} settingsPath
 * @returns {{command: string, type: string}|null}
 */
function priorFromSettings(settingsPath) {
  const settings = readJsonSafeSync(settingsPath, null);
  const sl = settings && typeof settings === "object" ? settings.statusLine : null;
  if (
    sl &&
    typeof sl === "object" &&
    typeof sl.command === "string" &&
    sl.command &&
    sl.command !== STATUSLINE_SH
  ) {
    return { command: sl.command, type: sl.type || "command" };
  }
  return null;
}

/**
 * @typedef {Object} InstallStatuslineResult
 * @property {string} statuslineSh - Path to the generated bash wrapper.
 * @property {string} statuslineJs - Path to the generated Node render script.
 * @property {string} settingsPath - Path to the patched Claude settings file.
 * @property {"project"|"user"} scope - Whether we wrote project or user settings.
 * @property {boolean} backedUp - Whether an existing statusLine was backed up.
 * @property {boolean} composed - Whether we wrapped an existing statusline
 *   (its output is composed above the ContextSpin line).
 * @property {string|null} warning - Human-readable warning, or null.
 */

/**
 * Install the ContextSpin statusline integration (SCOPE-AWARE, NON-DESTRUCTIVE).
 *
 * TARGET settings file + PREV map KEY:
 *  - If opts.projectDir is set: TARGET = <projectDir>/.claude/settings.local.json
 *    (gitignored, outranks the tracked settings.json); KEY = the resolved
 *    absolute projectDir.
 *  - Else: TARGET = the user ~/.claude/settings.json; KEY = "" (user scope).
 *
 * PRIOR detection (the statusline currently effective and NOT ours, to compose):
 *  - If projectDir set: the project's tracked .claude/settings.json statusLine if
 *    present and not ours; else the user settings.json statusLine if not ours;
 *    else none.
 *  - Else: the user settings.json statusLine if present and not ours; else none.
 * We never treat our own STATUSLINE_SH as a prior, and record the detected prior
 * into the PREV map under KEY (refreshing it if it differs).
 *
 * @param {object} config - Normalized ContextSpin config (uses injection.refresh).
 * @param {{ projectDir?: string }} [opts]
 * @returns {Promise<InstallStatuslineResult>}
 */
export async function installStatusline(config, opts = {}) {
  await fsp.mkdir(STATE_DIR, { recursive: true });

  // Canonicalize with realpath so the PREV-map key matches whatever the render
  // script derives from Claude Code's stdin (symlinked roots like macOS /var vs
  // /private/var would otherwise diverge). Fall back to path.resolve if realpath
  // throws (e.g. the dir does not exist yet).
  let projectDir = null;
  if (opts && typeof opts.projectDir === "string" && opts.projectDir) {
    try {
      projectDir = fs.realpathSync(opts.projectDir);
    } catch {
      projectDir = path.resolve(opts.projectDir);
    }
  }

  // Resolve TARGET settings file + PREV-map KEY by scope.
  const scope = projectDir ? "project" : "user";
  const targetPath = projectDir
    ? path.join(projectDir, ".claude", "settings.local.json")
    : CLAUDE_SETTINGS_PATH;
  const key = projectDir || "";

  // (1) PRIOR detection. We look at the *currently effective* non-ours
  // statusLine so the render script can compose it.
  let prior = null;
  if (projectDir) {
    // The tracked project settings.json (which currently shadows us), then fall
    // back to the user settings.json.
    prior =
      priorFromSettings(path.join(projectDir, ".claude", "settings.json")) ||
      priorFromSettings(CLAUDE_SETTINGS_PATH);
  } else {
    prior = priorFromSettings(CLAUDE_SETTINGS_PATH);
  }

  // (2) Record the prior into the PREV map under KEY. Refresh the entry if it
  // differs; never record our own STATUSLINE_SH (priorFromSettings already
  // excludes it). When there is no prior, drop any stale entry for this KEY.
  const map = readPrevMap();
  let composed = false;
  if (prior && prior.command && prior.command !== STATUSLINE_SH) {
    // Detected a real prior at this scope -> record/refresh it, so a repo that
    // later changes its own statusLine is picked up on the next `ensure`.
    map[key] = { command: prior.command, type: prior.type || "command" };
    composed = true;
  } else if (scope === "project") {
    // Project priors come from the TRACKED settings.json, which we never write,
    // so "no prior" means the repo genuinely has no statusLine -> drop any stale
    // entry rather than keep running a command the repo has since removed.
    if (map[key]) delete map[key];
    composed = false;
  } else {
    // User scope: the prior source IS the file we overwrite with our wrapper, so
    // "no prior" usually just means our wrapper is already installed. Keep any
    // previously-recorded original prior.
    composed = !!(map[key] && map[key].command);
  }
  await writePrevMap(map);

  // (3) Render script (knows the prev-statusline MAP path) + bash wrapper.
  // Resolve whether the DAEMONLESS engine is active (config opt-out wins) and the
  // absolute path to the one-shot refresh entry, so the render can revalidate
  // itself with no background daemon.
  const daemonless =
    config && config.injection && typeof config.injection.daemonless === "boolean"
      ? config.injection.daemonless
      : DEFAULT_DAEMONLESS;
  const refreshEntry = fileURLToPath(new URL("../refresh-entry.js", import.meta.url));
  const renderSource = buildRenderScript(CACHE_PATH, CONFIG_PATH, PREV_STATUSLINE_PATH, {
    daemonless,
    refreshEntry,
    lockPath: REFRESH_LOCK_PATH,
    lockTtlMs: REFRESH_LOCK_TTL_MS,
  });
  await fsp.writeFile(STATUSLINE_JS, renderSource);

  // Silence stderr so node warnings never reach the status bar.
  const shSource = `#!/usr/bin/env bash\nexec node ${JSON.stringify(STATUSLINE_JS)} 2>/dev/null\n`;
  await fsp.writeFile(STATUSLINE_SH, shSource);
  await fsp.chmod(STATUSLINE_SH, 0o755);

  // (4) JSON-MERGE our statusLine into TARGET, preserving every other key.
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const targetExisted = fs.existsSync(targetPath);
  const settings = await readJsonSafe(targetPath, {});
  const settingsObj = settings && typeof settings === "object" ? settings : {};

  let backedUp = false;
  let warning = null;

  // If TARGET already held a non-ours statusLine, back it up once.
  const targetExisting = settingsObj.statusLine;
  if (
    targetExisted &&
    targetExisting &&
    typeof targetExisting === "object" &&
    typeof targetExisting.command === "string" &&
    targetExisting.command &&
    targetExisting.command !== STATUSLINE_SH
  ) {
    const backupPath = targetPath + ".contextspin.bak";
    if (!fs.existsSync(backupPath)) {
      await fsp.copyFile(targetPath, backupPath);
      backedUp = true;
    }
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

  await writeJsonAtomic(targetPath, settingsObj);

  // Record this scope in the wired registry so a later `uninstall` can tear down
  // EVERY scope we touched (not just the user scope).
  await addWired(key);

  if (composed) {
    const priorCmd = prior ? prior.command : (map[key] && map[key].command);
    warning =
      `Existing statusLine command (\`${priorCmd}\`) is preserved: ` +
      `ContextSpin runs it and shows its output above the ContextSpin line. ` +
      (scope === "project"
        ? `Wired into ${targetPath} (gitignored; outranks the tracked settings.json). `
        : ``) +
      `Run \`contextspin uninject\` to restore it.`;
  }

  return {
    statuslineSh: STATUSLINE_SH,
    statuslineJs: STATUSLINE_JS,
    settingsPath: targetPath,
    scope,
    backedUp,
    composed,
    warning,
  };
}

/**
 * @typedef {Object} UninstallStatuslineResult
 * @property {boolean} removed - Whether our statusLine entry was removed.
 * @property {boolean} restored - Whether settings were restored from backup.
 * @property {string} settingsPath - Path to the Claude settings file operated on.
 * @property {"project"|"user"} scope - Which scope was operated on.
 * @property {string|null} note - Human-readable note, or null.
 */

/**
 * Remove a scope's entry from the prev-statusline MAP (best-effort). When the
 * map becomes empty the file is removed; otherwise it is rewritten.
 * @param {string} key - The PREV-map key ("" for user scope, else absolute dir).
 * @returns {Promise<void>}
 */
async function removePrevEntry(key) {
  try {
    const map = readPrevMap();
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      delete map[key];
    }
    if (Object.keys(map).length === 0) {
      await fsp.unlink(PREV_STATUSLINE_PATH).catch(() => {});
    } else {
      await writePrevMap(map);
    }
  } catch {
    // best effort
  }
}

/**
 * Uninstall the ContextSpin statusline integration (SCOPE-AWARE reverse).
 *
 *  - Project scope (opts.projectDir set): operate on
 *    <projectDir>/.claude/settings.local.json. If a `.contextspin.bak` exists,
 *    restore it; else JSON-merge to delete just the `statusLine` key (preserving
 *    other keys). Remove that project's entry from the PREV map.
 *  - User scope: operate on the user ~/.claude/settings.json the same way and
 *    remove the "" (user) PREV entry.
 *
 * @param {{ projectDir?: string }} [opts]
 * @returns {Promise<UninstallStatuslineResult>}
 */
export async function uninstallStatusline(opts = {}) {
  // Canonicalize with realpath so the PREV-map key matches whatever the render
  // script derives from Claude Code's stdin (symlinked roots like macOS /var vs
  // /private/var would otherwise diverge). Fall back to path.resolve if realpath
  // throws (e.g. the dir does not exist yet).
  let projectDir = null;
  if (opts && typeof opts.projectDir === "string" && opts.projectDir) {
    try {
      projectDir = fs.realpathSync(opts.projectDir);
    } catch {
      projectDir = path.resolve(opts.projectDir);
    }
  }

  const scope = projectDir ? "project" : "user";
  const targetPath = projectDir
    ? path.join(projectDir, ".claude", "settings.local.json")
    : CLAUDE_SETTINGS_PATH;
  const key = projectDir || "";

  const settings = await readJsonSafe(targetPath, null);
  if (!settings || typeof settings !== "object") {
    // Nothing in TARGET, but still drop any recorded prev entry for this scope.
    await removePrevEntry(key);
    return {
      removed: false,
      restored: false,
      settingsPath: targetPath,
      scope,
      note: "No Claude settings file found; nothing to uninstall.",
    };
  }

  const current = settings.statusLine;
  const isOurs =
    current && typeof current === "object" && current.command === STATUSLINE_SH;

  if (!isOurs) {
    await removePrevEntry(key);
    return {
      removed: false,
      restored: false,
      settingsPath: targetPath,
      scope,
      note: "statusLine is not managed by ContextSpin; left unchanged.",
    };
  }

  const backupPath = targetPath + ".contextspin.bak";
  if (fs.existsSync(backupPath)) {
    const backup = await readJsonSafe(backupPath, null);
    if (backup && typeof backup === "object") {
      await writeJsonAtomic(targetPath, backup);
      try {
        await fsp.unlink(backupPath);
      } catch {
        // best effort
      }
      await removePrevEntry(key);
      return {
        removed: true,
        restored: true,
        settingsPath: targetPath,
        scope,
        note: "Restored previous Claude settings from backup.",
      };
    }
  }

  // No backup: JSON-merge to delete just our statusLine key (preserve the rest).
  delete settings.statusLine;
  await writeJsonAtomic(targetPath, settings);
  await removePrevEntry(key);
  return {
    removed: true,
    restored: false,
    settingsPath: targetPath,
    scope,
    note: "Removed the ContextSpin statusLine entry.",
  };
}

/**
 * Tear down EVERY statusline scope ContextSpin has wired, by walking the wired
 * registry (plus the user scope, always). This is what a full `uninstall` should
 * call: project-scoped wirings written by the SessionStart hook (one per
 * CLAUDE_PROJECT_DIR) are otherwise invisible to a user-scope-only uninstall and
 * would keep rendering the ContextSpin line after removal.
 *
 * Clears the registry when done. Never throws — a failure for one scope is
 * captured in that scope's result and the walk continues.
 *
 * @returns {Promise<UninstallStatuslineResult[]>}
 */
export async function uninstallAllStatuslines() {
  // Always include the user scope (""), plus every recorded project key.
  const keys = Array.from(new Set(["", ...readWiredList()]));
  const results = [];
  for (const key of keys) {
    const projectDir = key === "" ? undefined : key;
    try {
      results.push(await uninstallStatusline({ projectDir }));
    } catch (err) {
      results.push({
        removed: false,
        restored: false,
        settingsPath: key,
        scope: projectDir ? "project" : "user",
        note: `failed: ${err && err.message ? err.message : String(err)}`,
      });
    }
  }
  // Registry is consumed — drop it.
  try {
    await fsp.unlink(WIRED_STATUSLINES_PATH);
  } catch {
    // best effort
  }
  return results;
}
