// test/hook.test.js — unit tests for the SessionStart hook manager (install/uninstall flow).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sessionStartHookCmd,
  entryRunsContextspin,
  addSessionStartHook,
  removeSessionStartHook,
} from '../src/inject/hook.js';

/** Make a temp settings.json path inside a fresh dir. */
function tmpSettings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextspin-hook-'));
  return { dir, file: path.join(dir, 'settings.json') };
}

function readHooks(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionStart;
}

test('sessionStartHookCmd pins the EXACT version (never @latest or a range)', () => {
  const cmd = sessionStartHookCmd('0.6.3');
  assert.match(cmd, /contextspin@0\.6\.3 /);
  assert.doesNotMatch(cmd, /@latest|\^|~/);
  // Runs from a neutral dir to avoid the local-package Exit 127 trap.
  assert.match(cmd, /^cd \/tmp &&/);
});

test('entryRunsContextspin detects our entry, ignores others', () => {
  assert.equal(
    entryRunsContextspin({ hooks: [{ command: 'cd /tmp && npx contextspin ensure' }] }),
    true,
  );
  assert.equal(entryRunsContextspin({ hooks: [{ command: 'echo hi' }] }), false);
  assert.equal(entryRunsContextspin({}), false);
  assert.equal(entryRunsContextspin(null), false);
});

test('addSessionStartHook writes a pinned hook into a fresh settings file', () => {
  const { dir, file } = tmpSettings();
  try {
    const changed = addSessionStartHook('0.6.3', file);
    assert.equal(changed, true);
    const arr = readHooks(file);
    assert.equal(arr.length, 1);
    assert.equal(arr[0].hooks[0].command, sessionStartHookCmd('0.6.3'));
    assert.equal(arr[0].hooks[0].timeout, 15);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('addSessionStartHook is idempotent for the same version', () => {
  const { dir, file } = tmpSettings();
  try {
    assert.equal(addSessionStartHook('0.6.3', file), true);
    assert.equal(addSessionStartHook('0.6.3', file), false); // no change
    assert.equal(readHooks(file).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('addSessionStartHook upserts (re-pins) when the version changes', () => {
  const { dir, file } = tmpSettings();
  try {
    addSessionStartHook('0.6.2', file);
    const changed = addSessionStartHook('0.6.3', file);
    assert.equal(changed, true);
    const arr = readHooks(file);
    // exactly one ContextSpin entry, now pinned to the new version
    assert.equal(arr.length, 1);
    assert.equal(arr[0].hooks[0].command, sessionStartHookCmd('0.6.3'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('addSessionStartHook preserves other settings keys and foreign hooks', () => {
  const { dir, file } = tmpSettings();
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        permissions: { allow: ['Bash'] },
        hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo other' }] }] },
      }),
    );
    addSessionStartHook('0.6.3', file);
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(settings.permissions, { allow: ['Bash'] });
    const cmds = settings.hooks.SessionStart.flatMap((e) => e.hooks.map((h) => h.command));
    assert.ok(cmds.includes('echo other'), 'foreign hook preserved');
    assert.ok(cmds.some((c) => c.includes('contextspin@0.6.3')), 'our hook added');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeSessionStartHook removes only our entry and prunes empty containers', () => {
  const { dir, file } = tmpSettings();
  try {
    addSessionStartHook('0.6.3', file);
    assert.equal(removeSessionStartHook(file), true);
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    // hooks container pruned when it becomes empty
    assert.equal(settings.hooks, undefined);
    // second remove is a no-op
    assert.equal(removeSessionStartHook(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeSessionStartHook keeps foreign hooks intact', () => {
  const { dir, file } = tmpSettings();
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo other' }] }] },
      }),
    );
    addSessionStartHook('0.6.3', file);
    removeSessionStartHook(file);
    const arr = JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionStart;
    const cmds = arr.flatMap((e) => e.hooks.map((h) => h.command));
    assert.deepEqual(cmds, ['echo other']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
