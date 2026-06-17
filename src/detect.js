// src/detect.js — best-effort, zero-network detection of the single starter source.
//
// ContextSpin has ONE job: show "review requests waiting on you" — the PRs/MRs
// where you are the requested reviewer — in the Claude Code statusline. We seed
// exactly one source for that, using whichever code-host CLI is already on PATH
// (and already authenticated), so there is zero token/secret setup.
//
// Detection heuristic (all local, no secrets, no network):
//   - We probe PATH for the `gh` (GitHub CLI) and `glab` (GitLab CLI) binaries
//     using a short, swallowed child-process check (`<tool> --version`). Anything
//     that errors, times out, or exits non-zero is treated as "not present".
//   - If `gh` is present we seed the GitHub "review requested of you" source.
//   - Else if `glab` is present we seed the GitLab equivalent.
//   - If NEITHER is present we still return the `gh` source as a graceful
//     placeholder. cli sources fail gracefully per-source in the daemon runner,
//     so a missing binary just yields no snippets rather than breaking anything —
//     and the config is then a working template the user can edit.
//
// All format strings use the double-curly-brace token syntax understood by
// src/formatter.js. The returned source object has NO `id` — normalizeConfig
// assigns ids by index.

import { spawn } from "node:child_process";

/**
 * Best-effort check whether a binary is on PATH by running `<tool> --version`.
 * Swallows every failure (missing binary, non-zero exit, timeout, spawn error)
 * and resolves to a boolean. Never throws.
 *
 * @param {string} tool - The binary name to probe (e.g. "gh").
 * @param {number} [timeoutMs=2000] - Kill the probe after this long.
 * @returns {Promise<boolean>}
 */
function hasBinary(tool, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(tool, ["--version"], { stdio: "ignore" });
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      done(false);
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

/** The GitHub "review requests waiting on you" source. */
function ghSource() {
  return {
    type: "cli",
    command: "gh pr list --review-requested @me --json number,title --limit 5",
    format: "👀 review #{{ number }}: {{ title }}",
    label: "review",
    cooldown: 120,
    maxSnippets: 3,
  };
}

/** The GitLab "review requests waiting on you" source. */
function glabSource() {
  return {
    type: "cli",
    command: "glab mr list --reviewer=@me --output json --per-page 5",
    format: "👀 review !{{ iid }}: {{ title }}",
    label: "review",
    cooldown: 120,
    maxSnippets: 3,
  };
}

/**
 * Detect the single safe, read-only starter source from the local environment.
 *
 * Best-effort and side-effect-free beyond local `<tool> --version` probes (no
 * network). See the file header for the detection heuristic. Always returns a
 * non-empty array holding exactly one source object WITHOUT an id
 * (normalizeConfig assigns ids).
 *
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function detectSources(opts = {}) {
  const timeoutMs = opts.timeoutMs;

  // Probe both CLIs in parallel; each probe swallows its own failures.
  const [gh, glab] = await Promise.all([
    hasBinary("gh", timeoutMs),
    hasBinary("glab", timeoutMs),
  ]);

  if (gh) return [ghSource()];
  if (glab) return [glabSource()];

  // Neither present: return the gh source as a graceful, gracefully-failing
  // placeholder the user can edit.
  return [ghSource()];
}

export default detectSources;
