import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlash, RUNNERS } from '../src/parser.js';

test('parses shell, cmd, and pwsh commands with their full command text', () => {
  assert.deepEqual(parseSlash('/shell ls -la'), {
    matched: true,
    command: { kind: 'shell', line: 'ls -la', level: 'all', rawInput: '/shell ls -la' }
  });
  assert.deepEqual(parseSlash('/cmd dir /b'), {
    matched: true,
    command: { kind: 'cmd', line: 'dir /b', level: 'all', rawInput: '/cmd dir /b' }
  });
  assert.deepEqual(parseSlash('/pwsh Get-Process | Select-Object -First 3'), {
    matched: true,
    command: { kind: 'pwsh', line: 'Get-Process | Select-Object -First 3', level: 'all', rawInput: '/pwsh Get-Process | Select-Object -First 3' }
  });
});

test('preserves quotes and internal spacing inside the command text', () => {
  assert.equal(parseSlash('/shell echo "  spaced  "').command.line, 'echo "  spaced  "');
  assert.equal(parseSlash('/shell echo a   &&   echo b').command.line, 'echo a   &&   echo b');
});

test('tolerates a single leading colon after the runner name as a courtesy', () => {
  assert.equal(parseSlash('/shell :ls -la').command.line, 'ls -la');
  assert.equal(parseSlash('/shell : ls -la').command.line, 'ls -la');
});

test('extracts a recognized level from the leading-colon slot', () => {
  assert.deepEqual(parseSlash('/shell :error ls -la'), {
    matched: true,
    command: { kind: 'shell', line: 'ls -la', level: 'error', rawInput: '/shell :error ls -la' }
  });
  assert.deepEqual(parseSlash('/shell :warning  ls'), {
    matched: true,
    command: { kind: 'shell', line: 'ls', level: 'warning', rawInput: '/shell :warning  ls' }
  });
  assert.equal(parseSlash('/cmd :error dir').command.level, 'error');
  assert.equal(parseSlash('/pwsh :warning Get-Process').command.level, 'warning');
});

test('a level selector without a command is MISSING_COMMAND', () => {
  assert.equal(parseSlash('/shell :error').error.code, 'MISSING_COMMAND');
  assert.equal(parseSlash('/shell :warning').error.code, 'MISSING_COMMAND');
});

test('non-level colon words keep the courtesy tolerance and the default level', () => {
  const colon = parseSlash('/shell :ls -la').command;
  assert.equal(colon.level, 'all');
  assert.equal(colon.line, 'ls -la');
  const glued = parseSlash('/shell :errorls').command;
  assert.equal(glued.level, 'all');
  assert.equal(glued.line, 'errorls');
  const punctuated = parseSlash('/shell :warning: x').command;
  assert.equal(punctuated.level, 'all');
  assert.equal(punctuated.line, 'warning: x');
});

test('rejects the colon-without-space form the way DSH does (not a command)', () => {
  // DSH's tokenizer requires whitespace after the command name, so /shell:ls
  // never reaches a handler; the parser mirrors that by not matching.
  assert.equal(parseSlash('/shell:ls -la').matched, false);
});

test('rejects missing command and unknown runner explicitly', () => {
  assert.equal(parseSlash('/shell').error.code, 'MISSING_COMMAND');
  assert.equal(parseSlash('/shell   ').error.code, 'MISSING_COMMAND');
  assert.equal(parseSlash('/bash echo hi').error.code, 'UNKNOWN_RUNNER');
  assert.equal(parseSlash('/tool demo').error.code, 'UNKNOWN_RUNNER');
});

test('does not treat URLs, inline text, code blocks, or escaped slashes as commands', () => {
  assert.equal(parseSlash('https://example.com/a/b').matched, false);
  assert.equal(parseSlash('请执行 /shell ls -la').matched, false);
  assert.equal(parseSlash('`/shell ls -la`').matched, false);
  assert.equal(parseSlash('``/shell ls -la``').matched, false);
  assert.equal(parseSlash('\\/shell ls -la').matched, false);
  assert.equal(parseSlash('//shell ls -la').matched, false);
});

test('rejects uppercase runner names matching DSH lowercase rule', () => {
  assert.equal(parseSlash('/SHELL ls').matched, false);
  assert.equal(parseSlash('/Shell ls').matched, false);
});

test('RUNNERS set stays in sync with the runner registry', () => {
  assert.deepEqual([...RUNNERS].sort(), ['cmd', 'pwsh', 'shell']);
});
