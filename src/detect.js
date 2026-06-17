// src/detect.js — best-effort, zero-network detection of safe starter sources.
//
// Detection heuristics (all local, no secrets, no network):
//   - We probe PATH for the `gh` (GitHub CLI), `glab` (GitLab CLI), and
//     `kubectl` binaries using a short, swallowed child-process check
//     (`<tool> --version`). Anything that errors, times out, or exits non-zero
//     is treated as "not present".
//   - If `gh` is present we seed two GitHub sources: PRs that requested your
//     review, and failing CI runs.
//   - Else if `glab` is present we seed the GitLab equivalents.
//   - If NEITHER `gh` nor `glab` is present we still return the `gh` pair as a
//     sensible placeholder. cli sources fail gracefully per-source in the
//     daemon runner, so a missing binary just yields no snippets rather than
//     breaking anything — and the config is then a working template the user
//     can edit.
//   - `kubectl` is probed for future use / informational purposes; we do not
//     seed a kubectl source today because a safe, universally-meaningful
//     read-only query is cluster-specific.
//
// All format/filter strings use the double-curly-brace token syntax understood
// by src/formatter.js. Returned source objects have NO `id` — normalizeConfig
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

/** The GitHub starter pair (PRs needing review + failing CI). */
function ghSources() {
  return [
    {
      type: "cli",
      command:
        "gh pr list --review-requested @me --json title,number --limit 3",
      format: "PR #{{ number }} needs review: {{ title }}",
      label: "GitHub",
      cooldown: 120,
      maxSnippets: 3,
    },
    {
      type: "cli",
      command: "gh run list --json status,name,headBranch --limit 5",
      filter: "{{ status }} == failure",
      format: "CI failing: {{ name }} on {{ headBranch }}",
      label: "CI",
      cooldown: 60,
      maxSnippets: 2,
    },
  ];
}

/** The GitLab starter pair (MRs needing review + failing CI). */
function glabSources() {
  return [
    {
      type: "cli",
      command: "glab mr list --reviewer=@me --output json --per-page 3",
      format: "MR !{{ iid }} needs review: {{ title }}",
      label: "GitLab",
      cooldown: 120,
      maxSnippets: 3,
    },
    {
      type: "cli",
      command: "glab ci list --status failed --output json --per-page 5",
      format: "CI failed: {{ ref }} (#{{ id }})",
      label: "CI",
      cooldown: 60,
      maxSnippets: 2,
    },
  ];
}

/**
 * Detect a set of safe, read-only starter sources from the local environment.
 *
 * Best-effort and side-effect-free beyond local `<tool> --version` probes (no
 * network). See the file header for the detection heuristics. Always returns a
 * non-empty array of source objects WITHOUT ids (normalizeConfig assigns ids).
 *
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function detectSources(opts = {}) {
  const timeoutMs = opts.timeoutMs;

  // Probe the three tools in parallel; each probe swallows its own failures.
  const [gh, glab /*, kubectl */] = await Promise.all([
    hasBinary("gh", timeoutMs),
    hasBinary("glab", timeoutMs),
    hasBinary("kubectl", timeoutMs),
  ]);

  if (gh) return ghSources();
  if (glab) return glabSources();

  // Neither present: return the gh pair as a sensible, gracefully-failing
  // placeholder the user can edit.
  return ghSources();
}

export default detectSources;
