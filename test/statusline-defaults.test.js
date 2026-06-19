// test/statusline-defaults.test.js — the generated render script must NEVER be
// empty: with an empty cache it falls back to the built-in DEFAULT_SNIPPETS, and
// it must run + exit 0 on every supported Node version (this is the test that
// guards the .mjs/ESM regression that only surfaced on Node 18).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SL = path.join(HERE, '..', 'src', 'inject', 'statusline.js');

/** Strip ANSI escape codes for content assertions. */
function plain(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

test('generated render script is never empty (empty cache -> rotating default) and exits 0', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextspin-def-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const configPath = path.join(home, 'config.json');
  const cachePath = path.join(home, 'cache.json');
  fs.writeFileSync(configPath, JSON.stringify({ sources: [], injection: { mode: 'statusline' } }));

  const env = {
    ...process.env,
    HOME: home,
    CONTEXTSPIN_CONFIG: configPath,
    CONTEXTSPIN_CACHE: cachePath,
  };

  // Install (writes the generated render script) in a child so config paths bind.
  const install = spawnSync(
    process.execPath,
    ['--input-type=module', '-e',
      `import { installStatusline } from ${JSON.stringify(SL)};
       const r = await installStatusline({ injection: { refresh: 30 } });
       process.stdout.write(r.statuslineJs);`],
    { env, encoding: 'utf8' },
  );
  assert.equal(install.status, 0, `install failed: ${install.stderr}`);
  const renderPath = install.stdout.trim();
  assert.ok(renderPath.endsWith('.mjs'), `render script must be .mjs, got ${renderPath}`);

  // Run the generated render script directly (no daemon, empty cache).
  const r1 = spawnSync(process.execPath, [renderPath], { env, input: '{}', encoding: 'utf8' });
  assert.equal(r1.status, 0, `render exited ${r1.status}: ${r1.stderr}`);
  assert.notEqual(plain(r1.stdout).trim(), '', 'render must not be empty with an empty cache');

  // Second render should rotate to a DIFFERENT default (never-repeating feel).
  const r2 = spawnSync(process.execPath, [renderPath], { env, input: '{}', encoding: 'utf8' });
  assert.equal(r2.status, 0);
  assert.notEqual(
    plain(r1.stdout).trim(),
    plain(r2.stdout).trim(),
    'consecutive default renders should rotate',
  );

  fs.rmSync(home, { recursive: true, force: true });
});

test('injection.style:false renders plain text (no ANSI)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextspin-def-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const configPath = path.join(home, 'config.json');
  const cachePath = path.join(home, 'cache.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ sources: [], injection: { mode: 'statusline', style: false } }),
  );

  const env = {
    ...process.env,
    HOME: home,
    CONTEXTSPIN_CONFIG: configPath,
    CONTEXTSPIN_CACHE: cachePath,
  };

  const install = spawnSync(
    process.execPath,
    ['--input-type=module', '-e',
      `import { installStatusline } from ${JSON.stringify(SL)};
       const r = await installStatusline({ injection: { refresh: 30, style: false } });
       process.stdout.write(r.statuslineJs);`],
    { env, encoding: 'utf8' },
  );
  assert.equal(install.status, 0, `install failed: ${install.stderr}`);

  const r = spawnSync(process.execPath, [install.stdout.trim()], { env, input: '{}', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.trim().length > 0, 'still non-empty');
  // No ANSI escape codes when style is disabled.
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(r.stdout, /\[/, 'should contain no ANSI when style:false');

  fs.rmSync(home, { recursive: true, force: true });
});
