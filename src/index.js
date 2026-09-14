import { registerCommands } from './command-runtime.js';
import { createDshAdapter } from './dsh-adapter.js';

/** Stable Cordis plugin name. */
export const name = 'dsh-quick-shell';

/** Host services required by the command handlers. */
export const inject = ['commands'];

/**
 * Host entry point.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the Cordis context.
 */
export function apply(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new TypeError('dsh-quick-shell requires a Cordis context');
  }
  return registerCommands(ctx, createDshAdapter(ctx));
}
