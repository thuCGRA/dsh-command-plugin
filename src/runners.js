// Runner registry. Each runner maps a slash-command name to a child_process
// spawn recipe. Add a runner here to teach /<name> <command> a new shell.
//
// Runners are intentionally data, not behavior: build() returns the file and
// args for spawn, and the adapter owns collection, timeout, and cancellation.
// platform restriction is opt-in via `platforms` (process.platform names).

import { join } from 'node:path';
import { lstatSync, statSync } from 'node:fs';

/**
 * Resolve bash executable path.
 * On Windows, tries PATH then common git bash locations.
 * Returns the executable name/path or 'bash' (let spawn use PATH).
 */
function resolveBash() {
  if (process.platform !== 'win32') return 'bash';
  // 1. 先在 PATH 里找
  const pathDirs = (process.env.PATH || '').split(';');
  for (const dir of pathDirs) {
    const candidate = join(dir, 'bash.exe');
    try { if (statSync(candidate).isFile()) return candidate; } catch {}
  }
  // 2. 常见 git bash 安装目录
  const commonPaths = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    join(process.env.USERPROFILE || '', 'AppData\\Local\\Programs\\Git\\bin\\bash.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs\\Git\\bin\\bash.exe'),
  ];
  for (const p of commonPaths) {
    try { if (statSync(p).isFile()) return p; } catch {}
  }
  // 3. 找不到返回 'bash'，让 spawn 自己报错（adapter 会给友好提示）
  return 'bash';
}

/**
 * Build a bash spawn recipe for a POSIX-shell command.
 *
 * @param {string} command - the shell command line to execute.
 * @returns {{ file: string, args: string[] }} the spawn recipe.
 */
const buildShell = (command) => ({ file: resolveBash(), args: ['-c', command] });

/**
 * Build a cmd.exe spawn recipe for a Windows command. Only invoked on win32;
 * the adapter rejects other platforms before calling build().
 *
 * cmd.exe built-in commands emit bytes in the system OEM code page (CP936/GBK
 * on Chinese Windows, CP437/CP1252 on Western Windows). Output decoding is
 * handled by the adapter, which tries UTF-8 first and falls back to the
 * system code page — see `dsh-adapter.js` `decodeOutput`.
 *
 * @param {string} command - the cmd command line to execute.
 * @returns {{ file: string, args: string[] }} the spawn recipe.
 */
const buildCmd = (command) => ({ file: 'cmd.exe', args: ['/d', '/s', '/c', command] });

/**
 * Whether a candidate path can be spawned. lstat opens the entry itself instead
 * of following reparse points, so it sees the Microsoft Store app execution
 * alias where stat would hit the target's ACL; Node reports that alias as a
 * symlink. A directory never matches.
 *
 * @param {string} candidate - the executable path to probe.
 * @returns {boolean} true when the path is a file or symlink.
 */
function candidateExists(candidate) {
  try {
    const stat = lstatSync(candidate);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    // ENOENT is the expected failure; any other error names an unspawnable
    // path, for which false is also the correct answer.
    return false;
  }
}

/**
 * Candidate PowerShell executables on Windows, in resolution order.
 *
 * @param {NodeJS.ProcessEnv} [env] - the environment to probe; defaults to process.env.
 * @returns {string[]} candidate paths: the PowerShell 7 install, every PATH
 *   entry (covering the Microsoft Store alias), then Windows PowerShell 5.1.
 */
export function candidatePwshPaths(env = process.env) {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const systemRoot = env.SystemRoot ?? 'C:\\Windows';
  const candidates = [join(programFiles, 'PowerShell', '7', 'pwsh.exe')];
  // Microsoft Store installs (and any user-added location) live on PATH;
  // entries may carry surrounding quotes from setx-style definitions.
  for (const entry of (env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '');
    if (trimmed.length === 0) continue;
    candidates.push(join(trimmed, 'pwsh.exe'));
  }
  // Windows PowerShell 5.1 remains the last-resort fallback on legacy hosts.
  candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  return candidates;
}

/**
 * Resolve the PowerShell executable for a spawn recipe.
 *
 * On Windows the first spawnable candidate wins: PowerShell 7, a PATH entry,
 * then Windows PowerShell 5.1. Elsewhere, and when Windows has no candidate,
 * the bare name `pwsh` is returned so spawn resolves it through PATH.
 *
 * @param {NodeJS.ProcessEnv} [env] - the environment to probe; defaults to process.env.
 * @param {NodeJS.Platform} [platform] - the platform to resolve for; defaults to process.platform.
 * @returns {string} a resolved executable path, or the bare name `pwsh`.
 */
export function resolvePwsh(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return 'pwsh';
  for (const candidate of candidatePwshPaths(env)) {
    if (candidateExists(candidate)) return candidate;
  }
  return 'pwsh';
}

/**
 * UTF-8 output pinning prepended to every pwsh command.
 *
 * Windows PowerShell writes the console/OEM code page by default (CP936/GBK on
 * Chinese Windows), and the adapter decodes output as UTF-8 first with a GBK
 * fallback. That fallback only fires when UTF-8 decoding yields U+FFFD, but a
 * GBK byte pair can be valid UTF-8 on its own — `一` (GBK D2BB) decodes as a
 * Cyrillic character with no replacement — so the adapter would return
 * mojibake instead of falling back. Pinning UTF-8 at the head of the command
 * keeps every byte the adapter decodes genuinely UTF-8.
 *
 * The statements ride on line 1 after `; ` separators so PowerShell error line
 * numbers stay accurate.
 */
export const PWSH_ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';

/**
 * Build a PowerShell spawn recipe. The executable is resolved per call:
 * PowerShell 7, then a `pwsh` on PATH, then Windows PowerShell 5.1. The
 * command is prefixed with {@link PWSH_ENCODING_PREAMBLE} so non-ASCII output
 * is emitted as UTF-8.
 *
 * @param {string} command - the PowerShell command line to execute.
 * @returns {{ file: string, args: string[] }} the spawn recipe.
 */
const buildPwsh = (command) => ({
  file: resolvePwsh(),
  args: ['-NoProfile', '-Command', `${PWSH_ENCODING_PREAMBLE}${command}`]
});

/** Runners keyed by slash-command name. Mirrored as a Set in parser.js. */
export const RUNNERS = {
  shell: { name: 'shell', description: 'Run a command in bash (POSIX shell)', build: buildShell },
  cmd: { name: 'cmd', description: 'Run a command in cmd.exe (Windows)', platforms: ['win32'], build: buildCmd },
  pwsh: { name: 'pwsh', description: 'Run a command in PowerShell (pwsh)', build: buildPwsh }
};
