// test/statusline-compose.test.js — hermetic end-to-end test of the
// NON-DESTRUCTIVE statusline composition.
//
// We install the statusline into a fully TEMP HOME that already has a prior
// statusLine command, then run the GENERATED render script and assert:
//   - the prior command's output is printed FIRST (verbatim),
//   - the ContextSpin snippet line is printed on its OWN line beneath,
//   - installStatusline reported composed:true and recorded prev-statusline.json,
//   - re-running install is idempotent (does not capture our own command).
//
// All paths live under a temp HOME + CONTEXTSPIN_CONFIG/CONTEXTSPIN_CACHE
// overrides, so the real ~/.claude is never touched. Because the path constants
// in src/config.js are resolved at module load, the install + render both run in
// CHILD processes with the env set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

/** Run a node -e script in a child with a temp HOME + config/cache env. */
function runNode(script, env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    encoding: 'utf8',
  });
}

test('installStatusline composes a prior statusline above the ContextSpin line', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextspin-sl-'));
  const configPath = path.join(home, 'config.json');
  const cachePath = path.join(home, 'cache.json');
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const env = {
    ...process.env,
    HOME: home,
    CONTEXTSPIN_CONFIG: configPath,
    CONTEXTSPIN_CACHE: cachePath,
  };

  // A prior statusline command that prints two lines (multi-line must survive).
  const priorCmd = `${process.execPath} -e "process.stdout.write('MYBAR-LINE-1\\nMYBAR-LINE-2')"`;
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: priorCmd } }),
  );

  // A config + cache so the ContextSpin line has something to show.
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      sources: [{ type: 'cli', command: 'echo hi', format: '{{ value }}' }],
      injection: { mode: 'statusline', refresh: 30 },
      snippets: { cooldownAfterShown: 3 },
    }),
  );
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      snippets: [
        { text: 'CONTEXTSPIN-SNIPPET', source: 'X', sourceId: 0, fetchedAt: new Date().toISOString(), shownCount: 0 },
      ],
    }),
  );

  try {
    // (1) Install — must report composed:true and record prev-statusline.json.
    const installScript = `
      import { installStatusline } from ${JSON.stringify(path.join(SRC, 'inject', 'statusline.js'))};
      import { normalizeConfig, loadConfig } from ${JSON.stringify(path.join(SRC, 'config.js'))};
      const cfg = await loadConfig();
      const res = await installStatusline(cfg);
      process.stdout.write(JSON.stringify({ composed: res.composed, backedUp: res.backedUp, sh: res.statuslineSh, js: res.statuslineJs }));
    `;
    const installRes = runNode(installScript, env);
    assert.equal(installRes.status, 0, `install failed: ${installRes.stderr}`);
    const info = JSON.parse(installRes.stdout);
    assert.equal(info.composed, true, 'expected composed:true');
    assert.equal(info.backedUp, true, 'expected settings backup');

    // prev-statusline.json must record the prior command verbatim.
    const prevPath = path.join(home, '.contextspin', 'prev-statusline.json');
    assert.ok(fs.existsSync(prevPath), 'expected prev-statusline.json');
    const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
    assert.equal(prev.command, priorCmd);
    assert.equal(prev.type, 'command');

    // (2) Run the GENERATED render script directly (pipe Claude-like JSON stdin).
    const render = spawnSync(process.execPath, [info.js], {
      env,
      input: JSON.stringify({ model: { id: 'x' }, workspace: {} }),
      encoding: 'utf8',
    });
    assert.equal(render.status, 0, `render exited ${render.status}: ${render.stderr}`);

    const out = render.stdout;
    // Prior output appears FIRST and verbatim (both lines).
    assert.ok(out.includes('MYBAR-LINE-1'), `missing prior line 1: ${JSON.stringify(out)}`);
    assert.ok(out.includes('MYBAR-LINE-2'), `missing prior line 2: ${JSON.stringify(out)}`);
    // ContextSpin line appears AFTER the prior output, on its own line.
    assert.ok(out.includes('CONTEXTSPIN-SNIPPET'), 'missing ContextSpin line');
    assert.ok(
      out.indexOf('MYBAR-LINE-2') < out.indexOf('CONTEXTSPIN-SNIPPET'),
      'ContextSpin line must come after the prior statusline output',
    );
    // The ContextSpin snippet is on a line of its own (preceded by a newline).
    const csIdx = out.indexOf('CONTEXTSPIN-SNIPPET');
    assert.equal(out[csIdx - 1], '\n', 'ContextSpin line must be on its own line');

    // (3) Re-running install is idempotent and does not capture our own wrapper.
    const reinstall = runNode(installScript, env);
    assert.equal(reinstall.status, 0, `reinstall failed: ${reinstall.stderr}`);
    const prev2 = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
    assert.equal(prev2.command, priorCmd, 'prev command must be unchanged after re-run');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
