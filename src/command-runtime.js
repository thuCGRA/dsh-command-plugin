import { parseSlash } from './parser.js';
import { RUNNERS } from './runners.js';

const COMMANDS = Object.keys(RUNNERS);

function resultError(text) {
  return { kind: 'error', text };
}

function normalizeInvocation(invocation) {
  if (typeof invocation === 'string') return invocation;
  if (invocation && typeof invocation.rawInput === 'string') return invocation.rawInput;
  return '';
}

function parseInvocation(runner, invocation) {
  const parsed = parseSlash(`/${runner}${normalizeInvocation(invocation)}`);
  if (!parsed.matched) {
    return resultError(parsed.error?.message ?? `Invalid /${runner} invocation`);
  }
  return parsed.command;
}

/**
 * Register the Host-side shell/cmd/pwsh commands and return their disposers.
 *
 * @param {object} ctx - the Cordis context exposing `commands.register`.
 * @param {object} [adapter] - the subprocess adapter (createDshAdapter by default).
 * @returns {() => void} disposer that unregisters all commands.
 */
export function registerCommands(ctx, adapter = {}) {
  if (!ctx?.commands || typeof ctx.commands.register !== 'function') {
    throw new TypeError('dsh-quick-shell requires commands.register');
  }

  const definitions = Object.values(RUNNERS).map((runner) => ({
    name: runner.name,
    description: runner.description,
    input: { hint: '<command>' },
    async handler(invocation) {
      const command = parseInvocation(runner.name, invocation);
      if (command.kind === 'error') return command;
      return adapter.runCommand(command.kind, command.line, invocation, command.level);
    }
  }));

  const disposers = definitions.map((definition) => ctx.commands.register(definition));
  return () => {
    for (const dispose of disposers.reverse()) {
      if (typeof dispose === 'function') dispose();
    }
  };
}

export { COMMANDS };
