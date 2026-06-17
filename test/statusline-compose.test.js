// test/statusline-compose.test.js — hermetic end-to-end tests of the
// SCOPE-AWARE, NON-DESTRUCTIVE statusline composition.
//
// Test 1 (USER scope): install into a fully TEMP HOME whose user settings.json
// already has a prior statusLine command, then run the GENERATED render script
// and assert:
//   - the prior command's output is printed FIRST (verbatim, multi-line),
//   - the ContextSpin snippet line is printed on its OWN line beneath,
//   - installStatusline reported composed:true and recorded the prior under the
//     "" (user) key of the prev-statusline MAP,
//   - re-running install is idempotent (does not capture our own command).
//
// Test 2 (PROJECT scope): a temp projectDir whose tracked .claude/settings.json
// ships its own statusLine. installStatusline({...},{projectDir}) must:
//   - write OUR wrapper into <projectDir>/.claude/settings.local.json (NOT the
//     user settings.json, which stays untouched),
//   - record the prior in the MAP under the resolved projectDir key,
//   - and the generated render script, given stdin carrying that project dir,
//     runs the prior and prints it ABOVE the review line.
//
// All paths live under a temp HOME + CONTEXTSPIN_CONFIG/CONTEXTSPIN_CACHE
// overrides, so the real ~/.claude is never touched. Because the path constants
// in src/config.js are resolved at module load, install + render both run in
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

/** Run a node --input-type=module -e script in a child with a temp env. */
function runNode(script, env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    encoding: 'utf8',
  });
}

test('installStatusline composes a prior USER statusline above the ContextSpin line', () => {
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
        { text: 'CONTEXTSPIN-SNIPPET', source: 'review', sourceId: 0, fetchedAt: new Date().toISOString(), shownCount: 0 },
      ],
    }),
  );

  try {
    // (1) Install — must report composed:true and record the prior under "".
    const installScript = `
      import { installStatusline } from ${JSON.stringify(path.join(SRC, 'inject', 'statusline.js'))};
      import { loadConfig } from ${JSON.stringify(path.join(SRC, 'config.js'))};
      const cfg = await loadConfig();
      const res = await installStatusline(cfg);
      process.stdout.write(JSON.stringify({ composed: res.composed, backedUp: res.backedUp, scope: res.scope, sh: res.statuslineSh, js: res.statuslineJs, settings: res.settingsPath }));
    `;
    const installRes = runNode(installScript, env);
    assert.equal(installRes.status, 0, `install failed: ${installRes.stderr}`);
    const info = JSON.parse(installRes.stdout);
    assert.equal(info.composed, true, 'expected composed:true');
    assert.equal(info.backedUp, true, 'expected settings backup');
    assert.equal(info.scope, 'user', 'expected user scope');
    assert.equal(info.settings, path.join(claudeDir, 'settings.json'));

    // prev-statusline.json is now a MAP; the user prior lives under "".
    const prevPath = path.join(home, '.contextspin', 'prev-statusline.json');
    assert.ok(fs.existsSync(prevPath), 'expected prev-statusline.json');
    const prevMap = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
    assert.equal(prevMap[''].command, priorCmd);
    assert.equal(prevMap[''].type, 'command');

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
    const csIdx = out.indexOf('CONTEXTSPIN-SNIPPET');
    assert.equal(out[csIdx - 1], '\n', 'ContextSpin line must be on its own line');

    // (3) Re-running install is idempotent and does not capture our own wrapper.
    const reinstall = runNode(installScript, env);
    assert.equal(reinstall.status, 0, `reinstall failed: ${reinstall.stderr}`);
    const prevMap2 = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
    assert.equal(prevMap2[''].command, priorCmd, 'prev command must be unchanged after re-run');
    // Still exactly one (user) entry — never recorded our own wrapper.
    assert.deepEqual(Object.keys(prevMap2), ['']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('installStatusline is SCOPE-AWARE: project repo statusLine composed via settings.local.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextspin-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'contextspin-proj-'));
  const configPath = path.join(home, 'config.json');
  const cachePath = path.join(home, 'cache.json');
  const userClaudeDir = path.join(home, '.claude');
  const projClaudeDir = path.join(project, '.claude');
  fs.mkdirSync(userClaudeDir, { recursive: true });
  fs.mkdirSync(projClaudeDir, { recursive: true });

  const env = {
    ...process.env,
    HOME: home,
    CONTEXTSPIN_CONFIG: configPath,
    CONTEXTSPIN_CACHE: cachePath,
  };

  // The repo ships its OWN statusLine in the TRACKED project settings.json.
  const repoCmd = `${process.execPath} -e "process.stdout.write('REPO-BAR')"`;
  fs.writeFileSync(
    path.join(projClaudeDir, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: repoCmd } }),
  );

  // The user settings.json has an UNRELATED statusLine that must NOT be touched
  // (it is shadowed by the project, and project scope must not rewrite it).
  const userCmd = `${process.execPath} -e "process.stdout.write('USER-BAR')"`;
  fs.writeFileSync(
    path.join(userClaudeDir, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: userCmd }, theme: 'dark' }),
  );

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
        { text: 'REVIEW-LINE', source: 'review', sourceId: 0, fetchedAt: new Date().toISOString(), shownCount: 0 },
      ],
    }),
  );

  try {
    const installScript = `
      import { installStatusline } from ${JSON.stringify(path.join(SRC, 'inject', 'statusline.js'))};
      import { loadConfig } from ${JSON.stringify(path.join(SRC, 'config.js'))};
      const cfg = await loadConfig();
      const res = await installStatusline(cfg, { projectDir: ${JSON.stringify(project)} });
      process.stdout.write(JSON.stringify({ composed: res.composed, scope: res.scope, settings: res.settingsPath, js: res.statuslineJs }));
    `;
    const installRes = runNode(installScript, env);
    assert.equal(installRes.status, 0, `install failed: ${installRes.stderr}`);
    const info = JSON.parse(installRes.stdout);
    assert.equal(info.scope, 'project', 'expected project scope');
    assert.equal(info.composed, true, 'expected composed:true (repo statusLine wrapped)');

    // OUR wrapper went into the project's gitignored settings.local.json.
    // installStatusline canonicalizes the project dir with realpath, so compare
    // against the realpath'd location (symlinked tmp roots: /var vs /private/var).
    const localPath = path.join(fs.realpathSync(project), '.claude', 'settings.local.json');
    assert.equal(info.settings, localPath, 'must write project settings.local.json');
    assert.ok(fs.existsSync(localPath), 'expected settings.local.json');
    const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const wrapper = path.join(home, '.contextspin', 'statusline.sh');
    assert.equal(local.statusLine.command, wrapper, 'settings.local.json points at our wrapper');

    // The repo's TRACKED settings.json is UNCHANGED.
    const tracked = JSON.parse(fs.readFileSync(path.join(projClaudeDir, 'settings.json'), 'utf8'));
    assert.equal(tracked.statusLine.command, repoCmd, 'tracked project settings must be untouched');

    // The USER settings.json is UNCHANGED (project scope never rewrites it).
    const user = JSON.parse(fs.readFileSync(path.join(userClaudeDir, 'settings.json'), 'utf8'));
    assert.equal(user.statusLine.command, userCmd, 'user settings must be untouched');
    assert.equal(user.theme, 'dark', 'user settings other keys preserved');

    // The prior is recorded in the MAP under the RESOLVED project dir.
    const prevPath = path.join(home, '.contextspin', 'prev-statusline.json');
    const prevMap = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
    const key = fs.realpathSync(project);
    // path.resolve does not resolve symlinks; macOS tmpdir may be a symlink, so
    // match the recorded key against either the raw or realpath'd project dir.
    const recorded = prevMap[project] || prevMap[key];
    assert.ok(recorded, `expected prev entry under project dir; got keys ${JSON.stringify(Object.keys(prevMap))}`);
    assert.equal(recorded.command, repoCmd);

    // The render script, given stdin carrying THIS project dir, runs the repo's
    // prior and prints it ABOVE the review line.
    const recordedKey = prevMap[project] ? project : key;
    const render = spawnSync(process.execPath, [info.js], {
      env,
      input: JSON.stringify({ workspace: { project_dir: recordedKey } }),
      encoding: 'utf8',
    });
    assert.equal(render.status, 0, `render exited ${render.status}: ${render.stderr}`);
    const out = render.stdout;
    assert.ok(out.includes('REPO-BAR'), `missing repo prior output: ${JSON.stringify(out)}`);
    assert.ok(out.includes('REVIEW-LINE'), 'missing ContextSpin review line');
    assert.ok(
      out.indexOf('REPO-BAR') < out.indexOf('REVIEW-LINE'),
      'review line must come after the repo statusline output',
    );
    assert.ok(!out.includes('USER-BAR'), 'must run the project prior, not the user one');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
