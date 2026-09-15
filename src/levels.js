// Output-level filtering for subprocess output. Line classification is a
// documented heuristic over line content (keyword substrings), not a parse
// of the output; lines with no keyword match are info.

/** Selectable output levels, narrowest to widest; a level keeps its own line classes and every narrower class. */
export const LEVELS = Object.freeze(['error', 'warning', 'all']);

/** Level used when an invocation does not select one. */
export const DEFAULT_LEVEL = 'all';

// The last five are the shell's reports of a signal death (SIGSEGV, SIGKILL,
// SIGTERM, SIGABRT); without them a crashed command's only output line would
// classify as info and disappear at level 'error'.
const ERROR_KEYWORDS = [
  'error', 'fail', 'fatal', 'panic', 'exception', 'traceback', 'cannot',
  'unable to', 'no such file', 'not found', 'refused', 'denied', 'unhandled',
  'segmentation fault', 'core dumped', 'killed', 'terminated', 'aborted',
];

const WARNING_KEYWORDS = ['warn', 'deprecat', 'caution'];

/**
 * Whether a value names a selectable output level.
 *
 * @param {unknown} value - the candidate level name.
 * @returns {boolean} true when value is one of LEVELS.
 */
export function isLevel(value) {
  return LEVELS.includes(value);
}

/**
 * Classify one raw output line.
 *
 * Case-insensitive substring matching over the whole line, error keywords
 * checked before warning keywords; a line matching neither table is info.
 *
 * @param {string} line - the raw output line.
 * @returns {'error' | 'warning' | 'info'} the line class.
 */
export function classifyLine(line) {
  const haystack = line.toLowerCase();
  for (const keyword of ERROR_KEYWORDS) {
    if (haystack.includes(keyword)) return 'error';
  }
  for (const keyword of WARNING_KEYWORDS) {
    if (haystack.includes(keyword)) return 'warning';
  }
  return 'info';
}

/**
 * Filter decoded subprocess output to the lines a level keeps.
 *
 * 'all' returns `text` unchanged without splitting. 'error' keeps
 * error-classified lines; 'warning' keeps error- and warning-classified
 * lines. Only decoded stdout/stderr bodies are passed here; the adapter's
 * status banners are never filtered.
 *
 * @param {string} text - decoded stdout or stderr body.
 * @param {string} level - one of LEVELS.
 * @returns {string} the kept lines rejoined with '\n'.
 * @throws {TypeError} when level is not one of LEVELS.
 */
export function filterText(text, level) {
  if (!LEVELS.includes(level)) {
    throw new TypeError(`Unknown output level: ${level}`);
  }
  if (level === 'all') return text;
  const kept = text.split('\n').filter((line) => {
    const lineClass = classifyLine(line);
    return lineClass === 'error' || (level === 'warning' && lineClass === 'warning');
  });
  return kept.join('\n');
}
