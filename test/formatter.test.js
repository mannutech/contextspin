// test/formatter.test.js — unit tests for src/formatter.js (getPath, interpolate, applyFilter).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPath, interpolate, applyFilter } from '../src/formatter.js';

test('getPath resolves nested object keys', () => {
  const data = { a: { b: { c: 42 } } };
  assert.equal(getPath(data, 'a.b.c'), 42);
});

test('getPath resolves array index with bracket notation', () => {
  const data = { results: [{ value: 'first' }, { value: 'second' }] };
  assert.equal(getPath(data, 'results[0].value'), 'first');
  assert.equal(getPath(data, 'results[1].value'), 'second');
});

test('getPath resolves mixed dot and bracket path a.b[0].c', () => {
  const data = { a: { b: [{ c: 'deep' }] } };
  assert.equal(getPath(data, 'a.b[0].c'), 'deep');
});

test('getPath returns undefined when any segment is missing', () => {
  const data = { a: { b: 1 } };
  assert.equal(getPath(data, 'a.x.y'), undefined);
  assert.equal(getPath(data, 'a.b[2]'), undefined);
  assert.equal(getPath(data, 'missing'), undefined);
});

test('interpolate substitutes a simple field', () => {
  assert.equal(interpolate('Hello {{ name }}', { name: 'World' }), 'Hello World');
});

test('interpolate tolerates inner spaces around the token', () => {
  assert.equal(interpolate('#{{number}}', { number: 7 }), '#7');
  assert.equal(interpolate('#{{   number   }}', { number: 7 }), '#7');
});

test('interpolate resolves env.NAME tokens against the supplied env', () => {
  const out = interpolate('token={{ env.MY_TOKEN }}', {}, { MY_TOKEN: 'secret' });
  assert.equal(out, 'token=secret');
});

test('interpolate renders missing values as empty string', () => {
  assert.equal(interpolate('x={{ nope }}', {}), 'x=');
  assert.equal(interpolate('x={{ a.b.c }}', { a: {} }), 'x=');
});

test('interpolate stringifies non-string values', () => {
  assert.equal(interpolate('{{ n }}', { n: 0 }), '0');
  assert.equal(interpolate('{{ b }}', { b: false }), 'false');
  assert.equal(interpolate('{{ ok }}', { ok: true }), 'true');
});

test('interpolate renders null/undefined fields as empty string', () => {
  assert.equal(interpolate('[{{ v }}]', { v: null }), '[]');
  assert.equal(interpolate('[{{ v }}]', { v: undefined }), '[]');
});

test('applyFilter returns true for falsy filter expression (no-op)', () => {
  assert.equal(applyFilter('', { status: 'failure' }), true);
  assert.equal(applyFilter(undefined, { x: 1 }), true);
  assert.equal(applyFilter(null, {}), true);
});

test('applyFilter handles numeric == and !=', () => {
  assert.equal(applyFilter('{{ n }} == 5', { n: 5 }), true);
  assert.equal(applyFilter('{{ n }} == 5', { n: 6 }), false);
  assert.equal(applyFilter('{{ n }} != 5', { n: 6 }), true);
  assert.equal(applyFilter('{{ n }} != 5', { n: 5 }), false);
});

test('applyFilter handles numeric > < >= <=', () => {
  assert.equal(applyFilter('{{ n }} > 3', { n: 5 }), true);
  assert.equal(applyFilter('{{ n }} > 3', { n: 2 }), false);
  assert.equal(applyFilter('{{ n }} < 3', { n: 2 }), true);
  assert.equal(applyFilter('{{ n }} < 3', { n: 5 }), false);
  assert.equal(applyFilter('{{ n }} >= 5', { n: 5 }), true);
  assert.equal(applyFilter('{{ n }} <= 5', { n: 5 }), true);
});

test('applyFilter compares strings for equality', () => {
  assert.equal(applyFilter('{{ status }} == failure', { status: 'failure' }), true);
  assert.equal(applyFilter('{{ status }} == failure', { status: 'success' }), false);
  assert.equal(applyFilter('{{ status }} != failure', { status: 'success' }), true);
});

test('applyFilter strips one layer of surrounding quotes on operands', () => {
  assert.equal(applyFilter('{{ status }} == "failure"', { status: 'failure' }), true);
  assert.equal(applyFilter("{{ status }} == 'failure'", { status: 'failure' }), true);
});

test('applyFilter supports the includes operator', () => {
  assert.equal(applyFilter('{{ title }} includes urgent', { title: 'this is urgent now' }), true);
  assert.equal(applyFilter('{{ title }} includes urgent', { title: 'all good' }), false);
});

test('applyFilter with no operator is truthy unless empty/false/0', () => {
  assert.equal(applyFilter('{{ flag }}', { flag: 'yes' }), true);
  assert.equal(applyFilter('{{ flag }}', { flag: '' }), false);
  assert.equal(applyFilter('{{ flag }}', { flag: 'false' }), false);
  assert.equal(applyFilter('{{ flag }}', { flag: 0 }), false);
  assert.equal(applyFilter('{{ flag }}', { flag: 1 }), true);
});
