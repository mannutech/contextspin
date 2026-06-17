// src/inject/patcher.js — EXPERIMENTAL spinner-word patcher for Claude Code installs.
//
// ============================================================================
// EXPERIMENTAL / FRAGILE — READ BEFORE TOUCHING
// ============================================================================
// This module rewrites the hardcoded spinner-word array inside a Claude Code
// install so the "Flibbertigibbeting..."-style gerunds become your live context
// snippets. It supports two install forms:
//
//   * TEXT install (minified cli.js): the array literal can be freely rewritten;
//     file length may change.
//   * BINARY install (Bun-compiled native executable, ELF/Mach-O/PE): edits MUST
//     be LENGTH-PRESERVING. Changing the byte length would shift section offsets
//     baked into the container and corrupt the executable. We therefore replace
//     the array in place and PAD with spaces to keep the exact original byte
//     length, dropping words if the replacement would not otherwise fit. On
//     macOS the binary is re-signed ad-hoc (`codesign -s - -f`) afterwards.
//
// Detection is MARKER-BASED: we look for an array literal containing >= 3 known
// marker words. We NEVER key off the variable name — the minifier renames it on
// every release.
//
// IMPORTANT: Claude Code auto-updates OVERWRITE this patch. The patch is also
// moot until Claude Code is FULLY RESTARTED (a running process keeps the old
// code in memory). installPatcher() emits a shell wrapper that re-applies the
// patch before launching claude, which self-heals across updates.
//
// node-lief (optional) is only needed to fully crack/repack the Bun container.
// Stage 1 does best-effort in-place buffer replacement and SKIPS any binary it
// cannot safely edit, recommending claude-depester for those.
// ============================================================================

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STATE_DIR, CACHE_PATH, PATCHER_BACKUP_SUFFIX } from "../config.js";

/**
 * Known spinner marker words. Presence of >= 3 of these inside an array literal
 * identifies the spinner-word array regardless of how the variable was minified.
 * @type {string[]}
 */
export const MARKER_WORDS = [
  "Flibbertigibbeting",
  "Discombobulating",
  "Clauding",
  "Smooshing",
  "Wibbling",
  "Schlepping",
];

/** The single marker we require to be present in any candidate file's bytes. */
const REQUIRED_MARKER = "Flibbertigibbeting";

/** Max bytes to scan backward from the marker for the opening "[" in a binary. */
const BIN_BACKSCAN = 5000;
/** Max bytes to scan forward from the marker for the closing "]" in a binary. */
const BIN_FORWARDSCAN = 20000;

/**
 * Attempt to load the optional node-lief dependency. Returns null if absent.
 * (Reserved for future container repacking; Stage 1 never requires it.)
 * @returns {Promise<*>} The node-lief module, or null.
 */
async function tryLoadLief() {
  try {
    const mod = await import("node-lief");
    return mod && mod.default ? mod.default : mod;
  } catch {
    return null;
  }
}

/**
 * Run a command and return its trimmed stdout, swallowing any failure.
 * @param {string} cmd
 * @returns {string} stdout (trimmed) or "" on error.
 */
function execTrim(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * Classify a file as "binary" or "text" by inspecting its first 4 bytes for
 * known executable magic numbers (ELF / Mach-O / PE). Anything else is "text".
 * @param {string} filePath
 * @returns {"binary"|"text"} The classification (defaults to "text" on error).
 */
function classifyFile(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      const m = buf.readUInt32BE(0);
      const mLE = buf.readUInt32LE(0);
      // ELF: 0x7F 'E' 'L' 'F'
      if (m === 0x7f454c46) return "binary";
      // Mach-O 32/64 and byte-swapped variants.
      const machos = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca];
      if (machos.includes(m) || machos.includes(mLE)) return "binary";
      // PE/COFF executables start with "MZ".
      if (buf[0] === 0x4d && buf[1] === 0x5a) return "binary";
      return "text";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "text";
  }
}

/**
 * Resolve newest-semver `claude` binary under each `versions/*` root.
 * @param {string} versionsRoot - Directory containing version-named subfolders.
 * @returns {string|null} Absolute path to the newest version's claude, or null.
 */
function newestVersionClaude(versionsRoot) {
  let entries;
  try {
    entries = fs.readdirSync(versionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(compareSemverDesc);
  for (const v of versions) {
    const candidate = path.join(versionsRoot, v, "claude");
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Compare two semver-ish strings for descending sort (newest first).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareSemverDesc(a, b) {
  const pa = String(a).split(/[.\-+]/).map((n) => parseInt(n, 10));
  const pb = String(b).split(/[.\-+]/).map((n) => parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return y - x; // descending
  }
  return String(b).localeCompare(String(a));
}

/**
 * @typedef {Object} ClaudeInstall
 * @property {string} path - Absolute path to the claude executable / cli.js.
 * @property {"binary"|"text"} type - File classification.
 */

/**
 * Discover candidate Claude Code installs across the common locations, dedupe by
 * realpath, classify each as binary/text, and KEEP ONLY files whose bytes
 * contain the required spinner marker word.
 *
 * Candidate locations:
 *  - `which claude` -> realpath
 *  - newest semver under ~/.local/share/claude/versions (per-version claude)
 *  - newest semver under ~/Library/Application Support/Claude/versions
 *  - `npm root -g` + @anthropic-ai/claude-code/cli.js
 *  - ~/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js
 *  - /opt/homebrew & /usr/local lib/node_modules @anthropic-ai/claude-code/cli.js
 *
 * @returns {Promise<ClaudeInstall[]>}
 */
export async function findClaudeInstalls() {
  const installs = [];
  for (const real of gatherCandidatePaths()) {
    // Keep only files actually containing the spinner marker (i.e. patchable
    // and not already patched).
    let hasMarker = false;
    try {
      const buf = fs.readFileSync(real);
      hasMarker = buf.indexOf(Buffer.from(REQUIRED_MARKER, "utf8")) !== -1;
    } catch {
      hasMarker = false;
    }
    if (!hasMarker) continue;

    installs.push({ path: real, type: classifyFile(real) });
  }

  return installs;
}

/**
 * Gather candidate Claude Code install paths across the common locations,
 * deduped by realpath and limited to existing regular files. UNLIKE
 * findClaudeInstalls(), this does NOT apply the spinner-marker filter — a
 * patched install no longer contains the marker, so restorePatcher() must still
 * be able to see it to put the backup back.
 *
 * @returns {string[]} Absolute (realpath) candidate paths.
 */
function gatherCandidatePaths() {
  const home = os.homedir();
  const candidates = [];

  // which claude -> realpath
  const which = execTrim("which claude");
  if (which) {
    try {
      candidates.push(fs.realpathSync(which));
    } catch {
      candidates.push(which);
    }
  }

  // versions roots
  const fromLocalShare = newestVersionClaude(
    path.join(home, ".local", "share", "claude", "versions")
  );
  if (fromLocalShare) candidates.push(fromLocalShare);

  const fromAppSupport = newestVersionClaude(
    path.join(home, "Library", "Application Support", "Claude", "versions")
  );
  if (fromAppSupport) candidates.push(fromAppSupport);

  // npm global root
  const npmRoot = execTrim("npm root -g");
  if (npmRoot) {
    candidates.push(path.join(npmRoot, "@anthropic-ai", "claude-code", "cli.js"));
  }

  // user-local npm install
  candidates.push(
    path.join(home, ".claude", "local", "node_modules", "@anthropic-ai", "claude-code", "cli.js")
  );

  // homebrew prefixes
  candidates.push(
    path.join("/opt/homebrew", "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js")
  );
  candidates.push(
    path.join("/usr/local", "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js")
  );

  // Dedup by realpath, keep only existing regular files.
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c) continue;
    let real;
    try {
      const st = fs.statSync(c);
      if (!st.isFile()) continue;
      real = fs.realpathSync(c);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(real);
  }
  return out;
}

/**
 * Build the replacement spinner words from the current cache snippets, capped to
 * config.injection.maxVisible (default 5). Falls back to ["Thinking"] if empty.
 * @param {object} config - Normalized ContextSpin config.
 * @returns {Promise<string[]>}
 */
export async function buildSpinnerWords(config) {
  const maxVisible =
    config && config.injection && typeof config.injection.maxVisible === "number"
      ? config.injection.maxVisible
      : 5;

  let snippets = [];
  try {
    const cache = JSON.parse(await fsp.readFile(CACHE_PATH, "utf8"));
    if (cache && Array.isArray(cache.snippets)) snippets = cache.snippets;
  } catch {
    snippets = [];
  }

  const words = snippets
    .map((s) => (s && typeof s.text === "string" ? s.text : null))
    .filter((t) => t && t.trim() !== "")
    .slice(0, maxVisible);

  return words.length > 0 ? words : ["Thinking"];
}

/**
 * Count how many distinct MARKER_WORDS appear in a string.
 * @param {string} str
 * @returns {number}
 */
function countMarkers(str) {
  let n = 0;
  for (const w of MARKER_WORDS) {
    if (str.includes(w)) n++;
  }
  return n;
}

/**
 * Scan a string for the first top-level array literal (matched brackets) whose
 * contents include >= 3 marker words. Marker-based; never keys off a var name.
 * @param {string} text
 * @returns {{start:number, end:number}|null} Inclusive bracket span, or null.
 */
function findMarkerArrayInText(text) {
  let searchFrom = 0;
  while (true) {
    const open = text.indexOf("[", searchFrom);
    if (open === -1) return null;
    const close = matchBracket(text, open);
    if (close === -1) return null;
    const inner = text.slice(open, close + 1);
    if (countMarkers(inner) >= 3) {
      return { start: open, end: close };
    }
    searchFrom = open + 1;
  }
}

/**
 * Find the index of the "]" that closes the "[" at `openIdx`, respecting nested
 * brackets and string literals. Returns -1 if unbalanced.
 * @param {string} text
 * @param {number} openIdx
 * @returns {number}
 */
function matchBracket(text, openIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i++; // skip escaped char
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * @typedef {Object} PatchResult
 * @property {string} path - Install path that was processed.
 * @property {"binary"|"text"} type
 * @property {boolean} patched - Whether the spinner array was replaced.
 * @property {string} note - Human-readable detail.
 */

/**
 * Back up an install (only if no backup exists yet).
 * @param {string} filePath
 * @returns {Promise<void>}
 */
async function backupOnce(filePath) {
  const backup = filePath + PATCHER_BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) {
    await fsp.copyFile(filePath, backup);
  }
}

/**
 * Patch a TEXT (minified cli.js) install: replace the marker array literal with
 * a JSON array of the given words. File length may change freely.
 * @param {ClaudeInstall} install
 * @param {string[]} words
 * @returns {Promise<PatchResult>}
 */
async function patchTextInstall(install, words) {
  const text = await fsp.readFile(install.path, "utf8");
  const span = findMarkerArrayInText(text);
  if (!span) {
    return {
      path: install.path,
      type: "text",
      patched: false,
      note: "Could not locate the spinner-word array (>=3 markers) in the text install.",
    };
  }
  const replacement = JSON.stringify(words);
  const next = text.slice(0, span.start) + replacement + text.slice(span.end + 1);

  // tmp + rename preserving mode.
  const mode = (await fsp.stat(install.path)).mode;
  const tmp = install.path + ".contextspin.tmp";
  await fsp.writeFile(tmp, next);
  await fsp.chmod(tmp, mode);
  await fsp.rename(tmp, install.path);

  return {
    path: install.path,
    type: "text",
    patched: true,
    note: `Replaced spinner array with ${words.length} word(s).`,
  };
}

/**
 * Build a LENGTH-PRESERVING replacement for a binary spinner array.
 *
 * Produces bytes for a JSON array of `words` that fits EXACTLY into `spanLen`
 * bytes (the original "[...]" span). Words are dropped from the end until the
 * JSON array fits; remaining slack is padded with spaces inside the array,
 * just before the closing "]", so the total byte length is unchanged.
 *
 * @param {string[]} words
 * @param {number} spanLen - Byte length of the original "[...]" span.
 * @returns {Buffer|null} Exactly `spanLen` bytes, or null if even "[]" won't fit.
 */
function buildBinaryReplacement(words, spanLen) {
  let list = Array.isArray(words) && words.length > 0 ? words.slice() : ["Thinking"];
  while (true) {
    const json = JSON.stringify(list); // e.g. ["a","b"]
    const jsonBuf = Buffer.from(json, "utf8");
    if (jsonBuf.length <= spanLen) {
      const pad = spanLen - jsonBuf.length;
      if (pad === 0) return jsonBuf;
      // Insert `pad` spaces just before the final "]" to keep valid JSON-ish
      // array syntax and exact length.
      const head = jsonBuf.subarray(0, jsonBuf.length - 1); // everything but "]"
      const spaces = Buffer.alloc(pad, 0x20);
      return Buffer.concat([head, spaces, Buffer.from("]", "utf8")]);
    }
    if (list.length <= 1) {
      // Even a single (shortest) word will not fit the original span. Give up
      // rather than writing an EMPTY spinner array (which would leave Claude
      // Code with no spinner words at all and strip the restore marker).
      return null;
    }
    list = list.slice(0, list.length - 1); // drop the last word and retry
  }
}

/**
 * Patch a BINARY (Bun-compiled) install LENGTH-PRESERVINGLY.
 *  - Locate the marker, back-scan for "[", forward-scan for "]".
 *  - Validate the span contains >= 3 markers.
 *  - Build an exact-length replacement (drop/trim words, pad with spaces).
 *  - Overwrite the span in the buffer; write via tmp + rename preserving mode.
 *  - On darwin, best-effort ad-hoc re-sign.
 * @param {ClaudeInstall} install
 * @param {string[]} words
 * @returns {Promise<PatchResult>}
 */
async function patchBinaryInstall(install, words) {
  const buf = await fsp.readFile(install.path);
  const markerBuf = Buffer.from(REQUIRED_MARKER, "utf8");
  const markerIdx = buf.indexOf(markerBuf);
  if (markerIdx === -1) {
    return {
      path: install.path,
      type: "binary",
      patched: false,
      note: "Marker word not found in binary; skipping (try claude-depester).",
    };
  }

  // Back-scan for "[".
  const backStart = Math.max(0, markerIdx - BIN_BACKSCAN);
  let open = -1;
  for (let i = markerIdx; i >= backStart; i--) {
    if (buf[i] === 0x5b) {
      open = i;
      break;
    }
  }
  if (open === -1) {
    return {
      path: install.path,
      type: "binary",
      patched: false,
      note: "Could not find opening '[' near marker; skipping (try claude-depester).",
    };
  }

  // Forward-scan for "]".
  const fwdEnd = Math.min(buf.length - 1, markerIdx + BIN_FORWARDSCAN);
  let close = -1;
  for (let i = markerIdx; i <= fwdEnd; i++) {
    if (buf[i] === 0x5d) {
      close = i;
      break;
    }
  }
  if (close === -1 || close <= open) {
    return {
      path: install.path,
      type: "binary",
      patched: false,
      note: "Could not find closing ']' near marker; skipping (try claude-depester).",
    };
  }

  const spanLen = close - open + 1;
  const spanStr = buf.subarray(open, close + 1).toString("utf8");
  if (countMarkers(spanStr) < 3) {
    return {
      path: install.path,
      type: "binary",
      patched: false,
      note: "Bracket span did not contain >=3 marker words; skipping (try claude-depester).",
    };
  }

  const replacement = buildBinaryReplacement(words, spanLen);
  if (!replacement || replacement.length !== spanLen) {
    return {
      path: install.path,
      type: "binary",
      patched: false,
      note:
        "Snippets are too long to fit the binary's spinner span (it must be length-preserving); skipped to avoid an empty/corrupt array — try shorter snippets or claude-depester.",
    };
  }

  // Overwrite the span in place — LENGTH-PRESERVING, file size unchanged.
  replacement.copy(buf, open);

  // Write via tmp + rename preserving mode.
  const mode = (await fsp.stat(install.path)).mode;
  const tmp = install.path + ".contextspin.tmp";
  await fsp.writeFile(tmp, buf);
  await fsp.chmod(tmp, mode);
  await fsp.rename(tmp, install.path);

  let note = "Replaced spinner array in place (length-preserving).";

  // Best-effort ad-hoc re-sign on macOS.
  if (process.platform === "darwin") {
    try {
      const r = spawnSync("codesign", ["-s", "-", "-f", install.path], {
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
      });
      if (r.status !== 0) {
        note += ` Warning: ad-hoc codesign failed (${(r.stderr || "").trim() || "unknown error"}); the binary may be quarantined until re-signed.`;
      } else {
        note += " Re-signed ad-hoc (codesign -s - -f).";
      }
    } catch (err) {
      note += ` Warning: could not run codesign (${err.message}).`;
    }
  }

  return { path: install.path, type: "binary", patched: true, note };
}

/**
 * Patch a single install (text or binary), backing it up first.
 * @param {ClaudeInstall} install
 * @param {string[]} words
 * @returns {Promise<PatchResult>}
 */
export async function patchInstall(install, words) {
  await backupOnce(install.path);
  // node-lief is optional and only useful for full container repacking; Stage 1
  // proceeds with raw-buffer logic whether or not it is present.
  await tryLoadLief();

  if (install.type === "binary") {
    return patchBinaryInstall(install, words);
  }
  return patchTextInstall(install, words);
}

/**
 * Build the self-healing wrapper script that re-applies the patch before
 * launching claude (so auto-updates that overwrite the patch are healed).
 * @returns {string} Shell script source.
 */
function buildWrapperScript() {
  const entry = path.join(STATE_DIR, "patch-run.mjs");
  return `#!/usr/bin/env bash
# contextspin cl.sh — patch-before-load wrapper for Claude Code.
# Claude Code auto-updates overwrite the spinner patch; running the patcher here
# re-applies it each launch so the patch self-heals. Patching only takes effect
# after Claude Code is fully restarted (this wrapper launches a fresh process).
node ${JSON.stringify(entry)} >/dev/null 2>&1 || true
exec claude "$@"
`;
}

/**
 * Build the tiny Node entry that the wrapper invokes to re-apply the patch.
 * @param {string} packageRoot - Absolute path to the contextspin package root.
 * @returns {string} ESM source.
 */
function buildPatchRunEntry(packageRoot) {
  const patcherUrl = JSON.stringify(
    "file://" + path.join(packageRoot, "src", "inject", "patcher.js")
  );
  const configUrl = JSON.stringify(
    "file://" + path.join(packageRoot, "src", "config.js")
  );
  return `// contextspin patch-run.mjs (generated) — re-applies the spinner patch.
import { installPatcher } from ${patcherUrl};
import { loadConfig } from ${configUrl};
try {
  const config = await loadConfig();
  await installPatcher(config);
} catch (err) {
  // Best-effort: never block launching claude.
  process.stderr.write("contextspin patch-run: " + (err && err.message) + "\\n");
}
`;
}

/**
 * @typedef {Object} InstallPatcherResult
 * @property {PatchResult[]} patched - Per-install results.
 * @property {string} [wrapper] - Path to the generated cl.sh wrapper.
 * @property {string} warning - EXPERIMENTAL warning / no-install message.
 * @property {string} [note] - Restart + update guidance.
 */

/**
 * Install the EXPERIMENTAL spinner patch across all detected Claude installs and
 * write a self-healing launch wrapper.
 * @param {object} config - Normalized ContextSpin config.
 * @returns {Promise<InstallPatcherResult>}
 */
export async function installPatcher(config) {
  const installs = await findClaudeInstalls();
  if (installs.length === 0) {
    return {
      patched: [],
      warning: "No Claude Code install containing spinner words was found.",
    };
  }

  const words = await buildSpinnerWords(config);

  const patched = [];
  for (const install of installs) {
    try {
      patched.push(await patchInstall(install, words));
    } catch (err) {
      patched.push({
        path: install.path,
        type: install.type,
        patched: false,
        note: `Patch failed: ${err.message}`,
      });
    }
  }

  // Resolve the package root from this module's location (src/inject -> root).
  // Use fileURLToPath (not URL.pathname) so a path containing spaces is
  // percent-DECODED — otherwise the generated patch-run entry imports a path
  // like /Users/me/my%20projects/... that does not exist on disk.
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

  // Write the self-healing wrapper + its entry.
  await fsp.mkdir(STATE_DIR, { recursive: true });
  const patchRunEntry = path.join(STATE_DIR, "patch-run.mjs");
  await fsp.writeFile(patchRunEntry, buildPatchRunEntry(packageRoot));

  const wrapper = path.join(STATE_DIR, "cl.sh");
  await fsp.writeFile(wrapper, buildWrapperScript());
  await fsp.chmod(wrapper, 0o755);

  return {
    patched,
    wrapper,
    warning:
      "EXPERIMENTAL: spinner patching is fragile and may break with Claude Code releases. " +
      "If a binary was skipped, consider the dedicated `claude-depester` tool.",
    note:
      `Claude Code auto-updates OVERWRITE this patch. Launch Claude via the wrapper ` +
      `(${wrapper}) — alias it to \`cl\` — so the patch self-heals on every start. ` +
      `RESTART REQUIRED: a running Claude Code process keeps the old spinner words in ` +
      `memory; fully quit and reopen Claude Code for the patch to take effect.`,
  };
}

/**
 * @typedef {Object} RestorePatcherResult
 * @property {Array<{path:string, restored:boolean, note:string}>} restored
 */

/**
 * Restore every install from its `.contextspin.backup` if present.
 * @returns {Promise<RestorePatcherResult>}
 */
export async function restorePatcher() {
  // Enumerate candidate paths WITHOUT the marker filter: a patched install no
  // longer contains the marker, so findClaudeInstalls() would not see it.
  const results = [];

  for (const target of gatherCandidatePaths()) {
    const backup = target + PATCHER_BACKUP_SUFFIX;
    if (!fs.existsSync(backup)) continue; // only restore what we backed up

    try {
      const mode = (await fsp.stat(target)).mode;
      const data = await fsp.readFile(backup);
      const tmp = target + ".contextspin.tmp";
      await fsp.writeFile(tmp, data);
      await fsp.chmod(tmp, mode);
      await fsp.rename(tmp, target);

      if (process.platform === "darwin" && classifyFile(target) === "binary") {
        try {
          spawnSync("codesign", ["-s", "-", "-f", target], { stdio: "ignore" });
        } catch {
          // best effort
        }
      }

      // Drop the backup after a successful restore so a later patch makes a
      // fresh backup of the (now clean) file.
      try {
        await fsp.unlink(backup);
      } catch {
        // best effort
      }

      results.push({ path: target, restored: true, note: "Restored from backup." });
    } catch (err) {
      results.push({ path: target, restored: false, note: `Restore failed: ${err.message}` });
    }
  }

  return { restored: results };
}
