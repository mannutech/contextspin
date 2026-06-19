// test/uninstall-all.test.js — uninstallAllStatuslines tears down EVERY wired
// scope (user + each project the hook touched), via the wired registry. Runs in
// a child process because the path constants in src/config.js bind to HOME at
// module load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SL = path.join(HERE, '..', 'src', 'inject', 'statusline.js');

test('uninstallAllStatuslines removes the statusline from user + all project scopes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextspin-ua-'));
  const projA = path.join(home, 'projA');
  const projB = path.join(home, 'projB');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(projB, { recursive: true });

  const env = {
    ...process.env,
    HOME: home,
    CONTEXTSPIN_CONFIG: path.join(home, 'config.json'),
    CONTEXTSPIN_CACHE: path.join(home, 'cache.json'),
  };

  const script = `
    import { installStatusline, uninstallAllStatuslines } from ${JSON.stringify(SL)};
    const cfg = { injection: { refresh: 30 } };
    await installStatusline(cfg);                                  // user scope
    await installStatusline(cfg, { projectDir: ${JSON.stringify(projA)} });
    await installStatusline(cfg, { projectDir: ${JSON.stringify(projB)} });
    const results = await uninstallAllStatuslines();
    process.stdout.write(JSON.stringify({ removed: results.filter(r => r && r.removed).length }));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `child failed: ${res.stderr}`);
  const out = JSON.parse(res.stdout);

  // All three scopes were torn down.
  assert.equal(out.removed, 3);

  // The registry file is consumed (deleted) after a full teardown.
  assert.equal(
    fs.existsSync(path.join(home, '.contextspin', 'wired-statuslines.json')),
    false,
    'wired registry should be removed',
  );

  // No settings file still points at our wrapper.
  const sh = path.join(home, '.contextspin', 'statusline.sh');
  const targets = [
    path.join(home, '.claude', 'settings.json'),
    path.join(projA, '.claude', 'settings.local.json'),
    path.join(projB, '.claude', 'settings.local.json'),
  ];
  for (const f of targets) {
    if (!fs.existsSync(f)) continue;
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.notEqual(
      s.statusLine && s.statusLine.command,
      sh,
      `${f} still points at the ContextSpin wrapper`,
    );
  }

  fs.rmSync(home, { recursive: true, force: true });
});
