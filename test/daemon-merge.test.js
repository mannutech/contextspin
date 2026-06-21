// test/daemon-merge.test.js — unit tests for mergeSnippets from src/daemon.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSnippets } from '../src/daemon.js';

/** Minimal config helper for mergeSnippets. */
function cfg({ deduplication = true, priorityOrder = [], maxVisible = 5 } = {}) {
  return {
    injection: { maxVisible },
    snippets: { deduplication, priorityOrder },
  };
}

/** Build a snippet record. */
function snip(text, source, fetchedAt, shownCount = 0) {
  return { text, source, sourceId: 0, fetchedAt, shownCount };
}

test('mergeSnippets does NOT inherit shownCount from old snippets — fresh polls always reset to 0', () => {
  const old = [snip('CI failing: build', 'CI', '2026-06-17T10:00:00.000Z', 4)];
  const fresh = [snip('CI failing: build', 'CI', '2026-06-17T11:00:00.000Z', 0)];
  const out = mergeSnippets(old, fresh, cfg());
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'CI failing: build');
  // A freshly-polled snippet must start at 0 even if the text is the same as
  // a retired old snippet — otherwise unchanged data (same weather, same CI
  // message) would be suppressed forever after being shown N times.
  assert.equal(out[0].shownCount, 0);
});

test('mergeSnippets dedups by text keeping the first when enabled', () => {
  const fresh = [
    snip('same', 'CI', '2026-06-17T11:00:00.000Z'),
    snip('same', 'Slack', '2026-06-17T12:00:00.000Z'),
    snip('other', 'Slack', '2026-06-17T09:00:00.000Z'),
  ];
  const out = mergeSnippets([], fresh, cfg({ priorityOrder: [] }));
  const texts = out.map((s) => s.text).sort();
  assert.deepEqual(texts, ['other', 'same']);
  // the kept "same" is the first occurrence (source CI)
  const same = out.find((s) => s.text === 'same');
  assert.equal(same.source, 'CI');
});

test('mergeSnippets keeps duplicates when deduplication is disabled', () => {
  const fresh = [
    snip('same', 'CI', '2026-06-17T11:00:00.000Z'),
    snip('same', 'Slack', '2026-06-17T12:00:00.000Z'),
  ];
  const out = mergeSnippets([], fresh, cfg({ deduplication: false }));
  assert.equal(out.length, 2);
});

test('mergeSnippets orders by priorityOrder index (case-insensitive), not-found last', () => {
  const fresh = [
    snip('s-slack', 'slack', '2026-06-17T10:00:00.000Z'),
    snip('s-ci', 'CI', '2026-06-17T10:00:00.000Z'),
    snip('s-misc', 'Misc', '2026-06-17T10:00:00.000Z'),
    snip('s-incident', 'Incident', '2026-06-17T10:00:00.000Z'),
  ];
  const out = mergeSnippets([], fresh, cfg({ priorityOrder: ['incident', 'ci', 'slack'] }));
  assert.deepEqual(
    out.map((s) => s.source),
    ['Incident', 'CI', 'slack', 'Misc'],
  );
});

test('mergeSnippets sorts by fetchedAt descending within the same priority', () => {
  const fresh = [
    snip('older', 'CI', '2026-06-17T08:00:00.000Z'),
    snip('newer', 'CI', '2026-06-17T12:00:00.000Z'),
    snip('middle', 'CI', '2026-06-17T10:00:00.000Z'),
  ];
  const out = mergeSnippets([], fresh, cfg({ priorityOrder: ['ci'] }));
  assert.deepEqual(
    out.map((s) => s.text),
    ['newer', 'middle', 'older'],
  );
});

test('mergeSnippets caps the result to injection.maxVisible', () => {
  const fresh = [
    snip('a', 'CI', '2026-06-17T05:00:00.000Z'),
    snip('b', 'CI', '2026-06-17T04:00:00.000Z'),
    snip('c', 'CI', '2026-06-17T03:00:00.000Z'),
    snip('d', 'CI', '2026-06-17T02:00:00.000Z'),
  ];
  const out = mergeSnippets([], fresh, cfg({ priorityOrder: ['ci'], maxVisible: 2 }));
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((s) => s.text),
    ['a', 'b'],
  );
});
