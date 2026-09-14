import { spawn as defaultSpawn } from 'node:child_process';
import { RUNNERS } from './runners.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1_048_576;

/**
 * Decode captured subprocess output.
 *
 * Tries UTF-8 first (the default for bash, pwsh, and most cross-platform tools).
 * If the result contains U+FFFD replacement characters — indicating bytes that
 * are not valid UTF-8 — falls back to `encoding`. This handles Windows cmd.exe
 * built-in commands, which emit the system OEM code page (CP936/GBK on Chinese
 * Windows, CP437/CP1252 on Western Windows) regardless of `chcp` when stdout
 * is a pipe.
 *
 * @param {Buffer} buf - raw captured bytes.
 * @param {string} fallbackEncoding - encoding to try when UTF-8 fails (e.g. 'gbk').
 * @returns {string} the decoded text.
 */
function decodeOutput(buf, fallbackEncoding) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  if (fallbackEncoding) {
    try {
      return new TextDecoder(fallbackEncoding).decode(buf);
    } catch {
      // Unsupported encoding label — return UTF-8 with replacement chars
    }
  }
  return utf8;
}

/**
 * Detect the system's console code page as a `TextDecoder`-compatible encoding
 * label. Returns `undefined` on non-Windows or when detection fails.
 *
 * @returns {string | undefined} e.g. 'gbk', 'shift_jis', or `undefined`.
 */
function detectFallbackEncoding() {
  if (process.platform !== 'win32') return undefined;
  // Windows console code page → TextDecoder encoding label. CP936 (GBK) is by
  // far the most common non-UTF-8 case; CP932 (Shift-JIS) and CP949 (EUC-KR)
  // are the other CJK ones. Western Windows uses CP437/CP1252, which is ASCII-
  // compatible and decodes fine as UTF-8 for ASCII-only output, so no fallback
  // is needed there.
  const CP_TO_ENCODING = {
    '936': 'gbk',
    '932': 'shift_jis',
    '949': 'euc-kr',
    '950': 'big5',
  };
  // The OEM code page is embedded in the system locale string. On Chinese
  // Windows, process.env.LANG may be set to zh_CN.UTF-8 by the harness, so we
  // also check Intl's locale which reflects the OS setting better.
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  if (locale.startsWith('zh')) return 'gbk';
  if (locale.startsWith('ja')) return 'shift_jis';
  if (locale.startsWith('ko')) return 'euc-kr';
  return undefined;
}

/**
 * Spawn a child process, collect its stdio, and resolve a CommandResult.
 *
 * Output is capped at `maxBytes` across stdout+stderr; a hard `timeoutMs`
 * kills the process; an `AbortSignal` from the dispatching UI request kills
 * it on abort. The resolved text always carries the exit code and any
 * captured output so the user sees what happened regardless of success.
 *
 * The spawn function is injected so tests can drive a fake child without
 * touching the real process table.
 *
 * @param {(file: string, args: readonly string[], options: object) => import('node:child_process').ChildProcess} spawnFn - node spawn or a test stub.
 * @param {{ file: string, args: readonly string[], options?: object }} recipe - the spawn recipe from a runner's build().
 * @param {{ cwd?: string, signal?: AbortSignal, timeoutMs: number, maxBytes: number, decode?: (buf: Buffer) => string }} opts - execution bounds.
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>} the settled command result.
 */
function spawnAndCollect(spawnFn, recipe, { cwd, signal, timeoutMs, maxBytes, decode }) {
  const decodeBuf = typeof decode === 'function' ? decode : (buf) => buf.toString('utf8');
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ kind: 'error', text: '[aborted by caller]' });
      return;
    }

    let child;
    try {
      child = spawnFn(recipe.file, recipe.args, {
        cwd: typeof cwd === 'string' ? cwd : undefined,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(recipe.options ?? {})
      });
    } catch (spawnError) {
      const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
      resolve({ kind: 'error', text: `Failed to spawn ${recipe.file}: ${message}` });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let totalBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch { /* child already exited */ }
        }, timeoutMs)
      : null;

    const onAbort = () => {
      if (settled) return;
      aborted = true;
      try { child.kill('SIGKILL'); } catch { /* child already exited */ }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const append = (data, sink) => {
      const remaining = maxBytes - totalBytes;
      if (remaining <= 0) { truncated = true; return; }
      const slice = data.length > remaining ? data.subarray(0, remaining) : data;
      sink.push(slice);
      totalBytes += slice.length;
      if (data.length > slice.length) truncated = true;
    };

    if (child.stdout) child.stdout.on('data', (data) => append(data, stdoutChunks));
    if (child.stderr) child.stderr.on('data', (data) => append(data, stderrChunks));

    const finish = (code, spawnError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);

      const stdout = decodeBuf(Buffer.concat(stdoutChunks));
      const stderr = decodeBuf(Buffer.concat(stderrChunks));
      const banners = [];
      if (aborted) banners.push('[aborted by caller]');
      if (timedOut) banners.push(`[timed out after ${timeoutMs}ms]`);
      if (truncated) banners.push(`[output truncated at ${maxBytes} bytes]`);
      banners.push(`[exit code ${code === null || code === undefined ? 'null' : code}]`);
      if (spawnError && spawnError.code === 'ENOENT') {
        banners.push(`[spawn error: ${recipe.file} not found on PATH]`);
      } else if (spawnError) {
        banners.push(`[spawn error: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}]`);
      }
      const sections = [...banners];
      if (stdout) sections.push(stdout);
      if (stderr) sections.push(`--- stderr ---\n${stderr}`);
      const text = sections.join('\n');
      const ok = code === 0 && !spawnError && !aborted && !timedOut;
      resolve({ kind: ok ? 'success' : 'error', text });
    };

    child.on('error', (err) => finish(undefined, err));
    child.on('close', (code) => finish(code, undefined));
  });
}

/**
 * Adapt the installed DSH services to the plugin's testable subprocess contract.
 *
 * @param {object} _ctx - the Cordis context (unused; commands runtime owns registration).
 * @param {{ spawn?: Function, timeoutMs?: number, maxBytes?: number, fallbackEncoding?: string }} [options] - test overrides.
 */
export function createDshAdapter(_ctx, options = {}) {
  const spawnFn = options.spawn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const fallbackEncoding = options.fallbackEncoding ?? detectFallbackEncoding();
  const decode = (buf) => decodeOutput(buf, fallbackEncoding);

  return {
    runners: RUNNERS,
    async listRunners() {
      return Object.values(RUNNERS).map(({ name, description, platforms }) => ({
        name, description, ...(platforms ? { platforms } : {})
      }));
    },
    async runCommand(runnerName, line, invocation) {
      const runner = RUNNERS[runnerName];
      if (!runner) return { kind: 'error', text: `Unknown runner: ${runnerName}` };
      if (runner.platforms && !runner.platforms.includes(process.platform)) {
        return { kind: 'error', text: `Runner ${runnerName} is not available on ${process.platform}` };
      }
      if (!line) return { kind: 'error', text: `/${runnerName} requires a command` };

      const agent = invocation?.agent;
      const cwd = agent?.session?.header?.cwd;
      const signal = invocation?.signal;
      return spawnAndCollect(spawnFn, runner.build(line), { cwd, signal, timeoutMs, maxBytes, decode });
    }
  };
}
