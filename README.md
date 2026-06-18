# ContextSpin

Live context in your Claude Code **status bar** — weather, the top Hacker News story, PRs awaiting your review, CI failures, incidents, meetings — pulled from tools you already run. Install in one line; the bar is never empty.

```bash
curl -fsSL https://raw.githubusercontent.com/mannutech/contextspin/main/install.sh | bash
```

## Key principle: ContextSpin does NOT fetch data

ContextSpin is a **compositor and renderer, not a data layer.** It has no API clients, no auth flows, and no integrations of its own. Instead it **aggregates from sources you already have**:

- **existing MCP servers** registered in your `~/.claude.json` / `.mcp.json`
- **CLI tools** already installed and authenticated on your machine (`gh`, `kubectl`, `aws`, your own scripts…)
- **HTTP endpoints** you can already reach (internal dashboards, status APIs)

ContextSpin polls those sources on a schedule, formats whatever they return into short one-line snippets, and injects the most relevant one into the Claude Code status bar. If a piece of data isn't reachable by a tool you already have, ContextSpin cannot show it — by design. The only runtime dependency is [`commander`](https://www.npmjs.com/package/commander).

## Architecture

```
  ┌─────────────────────────────────────────────────────────┐
  │  SOURCES  (things you already have)                       │
  │                                                           │
  │   mcp   ──►  stdio MCP servers from ~/.claude.json        │
  │   cli   ──►  shell commands (gh, kubectl, scripts...)     │
  │   http  ──►  HTTP/JSON endpoints you can reach            │
  └───────────────────────────┬─────────────────────────────┘
                              │  poll on per-source cooldown
                              ▼
  ┌─────────────────────────────────────────────────────────┐
  │  POLLING DAEMON  (detached background process)            │
  │   • runs each source, applies filter + format             │
  │   • merges / dedups / prioritizes snippets                │
  │   • writes  ~/.contextspin-cache.json   (atomic)          │
  └───────────────────────────┬─────────────────────────────┘
                              │  read cache
                              ▼
  ┌─────────────────────────────────────────────────────────┐
  │  INJECTOR  (statusline — non-destructive, composed)       │
  │   statusline  ──►  ~/.contextspin/statusline.sh           │
  │                    composed into ~/.claude/settings.json   │
  │   patcher     ──►  rewrites spinner words (EXPERIMENTAL)   │
  └───────────────────────────┬─────────────────────────────┘
                              │
                              ▼
            Claude Code status bar shows one snippet
```

The daemon and the injector are decoupled by the cache file: the daemon writes snippets, the injector reads them. Each runs on its own clock.

## Install

Requires Node.js >= 18 (ContextSpin uses the built-in global `fetch`).

**One line — that's it:**

```bash
curl -fsSL https://raw.githubusercontent.com/mannutech/contextspin/main/install.sh | bash
```

This wires a SessionStart hook into `~/.claude/settings.json` (so ContextSpin self-heals every session), seeds a no-credentials starter pack (weather, a dad joke, the top Hacker News story), and wires your status bar — non-destructively. Restart Claude Code and you'll see live snippets, never an empty bar.

Prefer to do it yourself? `npx contextspin install` does the same thing. To remove everything: `npx contextspin uninstall`.

<details>
<summary>Manual / advanced setup</summary>

```bash
npx contextspin setup     # create a config (add --yes to skip prompts)
npx contextspin start     # start the background polling daemon
npx contextspin inject    # wire snippets into the status bar
```

Running `npx contextspin` with **no subcommand** is a shortcut: if no config exists it runs `setup`, otherwise it runs `start` followed by `inject` using the mode from your config.

</details>

Check what's happening at any time:

```bash
npx contextspin status
```

## Source types

Every source produces a list of records. Each record is run through an optional `filter`, then rendered with `format` using **double-curly-brace** field templating (`{{ field }}`). Inner whitespace is allowed. Dotted and bracketed paths work (`{{ results[0].value }}`), and `{{ env.NAME }}` resolves to an environment variable. Unknown fields render as the empty string.

### `mcp` — call a tool on an existing MCP server

Calls a tool on a **stdio** MCP server discovered from your Claude config. ContextSpin speaks JSON-RPC 2.0 over the server's stdin/stdout itself — no SDK, no extra dependency.

```json
{
  "type": "mcp",
  "tool": "slack_search_public",
  "args": { "query": "mentions:me is:unread" },
  "format": "Slack: {{ text }}",
  "label": "Slack",
  "cooldown": 300,
  "maxSnippets": 2
}
```

- `tool` is required. You may pass a bare tool name (`slack_search_public`) or the fully-qualified `mcp__<server>__<tool>` form; the `mcp__<server>__` prefix is stripped to find the raw tool and to infer which server to use.
- `server` is optional. If omitted and the tool name doesn't encode it, ContextSpin connects to each stdio server, lists its tools, and uses the first one that exposes the tool.
- `args` is passed straight through as the tool-call arguments.

### `cli` — run a shell command

```json
{
  "type": "cli",
  "command": "gh pr list --review-requested @me --json title,number --limit 3",
  "format": "PR #{{ number }} needs your review: {{ title }}",
  "label": "GitHub",
  "cooldown": 120,
  "maxSnippets": 3
}
```

The command runs through your shell. Output parsing is forgiving:

- a **JSON array** → each element becomes a record (objects kept as-is; primitives wrapped as `{ value, text }`)
- a **JSON object** → a single record
- a **JSON primitive** → `{ value, text }`
- **anything else** → split into non-empty lines, each becoming `{ text, line, value }`

A non-zero exit throws; a configurable timeout (default 15s) protects against hangs.

### `http` — fetch a JSON (or text) endpoint

```json
{
  "type": "http",
  "url": "https://grafana.example.com/api/datasources/proxy/1/query?q=incidents",
  "headers": { "Authorization": "Bearer {{ env.GRAFANA_TOKEN }}" },
  "jq": ".results[0].value",
  "format": "Grafana: {{ value }}",
  "label": "Grafana",
  "cooldown": 30,
  "maxSnippets": 1
}
```

- `url` and header values are interpolated, so you can inject secrets with `{{ env.X }}` instead of hard-coding them.
- `method` defaults to `GET`; a `body` object is JSON-stringified with the right content-type.
- `jq` accepts a **minimal jq subset**: identity `.`, dotted keys (`.a.b`), bracket indexing (`.a[0]`), iteration (`.[]`, `.a[]`), and left-to-right pipes (`a | b`). Unsupported expressions pass the data through unchanged rather than erroring.

## Configuration

ContextSpin reads one JSON file: `~/.contextspin.json` (override with the `CONTEXTSPIN_CONFIG` environment variable). The cache lives at `~/.contextspin-cache.json` (override with `CONTEXTSPIN_CACHE`).

```json
{
  "sources": [
    { "type": "cli", "command": "gh pr list --json title --limit 3", "format": "PR: {{ title }}" }
  ],
  "injection": {
    "mode": "statusline",
    "refresh": 30,
    "maxVisible": 5
  },
  "snippets": {
    "deduplication": true,
    "cooldownAfterShown": 3,
    "priorityOrder": ["incident", "ci", "slack", "calendar", "github", "jira"]
  }
}
```

### Field reference

| Field | Type | Format / values | Default | Meaning |
|-------|------|-----------------|---------|---------|
| `sources` | array | — | `[]` | Sources to poll. May be empty (the bar then shows the built-in defaults). |
| `sources[].type` | string | `mcp` \| `cli` \| `http` | — | Source kind. Required. |
| `sources[].tool` | string | tool name or `mcp__server__tool` | — | Required for `mcp`. |
| `sources[].command` | string | shell command | — | Required for `cli`. |
| `sources[].url` | string | URL (templated) | — | Required for `http`. |
| `sources[].format` | string | `{{ field }}` template | — | One-line render template. Required. |
| `sources[].filter` | string | `LEFT OP RIGHT` | — | Optional. Keep a record only if it passes. See below. |
| `sources[].label` | string | free text | derived | Shown as the snippet source. Derived if omitted: mcp→tool name, cli→first command token, http→hostname. |
| `sources[].cooldown` | number | seconds | `300` | Minimum seconds between polls of this source. |
| `sources[].maxSnippets` | number | count | `2` | Max snippets kept from one poll of this source. |
| `injection.mode` | string | `statusline` \| `patcher` \| `both` | `statusline` | How snippets reach the UI. |
| `injection.refresh` | number | seconds | `30` | Daemon poll interval and status-line refresh interval (seconds). |
| `injection.maxVisible` | number | count | `5` | Global cap on snippets held in the cache. |
| `injection.style` | boolean | — | `true` | Render the line in a styled box (cyan bars + italic). Set `false` for plain text. |
| `snippets.deduplication` | boolean | — | `true` | Drop snippets with duplicate text when merging. |
| `snippets.cooldownAfterShown` | number | count | `3` | A snippet stops being eligible once shown this many times. |
| `snippets.priorityOrder` | string[] | source labels | `[]` | Earlier labels sort first (case-insensitive); unlisted sort last. |

### Filters

`filter` is a **single, safe comparison** — no `eval`, no `Function`. The whole expression is interpolated against the record first, then parsed as `LEFT OP RIGHT` where `OP` is one of `==`, `!=`, `>=`, `<=`, `>`, `<`, or the word `includes`. Both numeric sides compare numerically; otherwise they compare as strings (`==` / `!=` are loose). `includes` is substring containment. With no operator, the result is truthy unless it's empty, `false`, or `0`.

```json
{ "filter": "{{ status }} == failure" }
```

Only one comparison is supported — there is no `&&` / `||`.

## Injection modes

### `statusline` (recommended, official)

This is the supported path. It uses Claude Code's official [status line](https://code.claude.com/docs/en/statusline) feature, so it survives Claude Code updates.

`contextspin inject` (mode `statusline`) will:

1. Write `~/.contextspin/statusline-render.js` — a self-contained script that drains stdin (so Claude Code's piped JSON can't cause `EPIPE`), reads the cache, picks the eligible snippet with the lowest `shownCount` (then most recent), increments its count, writes the cache back, and prints that one line. Any error exits cleanly with no output, so it can never break your status bar.
2. Write `~/.contextspin/statusline.sh` — a `0755` bash wrapper that `exec`s the render script.
3. Point `statusLine` at that wrapper (refresh in **seconds**), **non-destructively**: any status line you already had is preserved and *composed* — the render script runs your prior command and prints its output **above** the ContextSpin line. Scope-aware: in a project (when `CLAUDE_PROJECT_DIR` is set) it writes the gitignored `<project>/.claude/settings.local.json`, which outranks a repo's tracked `settings.json`, so a project's own status line can't shadow ContextSpin.

Reverse it with `contextspin uninject` (this scope) or `contextspin uninstall` (every scope it ever wired, plus the hook and daemon).

### `patcher` (EXPERIMENTAL — binary patching)

> ⚠️ **Experimental and fragile.** Inspired by [claude-depester](https://github.com/ominiverdi/claude-depester). It rewrites the hard-coded spinner words (`Flibbertigibbeting`, `Discombobulating`, …) inside the Claude Code binary/bundle with your live snippets.

Key facts:

- It is **length-preserving**: the replacement is padded with spaces so the file size never changes. If your snippets don't fit, words are trimmed until they do.
- It works on both **text** (`cli.js`) and **compiled binary** installs, located by scanning the usual install paths and keeping only files that actually contain the marker word.
- A **restart of Claude Code is required** for the patch to take effect.
- **Claude Code updates overwrite the patch.** The installer also writes a wrapper at `~/.contextspin/cl.sh` that re-applies the patch and then `exec`s `claude`. After every Claude Code update you must re-patch — using that wrapper is the easiest way.
- On macOS it makes a best-effort `codesign` re-sign after patching.

Restore the originals with `contextspin uninject --mode patcher` (or `inject --mode both` / `uninject --mode both` to do both at once). A backup with the suffix `.contextspin.backup` is created before any install is touched.

## Daemon and cache

`contextspin start` spawns a **detached** background process (the daemon). It writes its PID to `~/.contextspin/daemon.pid` and logs to `~/.contextspin/daemon.log`. The loop:

1. For each source whose `cooldown` has elapsed, runs it, applies the filter, formats records, and slices to `maxSnippets`.
2. Merges the fresh snippets into the existing set: preserves `shownCount` for matching text, optionally dedups, sorts by `priorityOrder` then by recency, and caps to `injection.maxVisible`.
3. Atomically writes the cache, then sleeps `injection.refresh` seconds.

`stop` / `restart` manage the process; `status` reports whether it's running and lists the current snippets.

### Cache file format (`~/.contextspin-cache.json`)

```json
{
  "updatedAt": "2026-06-17T09:00:00.000Z",
  "snippets": [
    {
      "text": "CI failing: build on main",
      "source": "CI",
      "sourceId": 2,
      "fetchedAt": "2026-06-17T09:00:00.000Z",
      "shownCount": 0
    }
  ]
}
```

`shownCount` is incremented by the status-line renderer each time a snippet is displayed; once it reaches `cooldownAfterShown` the snippet is no longer shown.

## CLI commands

| Command | What it does |
|---------|--------------|
| `contextspin install` | **One-shot install:** wire a self-healing SessionStart hook, create the config, wire the statusline, and start the daemon. (This is what the curl script runs.) |
| `contextspin uninstall` | **Full teardown:** remove the hook, restore your prior statusline in **every** scope it wired, and stop the daemon. |
| `contextspin setup [--yes]` | Create `~/.contextspin.json` (interactive, or a detected config with `--yes` / non-TTY). |
| `contextspin start` | Start the detached polling daemon. |
| `contextspin stop` | Stop the daemon. |
| `contextspin restart` | Stop then start. |
| `contextspin status` | Show daemon state and the current cached snippets (source, age, shown count). |
| `contextspin ensure` | Idempotent: create config + wire statusline + start daemon (run by the SessionStart hook each session). |
| `contextspin inject [--mode <m>]` | Install just the injector. `<m>` overrides `injection.mode` (`statusline` / `patcher` / `both`). |
| `contextspin uninject [--mode <m>]` | Reverse just the injector. |
| `contextspin` *(no subcommand)* | `setup` if unconfigured, otherwise `start` then `inject`. |

## High-impact snippets

Three tiers, by how time-sensitive they are.

### Tier 1 — time-sensitive (act in minutes)

```json
{ "type": "cli", "command": "gh run list --json status,name,headBranch --limit 5",
  "filter": "{{ status }} == failure",
  "format": "CI failing: {{ name }} on {{ headBranch }}", "label": "CI", "cooldown": 60, "maxSnippets": 2 }
```

```json
{ "type": "http", "url": "https://grafana.example.com/api/datasources/proxy/1/query?q=incidents",
  "headers": { "Authorization": "Bearer {{ env.GRAFANA_TOKEN }}" },
  "jq": ".results[0].value", "format": "Grafana: {{ value }}", "label": "Grafana", "cooldown": 30, "maxSnippets": 1 }
```

### Tier 2 — ambient ops (good to know)

```json
{ "type": "mcp", "tool": "slack_search_public", "args": { "query": "mentions:me is:unread" },
  "format": "Slack: {{ text }}", "label": "Slack", "cooldown": 300, "maxSnippets": 2 }
```

```json
{ "type": "mcp", "tool": "notion-search", "args": { "query": "assigned:me status:open" },
  "format": "Notion: {{ text }}", "label": "Notion", "cooldown": 300, "maxSnippets": 2 }
```

### Tier 3 — work queue (your to-do)

```json
{ "type": "cli", "command": "gh pr list --review-requested @me --json title,number --limit 3",
  "format": "PR #{{ number }} needs your review: {{ title }}", "label": "GitHub", "cooldown": 120, "maxSnippets": 3 }
```

## Limitations

- **MCP support is stdio-only.** ContextSpin discovers MCP servers from `~/.claude.json` (user and per-project scopes) and `.mcp.json`, and connects only to **stdio** servers (those with a `command`). HTTP / SSE / WebSocket MCP transports are not supported — use a `cli` or `http` source instead. Plugin / managed scopes are ignored.
- **OAuth-based claude.ai connectors are not reachable.** App-connected connectors (Slack, Notion, etc. linked through claude.ai) authenticate via OAuth tokens stored in the OS keychain. A standalone background daemon has no access to those tokens, so it cannot drive those connectors. Use the corresponding CLI (`gh`, `slack` CLI…) or HTTP endpoint, or a locally-configured stdio MCP server, instead.
- **The status line shows one rotating snippet** at a time, honoring `cooldownAfterShown` so the same item doesn't repeat indefinitely.
- **The patcher is experimental** and is **overwritten by every Claude Code update**. Treat it as best-effort; the statusline mode is the supported path.

## Zero-config defaults (never an empty bar)

A fresh install needs no setup:

- The config is seeded with a **no-credentials starter pack** — local weather, a dad joke, and the top Hacker News story — so real snippets appear within seconds.
- When the cache is empty or every snippet is exhausted, the renderer falls back to **built-in defaults** (jokes + "ask `/contextspin`…" tips) that rotate, so the bar is never blank — even offline or before the first poll.
- A Claude Code **plugin** is also available (the [`mannutech` marketplace](https://github.com/mannutech/claude-plugins)) for those who prefer installing that way — it wraps this same package.

## References

- claude-depester (patcher inspiration): https://github.com/ominiverdi/claude-depester
- Claude Code status line docs: https://code.claude.com/docs/en/statusline
- Claude Code spinner issues: [#10420](https://github.com/anthropics/claude-code/issues/10420), [#13725](https://github.com/anthropics/claude-code/issues/13725), [#22668](https://github.com/anthropics/claude-code/issues/22668), [#27766](https://github.com/anthropics/claude-code/issues/27766), [#27976](https://github.com/anthropics/claude-code/issues/27976)

## License

MIT. See [LICENSE](./LICENSE).
