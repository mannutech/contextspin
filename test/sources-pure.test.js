// test/sources-pure.test.js — pure-function tests for jqPath (http.js) and expandEnv (mcp.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jqPath } from '../src/sources/http.js';
import { expandEnv } from '../src/sources/mcp.js';

test('jqPath identity returns the input unchanged', () => {
  const data = { a: 1 };
  assert.deepEqual(jqPath(data, '.'), data);
});

test('jqPath resolves a simple dot key', () => {
  assert.equal(jqPath({ a: 42 }, '.a'), 42);
});

test('jqPath resolves nested dot keys', () => {
  assert.equal(jqPath({ a: { b: { c: 'deep' } } }, '.a.b.c'), 'deep');
});

test('jqPath resolves a bracket index', () => {
  assert.equal(jqPath({ a: ['x', 'y', 'z'] }, '.a[0]'), 'x');
  assert.deepEqual(jqPath({ results: [{ value: 1 }] }, '.results[0]'), { value: 1 });
});

test('jqPath maps a key over an iterated array (.a[].b)', () => {
  const data = { a: [{ b: 1 }, { b: 2 }, { b: 3 }] };
  assert.deepEqual(jqPath(data, '.a[].b'), [1, 2, 3]);
});

test('jqPath supports pipe chaining left to right', () => {
  const data = { a: { b: [10, 20] } };
  assert.equal(jqPath(data, '.a | .b[1]'), 20);
});

test('jqPath returns the input unchanged for an unsupported expression', () => {
  const data = { a: 1 };
  // A jq function call is outside the supported subset -> passthrough,
  // and it must never throw.
  let result;
  assert.doesNotThrow(() => {
    result = jqPath(data, 'map(.x)');
  });
  assert.deepEqual(result, data);
});

test('expandEnv expands dollar-brace VAR', () => {
  assert.equal(expandEnv('${FOO}', { FOO: 'bar' }), 'bar');
  assert.equal(expandEnv('pre-${FOO}-post', { FOO: 'bar' }), 'pre-bar-post');
});

test('expandEnv uses the default form ${VAR:-default} when unset or empty', () => {
  assert.equal(expandEnv('${MISSING:-fallback}', {}), 'fallback');
  assert.equal(expandEnv('${EMPTY:-fallback}', { EMPTY: '' }), 'fallback');
  assert.equal(expandEnv('${SET:-fallback}', { SET: 'value' }), 'value');
});

test('expandEnv expands bare dollar VAR', () => {
  assert.equal(expandEnv('$HOME/x', { HOME: '/home/me' }), '/home/me/x');
});

test('expandEnv returns non-strings unchanged', () => {
  assert.equal(expandEnv(42, {}), 42);
  assert.equal(expandEnv(undefined, {}), undefined);
  const obj = { a: 1 };
  assert.equal(expandEnv(obj, {}), obj);
});
