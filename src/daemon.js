// src/daemon.js — the background poller: cache I/O, snippet merging, the poll loop, and process lifecycle.

import fs from "node:fs";
import fsp from "node:fs/promises";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CACHE_PATH, STATE_DIR, PID_PATH, LOG_PATH, loadConfig } from "./config.js";
import { runSource } from "./runner.js";

/**
 * Current time as an ISO-8601 string.
 * @returns {string}
 */
function nowISO() {
  return new Date().toISOString();
}

/**
 * Read the snippet cache.
 * @returns {Promise<{updatedAt: string|null, snippets: import("./runner.js").Snippet[]}>}
 *   On a missing file or parse error, returns { updatedAt: null, snippets: [] }.
 */
export async function readCache() {
  try {
    const raw = await fsp.readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { updatedAt: null, snippets: [] };
    return {
      updatedAt: parsed.updatedAt ?? null,
      snippets: Array.isArray(parsed.snippets) ? parsed.snippets : [],
    };
  } catch {
    return { updatedAt: null, snippets: [] };
  }
}

/**
 * Atomically write the snippet cache (write a .tmp file, then rename).
 * @param {{updatedAt: string, snippets: import("./runner.js").Snippet[]}} state
 * @returns {Promise<void>}
 */
export async function writeCache(state) {
  const tmp = CACHE_PATH + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
  await fsp.rename(tmp, CACHE_PATH);
}

/**
 * Merge freshly fetched snippets into the existing set. Pure (no mutation of inputs).
 *
 * - Preserves shownCount from oldSnippets for any new snippet whose text matches.
 * - If config.snippets.deduplication, dedup by text (keeps the first occurrence).
 * - Sorts by priority: index of snippet.source within config.snippets.priorityOrder
 *   (case-insensitive; not-found sorts last), then by fetchedAt descending. Stable.
 * - Caps the result to config.injection.maxVisible.
 *
 * @param {import("./runner.js").Snippet[]} oldSnippets
 * @param {import("./runner.js").Snippet[]} newSnippets
 * @param {object} config - Normalized config (snippets + injection sections).
 * @returns {import("./runner.js").Snippet[]}
 */
export function mergeSnippets(oldSnippets, newSnippets, config) {
  const oldList = Array.isArray(oldSnippets) ? oldSnippets : [];
  const newList = Array.isArray(newSnippets) ? newSnippets : [];

  // Index prior shownCounts by snippet text so we can carry them forward.
  const shownByText = new Map();
  for (const s of oldList) {
    if (s && typeof s.text === "string" && !shownByText.has(s.text)) {
      shownByText.set(s.text, s.shownCount || 0);
    }
  }

  // Copy each new snippet, preserving any prior shownCount for the same text.
  let merged = newList.map((s) => ({
    ...s,
    shownCount: shownByText.has(s.text) ? shownByText.get(s.text) : s.shownCount || 0,
  }));

  // Optional dedup by text, keeping the first occurrence.
  if (config?.snippets?.deduplication) {
    const seen = new Set();
    const deduped = [];
    for (const s of merged) {
      if (seen.has(s.text)) continue;
      seen.add(s.text);
      deduped.push(s);
    }
    merged = deduped;
  }

  // Precompute priority rank (case-insensitive) for each source label.
  const priorityOrder = Array.isArray(config?.snippets?.priorityOrder)
    ? config.snippets.priorityOrder.map((p) => String(p).toLowerCase())
    : [];
  const rankOf = (label) => {
    const idx = priorityOrder.indexOf(String(label ?? "").toLowerCase());
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };

  // Stable sort: priority ascending, then fetchedAt descending.
  const decorated = merged.map((s, i) => ({ s, i }));
  decorated.sort((a, b) => {
    const ra = rankOf(a.s.source);
    const rb = rankOf(b.s.source);
    if (ra !== rb) return ra - rb;
    const ta = String(a.s.fetchedAt ?? "");
    const tb = String(b.s.fetchedAt ?? "");
    if (ta !== tb) return ta < tb ? 1 : -1; // descending
    return a.i - b.i; // stability
  });
  const sorted = decorated.map((d) => d.s);

  const maxVisible = config?.injection?.maxVisible;
  return typeof maxVisible === "number" ? sorted.slice(0, maxVisible) : sorted;
}

/**
 * Run one polling pass over all sources, respecting per-source cooldowns.
 *
 * For each source, if (now - lastRun) >= cooldown*1000 ms, runSource is attempted;
 * on success its result is stored in runtime.buckets[source.id] and lastRun updated.
 * On error, a concise message is logged and the previous bucket is kept. After all
 * sources, every bucket is flattened (preserving per-source order) and merged into
 * runtime.snippets via mergeSnippets.
 *
 * @param {object} config - Normalized config (with sources array).
 * @param {{lastRun: object, buckets: object, snippets: import("./runner.js").Snippet[]}} runtime
 * @returns {Promise<import("./runner.js").Snippet[]>}
 */
export async function pollOnce(config, runtime) {
  const now = Date.now();
  for (const source of config.sources) {
    const last = runtime.lastRun[source.id] || 0;
    if (now - last >= source.cooldown * 1000) {
      try {
        const result = await runSource(source, {});
        runtime.buckets[source.id] = result;
        runtime.lastRun[source.id] = Date.now();
      } catch (err) {
        console.error(`source "${source.label}" (#${source.id}) failed: ${err.message}`);
        // Keep the previous bucket unchanged.
      }
    }
  }

  // Flatten all buckets, preserving per-source order (by source id ordering).
  const flattened = [];
  for (const source of config.sources) {
    const bucket = runtime.buckets[source.id];
    if (Array.isArray(bucket)) flattened.push(...bucket);
  }

  runtime.snippets = mergeSnippets(runtime.snippets, flattened, config);
  return runtime.snippets;
}

/**
 * Run the daemon poll loop. Writes the PID file, installs signal handlers, and
 * loops: pollOnce -> writeCache -> wait config.injection.refresh seconds.
 *
 * @param {{once?: boolean, configPath?: string}} [opts]
 * @returns {Promise<void>}
 */
export async function runDaemonLoop(opts = {}) {
  await fsp.mkdir(STATE_DIR, { recursive: true });
  const config = await loadConfig(opts.configPath);
  await fsp.writeFile(PID_PATH, String(process.pid));

  const shutdown = () => {
    try {
      fs.rmSync(PID_PATH, { force: true });
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(`contextspin daemon started (pid ${process.pid})`);

  const runtime = { lastRun: {}, buckets: {}, snippets: [] };
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const snippets = await pollOnce(config, runtime);
      await writeCache({ updatedAt: nowISO(), snippets });
    } catch (err) {
      console.error(`poll failed: ${err.message}`);
    }
    if (opts.once) break;
    await new Promise((resolve) => setTimeout(resolve, config.injection.refresh * 1000));
  }
}

/**
 * Whether the daemon appears to be running, based on the PID file.
 * @returns {{running: boolean, pid: number|null}}
 */
export function isDaemonRunning() {
  let pid = null;
  try {
    pid = parseInt(fs.readFileSync(PID_PATH, "utf8").trim(), 10);
  } catch {
    return { running: false, pid: null };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { running: false, pid: null };
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid };
  }
}

/**
 * Spawn the daemon as a detached background process writing to LOG_PATH.
 *
 * If already running, returns { already: true, pid }. Otherwise spawns
 * process.execPath against src/daemon-entry.js (resolved relative to this module),
 * detached with stdout/stderr redirected to LOG_PATH, unrefs it, records the pid,
 * and returns { pid }.
 *
 * @param {{configPath?: string}} [opts]
 * @returns {{already?: boolean, pid: number}}
 */
export function startDaemonDetached(opts = {}) {
  const existing = isDaemonRunning();
  if (existing.running) return { already: true, pid: existing.pid };

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_PATH, "a");

  // Resolve the entry path relative to this module (never hard-coded).
  const entryPath = fileURLToPath(new URL("./daemon-entry.js", import.meta.url));

  const env = { ...process.env };
  if (opts.configPath) env.CONTEXTSPIN_CONFIG = opts.configPath;

  const child = spawn(process.execPath, [entryPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
  });
  child.unref();

  fs.writeFileSync(PID_PATH, String(child.pid));
  return { pid: child.pid };
}

/**
 * Stop the daemon: send SIGTERM, poll up to ~3s for exit, then remove the PID file.
 * @returns {Promise<{stopped: boolean, pid: number|null}>}
 */
export async function stopDaemon() {
  const { running, pid } = isDaemonRunning();
  if (!running || !pid) {
    try {
      fs.rmSync(PID_PATH, { force: true });
    } catch {
      // ignore
    }
    return { stopped: false, pid: pid ?? null };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process may already be gone.
  }

  // Poll up to ~3s for the process to exit.
  let stopped = false;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      stopped = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  try {
    fs.rmSync(PID_PATH, { force: true });
  } catch {
    // ignore
  }

  return { stopped, pid };
}
