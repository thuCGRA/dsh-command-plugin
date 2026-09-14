import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PWSH_ENCODING_PREAMBLE, RUNNERS, candidatePwshPaths, resolvePwsh } from '../src/runners.js';
import { RUNNERS as RUNNER_NAMES } from '../src/parser.js';

test('exposes exactly the shell, cmd, and pwsh runners', () => {
  assert.deepEqual(Object.keys(RUNNERS).sort(), ['cmd', 'pwsh', 'shell']);
  assert.equal(RUNNERS.shell.name, 'shell');
  assert.equal(RUNNERS.cmd.name, 'cmd');
  assert.equal(RUNNERS.pwsh.name, 'pwsh');
});

test('shell builds a bash -c spawn recipe (auto-detects bash on Windows)', () => {
  const recipe = RUNNERS.shell.build('ls -la');
  assert.ok(typeof recipe.file === 'string' && recipe.file.length > 0);
  assert.deepEqual(recipe.args, ['-c', 'ls -la']);
  // Windows 上应解析为 git bash 路径，非 Windows 为 'bash'
  if (process.platform === 'win32') {
    assert.ok(recipe.file.endsWith('bash.exe') || recipe.file === 'bash');
  } else {
    assert.equal(recipe.file, 'bash');
  }
});

test('cmd builds a cmd.exe recipe and is restricted to win32', () => {
  const recipe = RUNNERS.cmd.build('dir /b');
  assert.equal(recipe.file, 'cmd.exe');
  assert.deepEqual(recipe.args, ['/d', '/s', '/c', 'dir /b']);
  assert.deepEqual(RUNNERS.cmd.platforms, ['win32']);
});

test('pwsh builds a PowerShell recipe (auto-detects pwsh on Windows)', () => {
  const recipe = RUNNERS.pwsh.build('Get-Process');
  assert.ok(typeof recipe.file === 'string' && recipe.file.length > 0);
  assert.equal(recipe.args[0], '-NoProfile');
  assert.equal(recipe.args[1], '-Command');
  assert.equal(recipe.args[2], `${PWSH_ENCODING_PREAMBLE}Get-Process`);
  // Windows 上应解析为 pwsh.exe 或 Windows PowerShell 5.1 回退；非 Windows 为 'pwsh'
  if (process.platform === 'win32') {
    assert.ok(
      recipe.file.endsWith('pwsh.exe') || recipe.file.endsWith('powershell.exe') || recipe.file === 'pwsh'
    );
  } else {
    assert.equal(recipe.file, 'pwsh');
  }
});

test('pwsh pins UTF-8 output ahead of the caller command', () => {
  const recipe = RUNNERS.pwsh.build('Write-Output 一');
  // 前置语句必须固定 [Console]::OutputEncoding 与 $OutputEncoding 为 UTF-8，
  // 否则 GBK 字节对可能被误当作合法 UTF-8，adapter 不回退而返回乱码。
  assert.match(PWSH_ENCODING_PREAMBLE, /\[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]/);
  assert.match(PWSH_ENCODING_PREAMBLE, /\$OutputEncoding = \[System\.Text\.UTF8Encoding\]/);
  assert.ok(recipe.args[2].startsWith(PWSH_ENCODING_PREAMBLE));
  assert.ok(recipe.args[2].endsWith('Write-Output 一'));
});

test('shell and pwsh are not platform-restricted', () => {
  assert.equal(RUNNERS.shell.platforms, undefined);
  assert.equal(RUNNERS.pwsh.platforms, undefined);
});

test('parser RUNNERS set mirrors the registry keys', () => {
  assert.deepEqual([...RUNNER_NAMES].sort(), Object.keys(RUNNERS).sort());
});

/**
 * Build a throwaway Windows-like layout. Every probe target is an empty file
 * under a fresh temp directory, so the resolver tests never read the host's
 * real PowerShell installs.
 */
function makeFakeWindows() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-quick-shell-'));
  const programFiles = join(root, 'ProgramFiles');
  const systemRoot = join(root, 'Windows');
  const pwsh7 = join(programFiles, 'PowerShell', '7', 'pwsh.exe');
  const powershell51 = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return {
    root,
    programFiles,
    systemRoot,
    pwsh7,
    powershell51,
    writePwsh7() {
      mkdirSync(join(programFiles, 'PowerShell', '7'), { recursive: true });
      writeFileSync(pwsh7, '');
    },
    writePowershell51() {
      mkdirSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'), { recursive: true });
      writeFileSync(powershell51, '');
    }
  };
}

test('resolvePwsh prefers the PowerShell 7 install over Windows PowerShell 5.1', () => {
  const fake = makeFakeWindows();
  try {
    fake.writePwsh7();
    fake.writePowershell51();
    const env = { ProgramFiles: fake.programFiles, SystemRoot: fake.systemRoot, PATH: '' };
    assert.equal(resolvePwsh(env, 'win32'), fake.pwsh7);
  } finally {
    rmSync(fake.root, { recursive: true, force: true });
  }
});

test('resolvePwsh falls back to Windows PowerShell 5.1 when PowerShell 7 is absent', () => {
  const fake = makeFakeWindows();
  try {
    fake.writePowershell51();
    const env = { ProgramFiles: fake.programFiles, SystemRoot: fake.systemRoot, PATH: '' };
    assert.equal(resolvePwsh(env, 'win32'), fake.powershell51);
  } finally {
    rmSync(fake.root, { recursive: true, force: true });
  }
});

test('resolvePwsh falls back to the bare name when no candidate exists', () => {
  const fake = makeFakeWindows();
  try {
    const env = { ProgramFiles: fake.programFiles, SystemRoot: fake.systemRoot, PATH: '' };
    assert.equal(resolvePwsh(env, 'win32'), 'pwsh');
  } finally {
    rmSync(fake.root, { recursive: true, force: true });
  }
});

test('resolvePwsh resolves a quoted PATH entry before the 5.1 fallback', () => {
  const fake = makeFakeWindows();
  try {
    const storeDir = join(fake.root, 'StoreAlias');
    mkdirSync(storeDir, { recursive: true });
    const storePwsh = join(storeDir, 'pwsh.exe');
    writeFileSync(storePwsh, '');
    fake.writePowershell51();
    const env = { ProgramFiles: fake.programFiles, SystemRoot: fake.systemRoot, PATH: `"${storeDir}"` };
    assert.equal(resolvePwsh(env, 'win32'), storePwsh);
  } finally {
    rmSync(fake.root, { recursive: true, force: true });
  }
});

test('resolvePwsh returns the bare name on non-Windows platforms', () => {
  const fake = makeFakeWindows();
  try {
    fake.writePwsh7();
    const env = { ProgramFiles: fake.programFiles, SystemRoot: fake.systemRoot, PATH: '' };
    assert.equal(resolvePwsh(env, 'linux'), 'pwsh');
  } finally {
    rmSync(fake.root, { recursive: true, force: true });
  }
});

test('candidatePwshPaths orders PowerShell 7, PATH entries, then Windows PowerShell 5.1', () => {
  const env = { ProgramFiles: 'C:\\PF', SystemRoot: 'C:\\Win', PATH: 'D:\\a;D:\\b' };
  assert.deepEqual(candidatePwshPaths(env), [
    join('C:\\PF', 'PowerShell', '7', 'pwsh.exe'),
    join('D:\\a', 'pwsh.exe'),
    join('D:\\b', 'pwsh.exe'),
    join('C:\\Win', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  ]);
});
