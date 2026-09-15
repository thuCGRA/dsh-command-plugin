import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDshAdapter } from '../src/dsh-adapter.js';

// A fake child process: an EventEmitter with stdout/stderr EventEmitters and
// a kill() that schedules a close event (mirroring real Node behavior where
// killing a process makes it exit and emit 'close').
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { queueMicrotask(() => child.emit('close', null)); };
  return child;
}

// Returns a spawn stub that records calls and runs `drive(child)` on a
// microtask so the test can emit stdio/close events in order.
function fakeSpawn(drive) {
  const calls = [];
  const fn = (file, args, options) => {
    const child = fakeChild();
    calls.push({ file, args, options });
    if (drive) queueMicrotask(() => drive(child));
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('rejects an unknown runner without spawning', async () => {
  const spawn = fakeSpawn(() => {});
  const adapter = createDshAdapter({}, { spawn });
  const result = await adapter.runCommand('bash', 'echo hi', {}, 'all');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /Unknown runner: bash/);
  assert.equal(spawn.calls.length, 0);
});

test('rejects an empty command without spawning', async () => {
  const spawn = fakeSpawn(() => {});
  const adapter = createDshAdapter({}, { spawn });
  const result = await adapter.runCommand('shell', '', {}, 'all');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /\/shell requires a command/);
  assert.equal(spawn.calls.length, 0);
});

test('collects stdout and reports success on exit code 0', async () => {
  const spawn = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('hello\n'));
    child.emit('close', 0);
  });
  const adapter = createDshAdapter({}, { spawn, timeoutMs: 1000 });
  const result = await adapter.runCommand('shell', 'echo hello', {}, 'all');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /hello/);
  assert.match(result.text, /\[exit code 0\]/);
});

test('marks non-zero exit codes as errors while still returning output', async () => {
  const spawn = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('out\n'));
    child.stderr.emit('data', Buffer.from('err\n'));
    child.emit('close', 1);
  });
  const adapter = createDshAdapter({}, { spawn });
  const result = await adapter.runCommand('shell', 'bad', {}, 'all');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /out/);
  assert.match(result.text, /--- stderr ---/);
  assert.match(result.text, /err/);
  assert.match(result.text, /\[exit code 1\]/);
});

test('spawns with the session cwd and the runner recipe', async () => {
  const spawn = fakeSpawn((child) => { child.emit('close', 0); });
  const adapter = createDshAdapter({}, { spawn });
  await adapter.runCommand('shell', 'pwd', { agent: { session: { header: { cwd: '/workspace/project' } } } }, 'all');
  assert.ok(typeof spawn.calls[0].file === 'string' && spawn.calls[0].file.length > 0);
  assert.deepEqual(spawn.calls[0].args, ['-c', 'pwd']);
  assert.equal(spawn.calls[0].options.cwd, '/workspace/project');
});

test('kills the process and reports a timeout when the deadline elapses', async () => {
  const spawn = fakeSpawn(() => { /* child never closes on its own */ });
  const adapter = createDshAdapter({}, { spawn, timeoutMs: 10 });
  const result = await adapter.runCommand('shell', 'sleep 100', {}, 'all');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /\[timed out after 10ms\]/);
});

test('kills the process and reports abort when the UI signal fires', async () => {
  const spawn = fakeSpawn(() => { /* child never closes on its own */ });
  const ac = new AbortController();
  const adapter = createDshAdapter({}, { spawn, timeoutMs: 0 });
  const pending = adapter.runCommand('shell', 'sleep', { signal: ac.signal }, 'all');
  ac.abort();
  const result = await pending;
  assert.equal(result.kind, 'error');
  assert.match(result.text, /\[aborted by caller\]/);
});

test('does not spawn when the signal is already aborted', async () => {
  const spawn = fakeSpawn(() => {});
  const ac = new AbortController();
  ac.abort();
  const adapter = createDshAdapter({}, { spawn });
  const result = await adapter.runCommand('shell', 'echo hi', { signal: ac.signal }, 'all');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /\[aborted by caller\]/);
  assert.equal(spawn.calls.length, 0);
});

test('truncates output at the configured byte cap', async () => {
  const spawn = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.alloc(20, 65)); // 20 'A's
    child.emit('close', 0);
  });
  const adapter = createDshAdapter({}, { spawn, maxBytes: 10 });
  const result = await adapter.runCommand('shell', 'yes A', {}, 'all');
  assert.match(result.text, /\[output truncated at 10 bytes\]/);
  assert.match(result.text, /AAAAAAAAAA/);
});

test('reports a spawn ENOENT as a clear error', async () => {
  const spawn = fakeSpawn((child) => {
    const error = new Error('spawn bash ENOENT');
    error.code = 'ENOENT';
    child.emit('error', error);
  });
  const adapter = createDshAdapter({}, { spawn });
  const result = await adapter.runCommand('shell', 'echo hi', {}, 'all');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /not found on PATH/);
});

test('listRunners returns the registry projection', async () => {
  const adapter = createDshAdapter({});
  const runners = await adapter.listRunners();
  const names = runners.map((r) => r.name).sort();
  assert.deepEqual(names, ['cmd', 'pwsh', 'shell']);
  const cmd = runners.find((r) => r.name === 'cmd');
  assert.deepEqual(cmd.platforms, ['win32']);
});

test('falls back to GBK when output is not valid UTF-8', async () => {
  // "驱动器" in GBK encoding — not valid UTF-8, would show as replacement chars
  const gbkBuf = Buffer.from([0xc7, 0xfd, 0xb6, 0xaf, 0xc6, 0xf7]);
  const spawn = fakeSpawn((child) => {
    child.stdout.emit('data', gbkBuf);
    child.emit('close', 0);
  });
  const adapter = createDshAdapter({}, { spawn, fallbackEncoding: 'gbk' });
  const result = await adapter.runCommand('shell', 'echo', {}, 'all');
  assert.equal(result.kind, 'success');
  assert.ok(result.text.includes('驱动器'), `expected decoded GBK text in: ${result.text}`);
});

test('does not corrupt valid UTF-8 output even with a fallback configured', async () => {
  const utf8Buf = Buffer.from('hello 世界', 'utf8');
  const spawn = fakeSpawn((child) => {
    child.stdout.emit('data', utf8Buf);
    child.emit('close', 0);
  });
  const adapter = createDshAdapter({}, { spawn, fallbackEncoding: 'gbk' });
  const result = await adapter.runCommand('shell', 'echo', {}, 'all');
  assert.equal(result.kind, 'success');
  assert.ok(result.text.includes('hello 世界'), `expected UTF-8 text in: ${result.text}`);
});

test('level all produces byte-for-byte the same text as today', async () => {
  const spawn = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('info\nerror: boom\n'));
    child.stderr.emit('data', Buffer.from('warn: meh\n'));
    child.emit('close', 1);
  });
  const adapter = createDshAdapter({}, { spawn });
  const result = await adapter.runCommand('shell', 'mixed', {}, 'all');
  assert.equal(result.text, '[exit code 1]\ninfo\nerror: boom\n\n--- stderr ---\nwarn: meh\n');
});

test('level error drops info and warning lines while keeping banners and error lines', async () => {
  const spawn = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('starting up\nboom: error in module\nall good\n'));
    child.stderr.emit('data', Buffer.from('warning: deprecated\nfatal: cannot open file\n'));
    child.emit('close', 1);
  });
  const adapter = createDshAdapter({}, { spawn });
  const result = await adapter.runCommand('shell', 'mixed', {}, 'error');
  assert.equal(result.kind, 'error');
  assert.equal(result.text, '[exit code 1]\nboom: error in module\n--- stderr ---\nfatal: cannot open file');
});

test('level warning keeps warning lines in addition to error lines', async () => {
  const spawn = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('starting up\nerror: boom\n'));
    child.stderr.emit('data', Buffer.from('warning: deprecated\n'));
    child.emit('close', 1);
  });
  const adapter = createDshAdapter({}, { spawn });
  const result = await adapter.runCommand('shell', 'mixed', {}, 'warning');
  assert.equal(result.text, '[exit code 1]\nerror: boom\n--- stderr ---\nwarning: deprecated');
});

test('omits the stderr section when filtering empties stderr', async () => {
  const spawn = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('error: boom\n'));
    child.stderr.emit('data', Buffer.from('just noise\n'));
    child.emit('close', 1);
  });
  const adapter = createDshAdapter({}, { spawn });
  const result = await adapter.runCommand('shell', 'mixed', {}, 'error');
  assert.equal(result.text.includes('--- stderr ---'), false);
  assert.equal(result.text, '[exit code 1]\nerror: boom');
});

test('rejects an unknown output level without spawning', async () => {
  const spawn = fakeSpawn(() => {});
  const adapter = createDshAdapter({}, { spawn });
  const result = await adapter.runCommand('shell', 'echo hi', {}, 'verbose');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /Unknown output level: verbose/);
  assert.equal(spawn.calls.length, 0);
});
