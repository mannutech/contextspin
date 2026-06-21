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

test('uninstall cleans a CROSS-MACHINE stale wrapper (devcontainer path) in the current project', () => {
  // Simulates: ContextSpin was wired inside a devcontainer (HOME=/home/node),
  // writing `/home/node/.contextspin/statusline.sh` into a project's gitignored
  // settings.local.json. The project dir is mounted onto the host (this temp
  // HOME), but the host's wired registry knows NOTHING about it, and the host's
  // STATUSLINE_SH path differs. Running uninstall FROM that project dir must
  // still recognize the alien-path wrapper as ours and remove it — otherwise the
  // higher-precedence settings.local.json silently masks the tracked statusLine.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextspin-xm-'));
  const proj = path.join(home, 'repo');
  const projClaude = path.join(proj, '.claude');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(projClaude, { recursive: true });

  // The tracked statusline the user actually wants back once ours is gone.
  fs.writeFileSync(
    path.join(projClaude, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: '.claude/statusline-command.sh' } }),
  );
  // The stale, foreign-HOME ContextSpin wrapper left in settings.local.json.
  const staleWrapper = '/home/node/.contextspin/statusline.sh';
  fs.writeFileSync(
    path.join(projClaude, 'settings.local.json'),
    JSON.stringify({ statusLine: { type: 'command', command: staleWrapper }, theme: 'dark' }),
  );
  // A backup that ALSO carries a stale wrapper must not be restored (would just
  // re-introduce a broken path).
  fs.writeFileSync(
    path.join(projClaude, 'settings.local.json.contextspin.bak'),
    JSON.stringify({ statusLine: { type: 'command', command: staleWrapper } }),
  );

  const env = {
    ...process.env,
    HOME: home,
    CONTEXTSPIN_CONFIG: path.join(home, 'config.json'),
    CONTEXTSPIN_CACHE: path.join(home, 'cache.json'),
  };

  // Run uninstall with cwd = the project dir, NO registry entry for it.
  const script = `
    import { uninstallAllStatuslines } from ${JSON.stringify(SL)};
    const results = await uninstallAllStatuslines();
    process.stdout.write(JSON.stringify({ removed: results.filter(r => r && r.removed).length }));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    cwd: proj,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `child failed: ${res.stderr}`);

  // The stale wrapper is gone from settings.local.json (other keys preserved).
  const local = JSON.parse(
    fs.readFileSync(path.join(projClaude, 'settings.local.json'), 'utf8'),
  );
  assert.equal(local.statusLine, undefined, 'stale statusLine must be removed');
  assert.equal(local.theme, 'dark', 'unrelated keys must be preserved');

  // The tracked settings.json is untouched, so it takes over again.
  const tracked = JSON.parse(
    fs.readFileSync(path.join(projClaude, 'settings.json'), 'utf8'),
  );
  assert.equal(tracked.statusLine.command, '.claude/statusline-command.sh');

  // The misleading stale backup was discarded, not restored.
  assert.equal(
    fs.existsSync(path.join(projClaude, 'settings.local.json.contextspin.bak')),
    false,
    'stale backup should be discarded',
  );

  fs.rmSync(home, { recursive: true, force: true });
});
