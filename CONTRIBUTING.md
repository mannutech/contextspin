# Contributing to ContextSpin

Thanks for helping out. ContextSpin is intentionally small and dependency-light; please keep it that way.

## Development setup

You need **Node.js >= 18** (the code relies on the built-in global `fetch`).

```bash
git clone <your-fork-url> contextspin
cd contextspin
npm install
npm test
```

`npm install` pulls a single runtime dependency (`commander`) plus the optional `node-lief` (used only by the experimental patcher — everything works without it). `npm test` runs the test suite with `node --test`.

Handy scripts:

```bash
npm start            # node src/cli.js  (run the CLI from source)
npm run daemon       # node src/daemon-entry.js  (run the poll loop in the foreground)
```

## File structure

```
contextspin/
├── package.json
├── .contextspin.example.json     # seed config copied by `setup`
├── LICENSE
├── README.md
├── CONTRIBUTING.md
├── src/
│   ├── cli.js                    # commander entrypoint (bin)
│   ├── config.js                 # PATH constants, defaults, load/validate/normalize/save
│   ├── formatter.js              # getPath, interpolate, applyFilter (safe, no eval)
│   ├── runner.js                 # runSource: dispatch -> filter -> format -> Snippet
│   ├── daemon.js                 # cache read/write, mergeSnippets, poll loop, detach/stop
│   ├── daemon-entry.js           # detached entrypoint that calls runDaemonLoop
│   ├── sources/
│   │   ├── cli.js                # fetchCli  (spawn shell, parse stdout)
│   │   ├── http.js               # fetchHttp + jqPath (minimal jq subset)
│   │   └── mcp.js                # fetchMcp + discoverMcpServers + expandEnv (stdio JSON-RPC)
│   └── inject/
│       ├── statusline.js         # install/uninstall statusline.sh + settings.json patch
│       └── patcher.js            # EXPERIMENTAL binary/text spinner-word patcher
└── test/
    ├── formatter.test.js
    ├── config.test.js
    ├── cli-source.test.js
    ├── runner.test.js
    ├── daemon-merge.test.js
    └── sources-pure.test.js
```

All filesystem paths (`CONFIG_PATH`, `CACHE_PATH`, `STATE_DIR`, etc.) are defined and exported **only** from `src/config.js`. Every other module imports them from there — never hard-code a path.

## Adding a new source type

A source type is one async fetch function that turns a source config into a list of plain-object records. To add one (say `foo`):

1. **Create `src/sources/foo.js`.** Export `async fetchFoo(source, opts)`. It must return `Array<object>` — one record per item. Accept an `opts` object and honor `opts.timeoutMs` (default to a sane value) so the daemon can't hang. Throw a clear `Error` on failure; the runner lets it propagate. Reuse the normalization convention of the existing sources (array → elements, object → single record, primitive → `{ value, text }`).
2. **Wire it into `src/runner.js`.** Import `fetchFoo` and add a branch to `runSource`'s dispatch on `source.type`. The runner already handles filtering (`applyFilter`), formatting (`interpolate(source.format, record)`), the empty-text skip, `maxSnippets` slicing, and Snippet shaping — your function only produces records.
3. **Extend validation in `src/config.js`.** Add `foo` to the allowed `type` set in `validateConfig`, throw on any required field your type needs (mirror how `mcp`/`cli`/`http` require `tool`/`command`/`url`), and add a `label` derivation in `normalizeConfig`.
4. **Add tests** under `test/` for the pure parts (parsing, normalization) and for `runSource` over the new type. Keep them hermetic — no network.
5. **Document it** in the README's "Source types" section with a JSON example using `{{ }}` templating.

Keep `fetchFoo` pure-ish where possible and free of global state, so it's easy to test.

## Code style

- **ESM only.** `package.json` has `"type": "module"`; use `import` / `export`. No CommonJS.
- **No TypeScript syntax.** Plain JavaScript. Use **JSDoc** on every export to document parameters and return types.
- **`commander` is the only allowed runtime dependency** (`node-lief` is an optional dep used solely by `src/inject/patcher.js` behind a guarded dynamic import — all code must work without it). Do **not** add other dependencies, and do **not** pull in `@modelcontextprotocol/sdk`; the MCP client is hand-rolled over stdio. Everything else comes from Node built-ins (`node:fs`, `node:path`, `node:os`, `node:child_process`, `node:readline/promises`, `node:crypto`, …).
- **Small, focused functions** with clear, actionable `Error` messages.
- Each file starts with a **one-line comment** naming the file and its role.
- Match the simple, approachable tone of the existing code.

## Running and writing tests

```bash
npm test                          # run everything (node --test)
node --test test/formatter.test.js  # run one file
```

Tests use `node:test` and `node:assert/strict`. Guidelines:

- **Hermetic and offline.** No network calls. For `cli`/`http`/`mcp`, drive behavior with local fixtures — e.g. spawn `process.execPath -e "<script that prints JSON>"` for CLI tests.
- **Use temp files**, built from `os.tmpdir()` + a `crypto` random suffix, and clean them up. To exercise config loading, set `process.env.CONTEXTSPIN_CONFIG` to a temp path **before importing `src/config.js`**, or pass the path argument explicitly.
- **Don't import `src/cli.js`** from tests — keep tests independent of commander and side effects. Test the underlying functions directly.
- Cover the pure logic thoroughly: `getPath`/`interpolate`/`applyFilter`, `normalizeConfig`/`validateConfig`, `jqPath`/`expandEnv`, `mergeSnippets`, and the source parsers.

## Pull requests

- One focused change per PR. Keep the diff small.
- `npm test` must pass, and add tests for any new behavior or bug fix.
- Update the README when you change user-facing behavior, config fields, or CLI commands.
- Don't add dependencies or introduce TypeScript.
- Stay within the current stage's scope — see the roadmap in the README. Features beyond Stage 1 (non-stdio MCP transports, OAuth connectors, etc.) are explicitly out of scope for now.
- Describe what changed and why, and note anything you couldn't test.

By contributing you agree your contributions are licensed under the project's MIT license.
