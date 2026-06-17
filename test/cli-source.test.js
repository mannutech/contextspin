// test/cli-source.test.js — unit tests for src/sources/cli.js (fetchCli parsing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCli } from '../src/sources/cli.js';

// We drive the cli source with `node -e "<script>"` so output is fully
// deterministic and hermetic (no external binaries, no network). fetchCli
// spawns with shell:true, so we quote the -e script in single quotes and use
// only double quotes inside the script.
const NODE = process.execPath;

/** Build a `node -e '<script>'` command string safe for shell:true. */
function nodeEval(script) {
  // Wrap the script in single quotes; the scripts below avoid single quotes.
  return `${NODE} -e '${script}'`;
}

test('fetchCli parses a JSON array of objects, keeping objects as-is', async () => {
  const script = 'process.stdout.write(JSON.stringify([{number:1,title:"a"},{number:2,title:"b"}]))';
  const records = await fetchCli({ command: nodeEval(script) }, {});
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], { number: 1, title: 'a' });
  assert.deepEqual(records[1], { number: 2, title: 'b' });
});

test('fetchCli wraps primitive array elements as {value,text}', async () => {
  const script = 'process.stdout.write(JSON.stringify([10,20]))';
  const records = await fetchCli({ command: nodeEval(script) }, {});
  assert.deepEqual(records, [
    { value: 10, text: '10' },
    { value: 20, text: '20' },
  ]);
});

test('fetchCli wraps a single JSON object into a one-element array', async () => {
  const script = 'process.stdout.write(JSON.stringify({status:"failure",name:"build"}))';
  const records = await fetchCli({ command: nodeEval(script) }, {});
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], { status: 'failure', name: 'build' });
});

test('fetchCli wraps a single JSON primitive into [{value,text}]', async () => {
  const script = 'process.stdout.write(JSON.stringify(42))';
  const records = await fetchCli({ command: nodeEval(script) }, {});
  assert.deepEqual(records, [{ value: 42, text: '42' }]);
});

test('fetchCli falls back to non-empty lines when stdout is not JSON', async () => {
  const script = 'process.stdout.write("line one\\nline two\\n\\nline three\\n")';
  const records = await fetchCli({ command: nodeEval(script) }, {});
  assert.deepEqual(records, [
    { text: 'line one', line: 'line one', value: 'line one' },
    { text: 'line two', line: 'line two', value: 'line two' },
    { text: 'line three', line: 'line three', value: 'line three' },
  ]);
});

test('fetchCli returns [] for empty stdout', async () => {
  const script = 'process.stdout.write("   ")';
  const records = await fetchCli({ command: nodeEval(script) }, {});
  assert.deepEqual(records, []);
});

test('fetchCli throws with exit code on non-zero exit', async () => {
  const script = 'process.stderr.write("boom"); process.exit(3)';
  await assert.rejects(
    () => fetchCli({ command: nodeEval(script) }, {}),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /cli source failed/);
      assert.match(err.message, /exit 3/);
      return true;
    },
  );
});
