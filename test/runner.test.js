// test/runner.test.js — unit tests for src/runner.js (runSource over a cli source).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSource } from '../src/runner.js';

const NODE = process.execPath;

/** Build a `node -e '<script>'` command string safe for shell:true. */
function nodeEval(script) {
  return `${NODE} -e '${script}'`;
}

test('runSource maps cli JSON records through format and snippet shape', async () => {
  const script = 'process.stdout.write(JSON.stringify([{n:1},{n:2},{n:3}]))';
  const source = {
    type: 'cli',
    command: nodeEval(script),
    format: '#{{ n }}',
    label: 'Nums',
    id: 7,
    maxSnippets: 10,
  };
  const snippets = await runSource(source, {});
  assert.equal(snippets.length, 3);
  assert.deepEqual(
    snippets.map((s) => s.text),
    ['#1', '#2', '#3'],
  );
  for (const s of snippets) {
    assert.equal(s.source, 'Nums');
    assert.equal(s.sourceId, 7);
    assert.equal(s.shownCount, 0);
    assert.equal(typeof s.fetchedAt, 'string');
    // fetchedAt is a valid ISO timestamp
    assert.ok(!Number.isNaN(Date.parse(s.fetchedAt)));
  }
});

test('runSource honors maxSnippets by slicing the result', async () => {
  const script = 'process.stdout.write(JSON.stringify([{n:1},{n:2},{n:3},{n:4}]))';
  const source = {
    type: 'cli',
    command: nodeEval(script),
    format: '#{{ n }}',
    label: 'Nums',
    id: 0,
    maxSnippets: 2,
  };
  const snippets = await runSource(source, {});
  assert.equal(snippets.length, 2);
  assert.deepEqual(
    snippets.map((s) => s.text),
    ['#1', '#2'],
  );
});

test('runSource drops records that fail the filter', async () => {
  const script =
    'process.stdout.write(JSON.stringify([{status:"failure",name:"a"},{status:"success",name:"b"},{status:"failure",name:"c"}]))';
  const source = {
    type: 'cli',
    command: nodeEval(script),
    filter: '{{ status }} == failure',
    format: 'CI {{ name }}',
    label: 'CI',
    id: 1,
    maxSnippets: 10,
  };
  const snippets = await runSource(source, {});
  assert.deepEqual(
    snippets.map((s) => s.text),
    ['CI a', 'CI c'],
  );
});

test('runSource skips records whose formatted text is blank', async () => {
  const script = 'process.stdout.write(JSON.stringify([{n:1},{n:null},{n:2}]))';
  const source = {
    type: 'cli',
    command: nodeEval(script),
    format: '{{ n }}',
    label: 'Nums',
    id: 2,
    maxSnippets: 10,
  };
  const snippets = await runSource(source, {});
  // the middle record formats to "" and is skipped
  assert.deepEqual(
    snippets.map((s) => s.text),
    ['1', '2'],
  );
});
