#!/usr/bin/env bash
# ContextSpin lockstep release.
#
#   ./release.sh 0.6.3
#
# Bumps the npm package and the Claude Code plugin to the SAME version, pins the
# plugin's SessionStart hook to that EXACT version (no drift, no silent
# auto-update), runs tests, commits + pushes both repos, tags + GitHub-releases
# the plugin. It STOPS before `npm publish` and prints the command for you to run
# (so the OTP prompt is yours).
#
# Single source of truth: the npm package. The plugin is a thin wrapper that
# always installs the exact version it was released with.
set -euo pipefail

VERSION="${1:-}"
if ! [[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: ./release.sh <major.minor.patch>   e.g. ./release.sh 0.6.3" >&2
  exit 1
fi

# Resolve repo paths relative to this script (npm repo) + sibling plugin repo.
NPM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${NPM_DIR}/../contextspin-plugin" && pwd)"

GIT_AUTHOR="Hitesh Goel"
GIT_EMAIL="9911848+mannutech@users.noreply.github.com"
gitc() { git -c "user.name=${GIT_AUTHOR}" -c "user.email=${GIT_EMAIL}" "$@"; }

# Small helper: set a top-level "version" in a JSON file via node (no jq dep).
set_json_version() {
  node -e '
    const fs = require("fs");
    const [file, version] = process.argv.slice(1);
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    j.version = version;
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
  ' "$1" "$2"
}

echo "==> Releasing ContextSpin ${VERSION}"

# 1) npm package: bump + test.
echo "--> npm package: bump to ${VERSION}"
set_json_version "${NPM_DIR}/package.json" "${VERSION}"
echo "--> running tests"
( cd "${NPM_DIR}" && node --test >/dev/null ) && echo "    tests passed"

# 2) plugin: bump plugin.json + SKILL metadata, pin every contextspin@<spec>
#    reference (hook + skill commands) to the EXACT version.
echo "--> plugin: bump to ${VERSION} and pin hook to contextspin@${VERSION}"
set_json_version "${PLUGIN_DIR}/.claude-plugin/plugin.json" "${VERSION}"

# Replace any contextspin@<spec> with the exact version across the plugin repo.
node -e '
  const fs = require("fs");
  const [version, ...files] = process.argv.slice(1);
  const re = /contextspin@[^ "`'"'"']+/g;
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const before = fs.readFileSync(f, "utf8");
    const after = before.replace(re, "contextspin@" + version);
    if (after !== before) { fs.writeFileSync(f, after); console.log("    pinned " + f); }
  }
' "${VERSION}" \
  "${PLUGIN_DIR}/hooks/hooks.json" \
  "${PLUGIN_DIR}/skills/contextspin/SKILL.md"

# Bump the SKILL.md frontmatter version line, if present.
node -e '
  const fs = require("fs");
  const [file, version] = process.argv.slice(1);
  if (!fs.existsSync(file)) process.exit(0);
  const s = fs.readFileSync(file, "utf8").replace(/version:\s*"[^"]*"/, `version: "${version}"`);
  fs.writeFileSync(file, s);
' "${PLUGIN_DIR}/skills/contextspin/SKILL.md" "${VERSION}"

# 3) commit + push npm repo.
echo "--> committing npm repo"
( cd "${NPM_DIR}" && gitc add -A && gitc commit -q -m "release: v${VERSION}" && gitc push -q )

# 4) commit + push + tag + release plugin repo.
echo "--> committing plugin repo + tagging contextspin--v${VERSION}"
(
  cd "${PLUGIN_DIR}"
  gitc add -A
  gitc commit -q -m "release: v${VERSION} (pin contextspin@${VERSION})"
  gitc push -q
  gitc tag "contextspin--v${VERSION}"
  gitc push -q origin "contextspin--v${VERSION}"
  gh release create "contextspin--v${VERSION}" \
    --title "contextspin v${VERSION}" \
    --notes "ContextSpin v${VERSION}. Plugin pins contextspin@${VERSION} (exact)."
)

echo
echo "==> Both repos are at ${VERSION} and pushed. Plugin pins contextspin@${VERSION}."
echo "==> FINAL STEP — publish npm (prompts for your OTP):"
echo
echo "    cd \"${NPM_DIR}\" && npm publish --provenance"
echo
