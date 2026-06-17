// src/config.js — path constants, config defaults, and load/normalize/validate.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";

/** The current user's home directory. */
const HOME = os.homedir();

/** Directory holding ContextSpin's runtime state (daemon pid, statusline, logs). */
export const STATE_DIR = path.join(HOME, ".contextspin");

/**
 * Path to the user config. Honors the CONTEXTSPIN_CONFIG env override (resolved
 * once at module load, primarily so tests can point at a temp file).
 */
export const CONFIG_PATH =
  process.env.CONTEXTSPIN_CONFIG || path.join(HOME, ".contextspin.json");

/**
 * Path to the snippet cache the daemon writes and the injectors read. Honors the
 * CONTEXTSPIN_CACHE env override (resolved once at module load).
 */
export const CACHE_PATH =
  process.env.CONTEXTSPIN_CACHE || path.join(HOME, ".contextspin-cache.json");

/** Path to the daemon PID file. */
export const PID_PATH = path.join(STATE_DIR, "daemon.pid");

/** Path to the daemon log file. */
export const LOG_PATH = path.join(STATE_DIR, "daemon.log");

/** Path to the generated statusline bash wrapper. */
export const STATUSLINE_SH = path.join(STATE_DIR, "statusline.sh");

/** Path to the generated statusline Node render script. */
export const STATUSLINE_JS = path.join(STATE_DIR, "statusline-render.js");

/** Path to Claude Code's settings file (patched by the statusline injector). */
export const CLAUDE_SETTINGS_PATH = path.join(HOME, ".claude", "settings.json");

/** Path to Claude Code's user config (read by MCP discovery). */
export const CLAUDE_USER_CONFIG_PATH = path.join(HOME, ".claude.json");

/** Suffix appended to a Claude install path to name its patcher backup. */
export const PATCHER_BACKUP_SUFFIX = ".contextspin.backup";

/** Default top-level config sections. */
export const DEFAULTS = {
  injection: { mode: "statusline", refresh: 30, maxVisible: 5 },
  snippets: { deduplication: true, cooldownAfterShown: 3, priorityOrder: [] },
};

/** Per-source defaults applied when a field is omitted. */
export const SOURCE_DEFAULTS = { cooldown: 300, maxSnippets: 2 };

/** Source types ContextSpin understands. */
const VALID_SOURCE_TYPES = ["mcp", "cli", "http"];

/** Valid injection modes. */
const VALID_INJECTION_MODES = ["statusline", "patcher", "both"];

/**
 * Derive a human-readable label for a source from its type/fields.
 *  - mcp  -> the tool name
 *  - cli  -> the first whitespace-delimited token of the command
 *  - http -> the URL hostname
 *  - fallback -> the source type
 * @param {object} src
 * @returns {string}
 */
function deriveLabel(src) {
  if (src.type === "mcp" && src.tool) return String(src.tool);
  if (src.type === "cli" && src.command) {
    const first = String(src.command).trim().split(/\s+/)[0];
    return first || "cli";
  }
  if (src.type === "http" && src.url) {
    try {
      return new URL(String(src.url)).hostname || "http";
    } catch {
      return "http";
    }
  }
  return src.type || "source";
}

/**
 * Normalize a raw config: fill in DEFAULTS and SOURCE_DEFAULTS, assign each
 * source an `id` (its index), and derive a `label` when one is missing. Pure —
 * the input object is never mutated.
 *
 * @param {object} raw - The parsed config (possibly partial).
 * @returns {object} A new, fully-populated config object.
 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === "object" ? raw : {};

  const injectionIn =
    input.injection && typeof input.injection === "object" ? input.injection : {};
  const injection = { ...DEFAULTS.injection, ...injectionIn };

  const snippetsIn =
    input.snippets && typeof input.snippets === "object" ? input.snippets : {};
  const snippets = {
    ...DEFAULTS.snippets,
    ...snippetsIn,
    priorityOrder: Array.isArray(snippetsIn.priorityOrder)
      ? snippetsIn.priorityOrder.slice()
      : DEFAULTS.snippets.priorityOrder.slice(),
  };

  const sourcesIn = Array.isArray(input.sources) ? input.sources : [];
  const sources = sourcesIn.map((s, i) => {
    const src = { ...SOURCE_DEFAULTS, ...(s && typeof s === "object" ? s : {}) };
    src.id = i;
    if (src.label === undefined || src.label === null || src.label === "") {
      src.label = deriveLabel(src);
    }
    return src;
  });

  return { ...input, injection, snippets, sources };
}

/**
 * Validate a config (raw or normalized). Throws an Error with a clear message on
 * any problem; returns the same config object on success.
 *
 * @param {object} config
 * @returns {object} The validated config (same reference).
 */
export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Invalid config: expected a JSON object.");
  }
  if (!Array.isArray(config.sources) || config.sources.length === 0) {
    throw new Error('Invalid config: "sources" must be a non-empty array.');
  }

  config.sources.forEach((src, i) => {
    if (!src || typeof src !== "object") {
      throw new Error(`Invalid config: source #${i} must be an object.`);
    }
    if (!src.type) {
      throw new Error(`Invalid config: source #${i} is missing "type".`);
    }
    if (!VALID_SOURCE_TYPES.includes(src.type)) {
      throw new Error(
        `Invalid config: source #${i} has invalid type "${src.type}" (expected mcp, cli, or http).`,
      );
    }
    if (src.type === "mcp" && !src.tool) {
      throw new Error(`Invalid config: mcp source #${i} is missing "tool".`);
    }
    if (src.type === "cli" && !src.command) {
      throw new Error(`Invalid config: cli source #${i} is missing "command".`);
    }
    if (src.type === "http" && !src.url) {
      throw new Error(`Invalid config: http source #${i} is missing "url".`);
    }
    if (!src.format) {
      throw new Error(`Invalid config: source #${i} is missing "format".`);
    }
  });

  if (
    config.injection &&
    config.injection.mode !== undefined &&
    !VALID_INJECTION_MODES.includes(config.injection.mode)
  ) {
    throw new Error(
      `Invalid config: injection.mode must be one of statusline, patcher, both (got "${config.injection.mode}").`,
    );
  }

  return config;
}

/**
 * Load, normalize, and validate the config from disk.
 *
 * @param {string} [configPath=CONFIG_PATH]
 * @returns {Promise<object>} The normalized, validated config.
 * @throws If the file is missing (with a setup hint), unparseable (message
 *   includes the path), or invalid.
 */
export async function loadConfig(configPath = CONFIG_PATH) {
  let raw;
  try {
    raw = await fsp.readFile(configPath, "utf8");
  } catch {
    throw new Error(
      `No ContextSpin config at ${configPath}. Run: contextspin setup`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ContextSpin config at ${configPath}: ${err.message}`,
    );
  }

  return validateConfig(normalizeConfig(parsed));
}

/**
 * Whether a config file exists at the given path (sync).
 * @param {string} [configPath=CONFIG_PATH]
 * @returns {boolean}
 */
export function configExists(configPath = CONFIG_PATH) {
  try {
    return fs.existsSync(configPath);
  } catch {
    return false;
  }
}

/**
 * Write a config to disk as pretty-printed JSON (2-space indent).
 * @param {object} config
 * @param {string} [configPath=CONFIG_PATH]
 * @returns {Promise<void>}
 */
export async function saveConfig(config, configPath = CONFIG_PATH) {
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2));
}
