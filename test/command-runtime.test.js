import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerCommands, COMMANDS } from '../src/command-runtime.js';

function fakeContext() {
  const definitions = [];
  return {
    commands: {
      register(definition) {
        definitions.push(definition);
        return () => definitions.splice(definitions.indexOf(definition), 1);
      }
    },
    definitions
  };
}

test('registers exactly the three runner commands', () => {
  const ctx = fakeContext();
  registerCommands(ctx, {});
  assert.deepEqual(ctx.definitions.map((d) => d.name), ['shell', 'cmd', 'pwsh']);
  assert.deepEqual(COMMANDS.sort(), ['cmd', 'pwsh', 'shell']);
  assert.equal(ctx.definitions.some((d) => d.name === 'tool'), false);
  assert.deepEqual(ctx.definitions.map((d) => d.input), [
    { hint: '<command>' },
    { hint: '<command>' },
    { hint: '<command>' }
  ]);
});

test('shell handler delegates the parsed runner, line, and level to the adapter', async () => {
  const ctx = fakeContext();
  const calls = [];
  registerCommands(ctx, {
    runCommand: async (runner, line, invocation, level) => {
      calls.push({ runner, line, hasSignal: !!invocation?.signal, level });
      return { kind: 'success', text: `${runner}:${line}` };
    }
  });
  const result = await ctx.definitions[0].handler({ rawInput: ' ls -la', signal: new AbortController().signal });
  assert.deepEqual(calls, [{ runner: 'shell', line: 'ls -la', hasSignal: true, level: 'all' }]);
  assert.deepEqual(result, { kind: 'success', text: 'shell:ls -la' });
});

test('handler returns a parse error without calling the adapter', async () => {
  const ctx = fakeContext();
  let calls = 0;
  registerCommands(ctx, { runCommand: async () => { calls += 1; return { kind: 'success', text: '' }; } });
  const result = await ctx.definitions[0].handler({ rawInput: '  ', signal: new AbortController().signal });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /requires a command/);
  assert.equal(calls, 0);
});

test('handler tolerates a leading colon in the raw input', async () => {
  const ctx = fakeContext();
  const calls = [];
  registerCommands(ctx, {
    runCommand: async (runner, line, invocation, level) => {
      calls.push({ runner, line, level });
      return { kind: 'success', text: '' };
    }
  });
  await ctx.definitions[1].handler({ rawInput: ' :dir', signal: new AbortController().signal });
  assert.deepEqual(calls, [{ runner: 'cmd', line: 'dir', level: 'all' }]);
});

test('handler forwards a parsed output level to the adapter', async () => {
  const ctx = fakeContext();
  const calls = [];
  registerCommands(ctx, {
    runCommand: async (runner, line, invocation, level) => {
      calls.push({ runner, line, level });
      return { kind: 'success', text: '' };
    }
  });
  await ctx.definitions[0].handler({ rawInput: ' :error ls -la', signal: new AbortController().signal });
  assert.deepEqual(calls, [{ runner: 'shell', line: 'ls -la', level: 'error' }]);
});

test('disposer unregisters all commands', () => {
  const ctx = fakeContext();
  const dispose = registerCommands(ctx, {});
  assert.equal(ctx.definitions.length, 3);
  dispose();
  assert.equal(ctx.definitions.length, 0);
});
