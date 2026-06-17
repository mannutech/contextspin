// test/ensure.test.js — hermetic test of the `contextspin ensure` config bootstrap.
//
// We run the CLI as a child process with a fully TEMP HOME plus
// CONTEXTSPIN_CONFIG / CONTEXTSPIN_CACHE overrides, so it can never touch the
// real ~/.claude, ~/.contextspin.json, or the real daemon. To keep the run
// hermetic we PRE-SEED state so only the config-bootstrap branch does work:
//   - a daemon.pid file containing THIS test process's pid (alive) so
//     isDaemonRunning() is true and no daemon is ever spawned;
//   - a settings.json whose statusLine already points at our wrapper so the
//     statusline-wiring branch is skipped.
// We then assert the config file was created with a valid detected shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.js');

test('ensure creates a config when none exists (hermetic, no daemon/settings touched)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextspin-home-'));
  const configPath = path.join(home, 'config.json');
  const cachePath = path.join(home, 'cache.json');

  const stateDir = path.join(home, '.contextspin');
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });

  // Pre-seed a live daemon pid (our own) so ensure never spawns a daemon.
  fs.writeFileSync(path.join(stateDir, 'daemon.pid'), String(process.pid));

  // Pre-seed settings whose statusLine already points at our wrapper so the
  // statusline-wiring branch is a no-op.
  const wrapper = path.join(stateDir, 'statusline.sh');
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: wrapper } }),
  );

  try {
    const res = spawnSync(process.execPath, [CLI, 'ensure'], {
      env: {
        ...process.env,
        HOME: home,
        CONTEXTSPIN_CONFIG: configPath,
        CONTEXTSPIN_CACHE: cachePath,
      },
      encoding: 'utf8',
    });

    // ensure must always exit 0 (the SessionStart hook depends on this).
    assert.equal(res.status, 0, `ensure exited ${res.status}: ${res.stderr}`);

    // The config-bootstrap branch must have written a config file.
    assert.ok(fs.existsSync(configPath), 'expected config to be created');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(Array.isArray(cfg.sources) && cfg.sources.length > 0);
    assert.equal(cfg.injection.mode, 'statusline');
    // normalizeConfig assigned ids.
    cfg.sources.forEach((s, i) => assert.equal(s.id, i));

    // The settings.json statusLine must be UNCHANGED (still our pre-seeded one;
    // ensure did not rewrite it because it was already ours).
    const settings = JSON.parse(
      fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'),
    );
    assert.equal(settings.statusLine.command, wrapper);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ensure is idempotent: a second run reports already set up', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextspin-home-'));
  const configPath = path.join(home, 'config.json');
  const cachePath = path.join(home, 'cache.json');
  const stateDir = path.join(home, '.contextspin');
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'daemon.pid'), String(process.pid));
  const wrapper = path.join(stateDir, 'statusline.sh');
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: wrapper } }),
  );

  // Pre-write a valid config so the bootstrap branch is skipped.
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      sources: [{ type: 'cli', command: 'echo hi', format: '{{ value }}' }],
      injection: { mode: 'statusline' },
    }),
  );

  try {
    const res = spawnSync(process.execPath, [CLI, 'ensure'], {
      env: {
        ...process.env,
        HOME: home,
        CONTEXTSPIN_CONFIG: configPath,
        CONTEXTSPIN_CACHE: cachePath,
      },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `ensure exited ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /already set up/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
