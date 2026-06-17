// test/detect.test.js — unit tests for src/detect.js (detectSources).
// Hermetic: no network. detectSources only probes PATH with `<tool> --version`;
// whatever the host has installed, it must always return a usable starter set.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectSources } from '../src/detect.js';
import { normalizeConfig, validateConfig, defaultConfig } from '../src/config.js';

test('detectSources returns a non-empty array of source objects', async () => {
  const sources = await detectSources();
  assert.ok(Array.isArray(sources));
  assert.ok(sources.length > 0, 'expected at least one detected source');
});

test('detected sources are valid cli sources with no ids', async () => {
  const sources = await detectSources();
  for (const src of sources) {
    assert.equal(src.type, 'cli');
    assert.equal(typeof src.command, 'string');
    assert.ok(src.command.length > 0);
    assert.equal(typeof src.format, 'string');
    assert.ok(src.format.length > 0);
    assert.equal(typeof src.label, 'string');
    assert.equal(typeof src.cooldown, 'number');
    assert.equal(typeof src.maxSnippets, 'number');
    // normalizeConfig assigns ids; detect must not.
    assert.equal('id' in src, false);
  }
});

test('detected format/filter strings use the double-curly-brace token syntax', async () => {
  const sources = await detectSources();
  // At least one source carries a {{ token }} placeholder in its format.
  const hasToken = sources.some((s) => /\{\{[^}]+\}\}/.test(s.format));
  assert.ok(hasToken, 'expected at least one {{ token }} in a detected format');
  // Any filter present must also use the token syntax.
  for (const s of sources) {
    if (s.filter !== undefined) {
      assert.match(s.filter, /\{\{[^}]+\}\}/);
    }
  }
});

test('detected sources pass validateConfig once wrapped + normalized', async () => {
  const sources = await detectSources();
  const cfg = normalizeConfig(defaultConfig(sources));
  // Should not throw; returns the same object.
  assert.equal(validateConfig(cfg), cfg);
  // Each source got an id from normalizeConfig.
  cfg.sources.forEach((s, i) => assert.equal(s.id, i));
});

test('detectSources tolerates a short timeout without throwing', async () => {
  // Even with an aggressive timeout, the probes are swallowed and a usable
  // placeholder set is returned.
  const sources = await detectSources({ timeoutMs: 1 });
  assert.ok(Array.isArray(sources));
  assert.ok(sources.length > 0);
});
