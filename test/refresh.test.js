// test/refresh.test.js — runRefreshOnce (the daemonless one-shot) must honor
// per-source cooldowns across separate runs via cache.meta.lastRun, and persist
// snippets for sources that are not yet due. Runs in a child because config
// paths bind to env at module load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(HERE, '..', 'src', 'daemon.js');

test('runRefreshOnce polls due sources, records lastRun, and respects cooldown on re-run', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextspin-refresh-'));
  const cfg = path.join(home, 'cfg.json');
  const cache = path.join(home, 'cache.json');
  const counter = path.join(home, 'runs.log');

  // A cli source that appends a line each time it actually runs, then emits a
  // JSON record. High cooldown so the 2nd refresh must skip it.
  const command = `sh -c 'echo x >> ${counter}; echo "{\\"text\\":\\"hello\\"}"'`;
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      sources: [{ type: 'cli', command, format: '{{text}}', label: 'probe', cooldown: 9999 }],
      injection: { mode: 'statusline' },
    }),
  );

  const env = { ...process.env, HOME: home, CONTEXTSPIN_CONFIG: cfg, CONTEXTSPIN_CACHE: cache };
  const run = () =>
    spawnSync(
      process.execPath,
      ['--input-type=module', '-e',
        `import { runRefreshOnce } from ${JSON.stringify(DAEMON)}; await runRefreshOnce({});`],
      { env, encoding: 'utf8' },
    );

  const r1 = run();
  assert.equal(r1.status, 0, `first refresh failed: ${r1.stderr}`);
  const c1 = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.deepEqual(c1.snippets.map((s) => s.text), ['hello']);
  assert.ok(c1.meta && c1.meta.lastRun && c1.meta.lastRun['0'] > 0, 'lastRun recorded for source 0');

  const r2 = run();
  assert.equal(r2.status, 0, `second refresh failed: ${r2.stderr}`);
  // Cooldown not elapsed -> the command must NOT have run a second time.
  const runs = fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length;
  assert.equal(runs, 1, 'source should not be re-polled within its cooldown');
  // Snippet is preserved across the (skipped) refresh.
  const c2 = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.deepEqual(c2.snippets.map((s) => s.text), ['hello']);

  fs.rmSync(home, { recursive: true, force: true });
});
