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

/**
 * Lock file for the DAEMONLESS engine: the render script triggers a detached
 * one-shot refresh when a source is due, guarded by this lock so frequent
 * renders never spawn overlapping refreshes. Holds a timestamp; stale locks
 * (older than REFRESH_LOCK_TTL_MS) are ignored.
 */
export const REFRESH_LOCK_PATH = path.join(STATE_DIR, "refresh.lock");

/** A refresh lock older than this (ms) is considered stale and overridable. */
export const REFRESH_LOCK_TTL_MS = 60_000;

/** Path to the generated statusline bash wrapper. */
export const STATUSLINE_SH = path.join(STATE_DIR, "statusline.sh");

/**
 * Path to the generated statusline Node render script. Uses the `.mjs` extension
 * so Node treats it as ESM regardless of version — the script lives in STATE_DIR
 * (no package.json), and Node 18 has no automatic ESM detection, so a plain
 * `.js` would fail to parse its `import` statements ("Cannot use import statement
 * outside a module").
 */
export const STATUSLINE_JS = path.join(STATE_DIR, "statusline-render.mjs");

/**
 * Path to the recorded prior statusLine commands (captured when we wrap an
 * existing statusline so we can run it and prepend its output). Holds a MAP
 * keyed by absolute project dir (with "" reserved for the user/no-project
 * scope); each value is { command, type }. An old single-object file (with a
 * top-level `command` field) is migrated to the "" entry on read. Entries are
 * removed per-scope on uninstall.
 */
export const PREV_STATUSLINE_PATH = path.join(STATE_DIR, "prev-statusline.json");

/**
 * Path to the registry of every settings file ContextSpin has wired its
 * statusLine into. A JSON array of scope KEYS ("" for the user scope, else an
 * absolute realpath'd project dir). `installStatusline` appends to it; a full
 * `uninstall` walks it so EVERY scope is torn down — not just the user scope.
 * Without this, project-scoped wirings (written by the SessionStart hook per
 * CLAUDE_PROJECT_DIR) would linger after uninstall.
 */
export const WIRED_STATUSLINES_PATH = path.join(STATE_DIR, "wired-statuslines.json");

/** Path to Claude Code's settings file (patched by the statusline injector). */
export const CLAUDE_SETTINGS_PATH = path.join(HOME, ".claude", "settings.json");

/** Path to Claude Code's user config (read by MCP discovery). */
export const CLAUDE_USER_CONFIG_PATH = path.join(HOME, ".claude.json");

/** Suffix appended to a Claude install path to name its patcher backup. */
export const PATCHER_BACKUP_SUFFIX = ".contextspin.backup";

/**
 * Built-in "prefilled" snippet texts. The statusline render script falls back to
 * these (rotating through them) whenever there is no live snippet to show — so
 * the status bar is NEVER empty, even immediately after install before the daemon
 * has fetched anything, or when every source returns nothing. They double as
 * onboarding hints pointing at the next useful thing to configure.
 */
export const DEFAULT_SNIPPETS = [
  // Jokes — always available, even fully offline, so the bar is fun from second
  // one. At least five so the rotation never feels repetitive.
  "😄 Why do programmers prefer dark mode? Because light attracts bugs.",
  "😄 A SQL query walks into a bar, sees two tables and asks: can I join you?",
  "😄 Why did the developer go broke? He used up all his cache.",
  "😄 There are 10 kinds of people: those who read binary and those who don't.",
  "😄 I'd tell you a UDP joke, but you might not get it.",
  "😄 To understand recursion, you must first understand recursion.",
  // Live-context teasers + onboarding — what to try next.
  "🌤️ Local weather appears here once the daemon warms up",
  "📊 Ask /contextspin to see how many PRs you've closed to date",
  "👀 Ask /contextspin to surface PRs awaiting your review",
  "📅 Ask /contextspin to add your next meeting here",
  "🛠️ Ask /contextspin to wire up more live sources",
];

/**
 * No-credentials starter sources seeded into the DEFAULT config on first install
 * so the user sees REAL live context (weather, a fresh joke, the top HN story)
 * immediately — not just static tips. All are public HTTP endpoints needing no
 * auth. Combined with detected sources (e.g. review requests) by defaultConfig.
 */
export const STARTER_SOURCES = [
  {
    type: "http",
    url: "https://wttr.in/?format=3",
    format: "🌤️ {{text}}",
    label: "weather",
    cooldown: 1800,
    maxSnippets: 1,
  },
  {
    type: "http",
    url: "https://icanhazdadjoke.com/",
    headers: { Accept: "text/plain" },
    format: "😄 {{text}}",
    label: "joke",
    cooldown: 1800,
    maxSnippets: 3,
  },
  {
    type: "http",
    url: "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=3",
    jq: ".hits",
    format: "📰 HN: {{title}}",
    label: "hackernews",
    cooldown: 600,
    maxSnippets: 3,
  },
  {
    type: "http",
    url: "https://huggingface.co/api/daily_papers",
    format: "🤗 AI: {{title}}",
    label: "ai-papers",
    cooldown: 3600,
    maxSnippets: 3,
  },
  {
    type: "http",
    url: "https://dev.to/api/articles?top=1&per_page=3",
    format: "📝 Dev.to: {{title}}",
    label: "devto",
    cooldown: 3600,
    maxSnippets: 3,
  },
  {
    type: "http",
    url: "https://zenquotes.io/api/today",
    format: "💬 {{q}} — {{a}}",
    label: "quote",
    cooldown: 86400,
    maxSnippets: 1,
  },
];

/** Default top-level config sections. */
export const DEFAULTS = {
  injection: { mode: "statusline", refresh: 30, maxVisible: 5 },
  snippets: { deduplication: true, cooldownAfterShown: 5, priorityOrder: [] },
};

/**
 * Whether the DAEMONLESS engine is the default. When true, no background daemon
 * runs: the statusline render does stale-while-revalidate — it serves the cached
 * snippet instantly and triggers a detached one-shot refresh when a source is
 * due. Idle cost is then zero (nothing runs unless the bar is being drawn).
 * Honored unless a config explicitly sets `injection.daemonless`.
 */
export const DEFAULT_DAEMONLESS = true;

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
 * Build a complete default config object from a set of sources. Mirrors the
 * shipped example config's injection/snippets shape (statusline mode, 30s
 * refresh, 5 visible, dedup on, a sensible priority order). The result is a
 * plain config (NOT normalized) — pass it through normalizeConfig before use.
 *
 * @param {Array<object>} sources - Source objects (e.g. from detectSources).
 * @returns {object} A default config: { sources, injection, snippets }.
 */
export function defaultConfig(sources) {
  const detected = Array.isArray(sources) ? sources : [];
  // Seed the no-credentials starter sources so a brand-new install shows REAL
  // live context right away. Skip any starter whose label a detected source
  // already provides, so we never double up.
  const have = new Set(detected.map((s) => s && s.label).filter(Boolean));
  const starters = STARTER_SOURCES.filter((s) => !have.has(s.label)).map((s) => ({
    ...s,
  }));
  return {
    sources: [...detected, ...starters],
    injection: { mode: "statusline", refresh: 30, maxVisible: 5 },
    snippets: {
      deduplication: true,
      cooldownAfterShown: 5,
      priorityOrder: [
        "review",
        "incident",
        "ci",
        "slack",
        "calendar",
        "github",
        "gitlab",
        "jira",
        "weather",
        "joke",
        "hackernews",
        "ai-papers",
        "devto",
        "quote",
      ],
    },
  };
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
  // sources must be an array, but MAY be empty: a source-less config is valid —
  // the daemon polls nothing and the injectors degrade to no snippets, which is
  // the correct "installed but not configured yet" state (and lets `ensure`
  // wire the statusline + start the daemon without a hard failure).
  if (!Array.isArray(config.sources)) {
    throw new Error('Invalid config: "sources" must be an array.');
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
