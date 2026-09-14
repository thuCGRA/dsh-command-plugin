// Pure slash parser for the quick-shell runners. Self-contained (no imports)
// so it stays trivially testable; entry.test.js asserts its runner set stays
// in sync with src/runners.js.

/** Runner names accepted by the parser. Must mirror Object.keys(RUNNERS). */
export const RUNNERS = new Set(['shell', 'cmd', 'pwsh']);

function error(code, message) {
  return { matched: false, error: { code, message } };
}

function ordinary() {
  return { matched: false };
}

/**
 * Parse one leading slash invocation for a subprocess runner.
 *
 * DSH's command tokenizer requires the command name to be followed by
 * whitespace (or end of line), so /shell:ls (no space) never reaches a
 * handler — it is sent to the model as ordinary text. This parser mirrors
 * that rule: the runner name is [a-z][a-z0-9_-]* followed by a separator.
 *
 * As a courtesy, a single leading ':' after the separator is tolerated
 * (e.g. "/shell :ls" runs "ls"); if a command genuinely starts with ':',
 * use the plain space form.
 *
 * @param {string} input - the complete slash command line.
 * @returns {{ matched: true, command: { kind: string, line: string, rawInput: string } } | { matched: false, error?: { code: string, message: string } }}
 */
export function parseSlash(input) {
  if (typeof input !== 'string') return error('INVALID_INPUT', 'input must be a string');

  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('\\/')) {
    return ordinary();
  }
  if (trimmed.startsWith('```') || (trimmed.startsWith('`') && trimmed.endsWith('`'))) {
    return ordinary();
  }

  const match = /^\/([a-z][a-z0-9_-]*)(?:[\t\n\r ]([\s\S]*))?$/.exec(trimmed);
  if (!match) return error('INVALID_SYNTAX', 'invalid slash command syntax');

  const [, runner, remainder = ''] = match;
  if (!RUNNERS.has(runner)) return error('UNKNOWN_RUNNER', `unknown runner: ${runner}`);

  const line = remainder.replace(/^\s*:?\s*/, '').trim();
  if (!line) return error('MISSING_COMMAND', `/${runner} requires a command`);

  return { matched: true, command: { kind: runner, line, rawInput: input } };
}
