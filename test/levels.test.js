import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, DEFAULT_LEVEL, isLevel, classifyLine, filterText } from '../src/levels.js';

test('LEVELS lists levels narrowest to widest, frozen, with all as the default', () => {
  assert.deepEqual(LEVELS, ['error', 'warning', 'all']);
  assert.equal(Object.isFrozen(LEVELS), true);
  assert.equal(DEFAULT_LEVEL, 'all');
  assert.equal(isLevel('error'), true);
  assert.equal(isLevel('warning'), true);
  assert.equal(isLevel('all'), true);
  assert.equal(isLevel('verbose'), false);
  assert.equal(isLevel(''), false);
  assert.equal(isLevel(undefined), false);
});

test('classifyLine matches every error keyword case-insensitively', () => {
  const keywords = [
    'error', 'fail', 'fatal', 'panic', 'exception', 'traceback', 'cannot',
    'unable to', 'no such file', 'not found', 'refused', 'denied', 'unhandled',
    'segmentation fault', 'core dumped', 'killed', 'terminated', 'aborted'
  ];
  for (const keyword of keywords) {
    assert.equal(classifyLine(`prefix ${keyword} suffix`), 'error', keyword);
    assert.equal(classifyLine(`PREFIX ${keyword.toUpperCase()} SUFFIX`), 'error', keyword);
  }
});

test('classifyLine treats a signal-death report as an error', () => {
  // Without these, a crashed command's only line would vanish at level error.
  for (const line of [
    'Segmentation fault (core dumped)',
    'Killed',
    'Terminated',
    'Aborted (core dumped)'
  ]) {
    assert.equal(classifyLine(line), 'error', line);
  }
});

test('classifyLine matches every warning keyword and classifies neutral lines as info', () => {
  for (const keyword of ['warn', 'deprecat', 'caution']) {
    assert.equal(classifyLine(`note: ${keyword} here`), 'warning', keyword);
    assert.equal(classifyLine(`NOTE: ${keyword.toUpperCase()} HERE`), 'warning', keyword);
  }
  assert.equal(classifyLine('  3 files changed, 10 insertions'), 'info');
  assert.equal(classifyLine(''), 'info');
});

test('error keywords win over warning keywords on the same line', () => {
  assert.equal(classifyLine('warning: error detected'), 'error');
});

test('level all returns the input string unchanged, byte-for-byte', () => {
  const text = 'info line\nerror: boom\n\ntrailing newline kept\n';
  assert.ok(filterText(text, 'all') === text);
});

test('an info line survives only at level all', () => {
  assert.ok(filterText('plain info line\n', 'all') === 'plain info line\n');
  assert.equal(filterText('plain info line\n', 'warning'), '');
  assert.equal(filterText('plain info line\n', 'error'), '');
});

test('a warning line survives at warning and all but not error', () => {
  const text = 'caution: check config\n';
  assert.ok(filterText(text, 'all') === text);
  assert.equal(filterText(text, 'warning'), 'caution: check config');
  assert.equal(filterText(text, 'error'), '');
});

test('an error line survives at every level', () => {
  const text = 'fatal: cannot open file\n';
  assert.ok(filterText(text, 'all') === text);
  assert.equal(filterText(text, 'warning'), 'fatal: cannot open file');
  assert.equal(filterText(text, 'error'), 'fatal: cannot open file');
});

test('level warning keeps error and warning lines and drops info lines', () => {
  const text = 'starting\nerror: boom\ncaution: check\n';
  assert.equal(filterText(text, 'warning'), 'error: boom\ncaution: check');
});

test('filterText throws a TypeError naming an unknown level', () => {
  assert.throws(() => filterText('text', 'verbose'), TypeError);
  assert.throws(() => filterText('text', undefined), TypeError);
});
