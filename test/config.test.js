// test/config.test.js — unit tests for src/config.js (normalize, validate, load).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

import {
  normalizeConfig,
  validateConfig,
  loadConfig,
  configExists,
  defaultConfig,
  DEFAULTS,
  SOURCE_DEFAULTS,
} from '../src/config.js';

/** Create a unique temp file path inside the OS temp dir. */
function tmpPath(suffix = '.json') {
  return path.join(os.tmpdir(), `contextspin-test-${crypto.randomUUID()}${suffix}`);
}

test('DEFAULTS and SOURCE_DEFAULTS expose the documented shape', () => {
  assert.equal(DEFAULTS.injection.mode, 'statusline');
  assert.equal(DEFAULTS.injection.refresh, 30);
  assert.equal(DEFAULTS.injection.maxVisible, 20);
  assert.equal(DEFAULTS.snippets.deduplication, true);
  assert.equal(DEFAULTS.snippets.cooldownAfterShown, 5);
  assert.deepEqual(DEFAULTS.snippets.priorityOrder, []);
  assert.equal(SOURCE_DEFAULTS.cooldown, 300);
  assert.equal(SOURCE_DEFAULTS.maxSnippets, 2);
});

test('defaultConfig returns the documented shape', () => {
  const sources = [
    { type: 'cli', command: 'echo hi', format: '{{ value }}', label: 'X' },
  ];
  const cfg = defaultConfig(sources);
  // Detected sources come first, followed by the no-credentials starter pack
  // (weather, joke, hackernews) so a fresh install shows live context.
  assert.equal(cfg.sources[0], sources[0]);
  assert.deepEqual(
    cfg.sources.map((s) => s.label),
    ['X', 'weather', 'joke', 'hackernews', 'ai-papers', 'devto', 'quote'],
  );
  assert.deepEqual(cfg.injection, { mode: 'statusline', refresh: 30, maxVisible: 20 });
  assert.equal(cfg.snippets.deduplication, true);
  assert.equal(cfg.snippets.cooldownAfterShown, 5);
  assert.deepEqual(cfg.snippets.priorityOrder, [
    'review',
    'incident',
    'ci',
    'slack',
    'calendar',
    'github',
    'gitlab',
    'jira',
    'weather',
    'joke',
    'hackernews',
    'ai-papers',
    'devto',
    'quote',
  ]);
});

test('defaultConfig tolerates a non-array sources argument', () => {
  // With no detected sources, the config still seeds the starter pack.
  assert.deepEqual(
    defaultConfig(undefined).sources.map((s) => s.label),
    ['weather', 'joke', 'hackernews', 'ai-papers', 'devto', 'quote'],
  );
  assert.deepEqual(
    defaultConfig(null).sources.map((s) => s.label),
    ['weather', 'joke', 'hackernews', 'ai-papers', 'devto', 'quote'],
  );
});

test('defaultConfig output normalizes and validates', () => {
  const cfg = normalizeConfig(
    defaultConfig([{ type: 'cli', command: 'echo hi', format: '{{ value }}' }]),
  );
  assert.equal(validateConfig(cfg), cfg);
  assert.equal(cfg.sources[0].id, 0);
  assert.equal(cfg.injection.mode, 'statusline');
});

test('normalizeConfig fills injection/snippet defaults', () => {
  const out = normalizeConfig({ sources: [{ type: 'cli', command: 'echo hi', format: '{{ value }}' }] });
  assert.equal(out.injection.mode, 'statusline');
  assert.equal(out.injection.refresh, 30);
  assert.equal(out.injection.maxVisible, 20);
  assert.equal(out.snippets.deduplication, true);
  assert.equal(out.snippets.cooldownAfterShown, 5);
});

test('normalizeConfig assigns source.id as the index and applies source defaults', () => {
  const out = normalizeConfig({
    sources: [
      { type: 'cli', command: 'echo a', format: '{{ value }}' },
      { type: 'cli', command: 'echo b', format: '{{ value }}', cooldown: 10, maxSnippets: 9 },
    ],
  });
  assert.equal(out.sources[0].id, 0);
  assert.equal(out.sources[1].id, 1);
  // defaults applied where missing
  assert.equal(out.sources[0].cooldown, 300);
  assert.equal(out.sources[0].maxSnippets, 2);
  // explicit values preserved
  assert.equal(out.sources[1].cooldown, 10);
  assert.equal(out.sources[1].maxSnippets, 9);
});

test('normalizeConfig derives labels by source type', () => {
  const out = normalizeConfig({
    sources: [
      { type: 'mcp', tool: 'slack_search_public', format: '{{ text }}' },
      { type: 'cli', command: 'gh pr list --json title', format: '{{ title }}' },
      { type: 'http', url: 'https://grafana.example.com/api/x?q=1', format: '{{ value }}' },
    ],
  });
  assert.equal(out.sources[0].label, 'slack_search_public'); // mcp -> tool name
  assert.equal(out.sources[1].label, 'gh'); // cli -> first whitespace token of command
  assert.equal(out.sources[2].label, 'grafana.example.com'); // http -> hostname of url
});

test('normalizeConfig keeps an explicitly provided label', () => {
  const out = normalizeConfig({
    sources: [{ type: 'mcp', tool: 'slack_search_public', format: '{{ text }}', label: 'Slack' }],
  });
  assert.equal(out.sources[0].label, 'Slack');
});

test('normalizeConfig does not mutate its input', () => {
  const raw = { sources: [{ type: 'cli', command: 'echo hi', format: '{{ value }}' }] };
  const snapshot = JSON.parse(JSON.stringify(raw));
  normalizeConfig(raw);
  assert.deepEqual(raw, snapshot);
});

test('validateConfig throws when config is not an object', () => {
  assert.throws(() => validateConfig(null));
  assert.throws(() => validateConfig('nope'));
});

test('validateConfig requires sources to be an array, but allows it to be empty', () => {
  // An empty sources array is valid — the daemon and injectors degrade to no
  // snippets, so `ensure` can still wire the statusline and start the daemon.
  assert.doesNotThrow(() => validateConfig({ sources: [] }));
  // Missing or non-array sources is still invalid.
  assert.throws(() => validateConfig({ injection: { mode: 'statusline' } }));
  assert.throws(() => validateConfig({ sources: 'nope' }));
});

test('validateConfig throws on missing or invalid source type', () => {
  assert.throws(() => validateConfig({ sources: [{ format: '{{ x }}' }] }));
  assert.throws(() =>
    validateConfig({ sources: [{ type: 'ftp', format: '{{ x }}' }] }),
  );
});

test('validateConfig throws when required per-type fields are missing', () => {
  assert.throws(() => validateConfig({ sources: [{ type: 'mcp', format: '{{ x }}' }] }));
  assert.throws(() => validateConfig({ sources: [{ type: 'cli', format: '{{ x }}' }] }));
  assert.throws(() => validateConfig({ sources: [{ type: 'http', format: '{{ x }}' }] }));
});

test('validateConfig throws when a source has no format', () => {
  assert.throws(() => validateConfig({ sources: [{ type: 'cli', command: 'echo hi' }] }));
});

test('validateConfig throws on invalid injection.mode', () => {
  assert.throws(() =>
    validateConfig({
      sources: [{ type: 'cli', command: 'echo hi', format: '{{ x }}' }],
      injection: { mode: 'bogus' },
    }),
  );
});

test('validateConfig accepts a valid normalized config and returns it', () => {
  const cfg = normalizeConfig({
    sources: [{ type: 'cli', command: 'echo hi', format: '{{ value }}' }],
  });
  assert.equal(validateConfig(cfg), cfg);
});

test('loadConfig reads and normalizes a temp config file (explicit path arg)', async () => {
  const p = tmpPath();
  const raw = {
    sources: [{ type: 'cli', command: 'gh pr list', format: 'PR {{ title }}' }],
    injection: { mode: 'patcher' },
  };
  fs.writeFileSync(p, JSON.stringify(raw));
  try {
    const cfg = await loadConfig(p);
    assert.equal(cfg.sources[0].id, 0);
    assert.equal(cfg.sources[0].label, 'gh');
    assert.equal(cfg.sources[0].cooldown, 300);
    assert.equal(cfg.injection.mode, 'patcher');
    assert.equal(cfg.injection.refresh, 30);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('loadConfig throws a setup hint when the config file is missing', async () => {
  const p = tmpPath();
  await assert.rejects(() => loadConfig(p), /contextspin setup/);
});

test('loadConfig wraps JSON parse errors with the path', async () => {
  const p = tmpPath();
  fs.writeFileSync(p, '{ not valid json ');
  try {
    await assert.rejects(() => loadConfig(p), (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(p));
      return true;
    });
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('configExists reflects file presence', () => {
  const p = tmpPath();
  assert.equal(configExists(p), false);
  fs.writeFileSync(p, '{}');
  try {
    assert.equal(configExists(p), true);
  } finally {
    fs.rmSync(p, { force: true });
  }
});
