// Testable Web client. The browser bundle lives in client.js; this module
// mirrors its structure so contract tests can exercise it without a VM.

export const inject = ['commandUi', 'connection', 'sessions', 'slots'];

// Runner names advertised in the "/" menu. Mirrors src/runners.js; the parser
// and command-runtime own the authoritative list on the host side.
const RUNNERS = [
  { id: 'shell', detail: 'Run a command in bash (POSIX shell)' },
  { id: 'cmd', detail: 'Run a command in cmd.exe (Windows)' },
  { id: 'pwsh', detail: 'Run a command in PowerShell (pwsh)' }
];

// Keyed command-result slot declared by ui-chat's 'command' node entry.
// Reusing a runner name as the key replaces that command's generic card.
const COMMAND_SLOT = 'conversation.chat.commandview';
// Locale namespace owned by ui-chat; its dictionary carries the status copy
// the generic command card uses, so this card reuses it verbatim.
const CHAT_NS = 'chat';
const STYLE_ID = 'dsh-quick-shell-command-card';

// DSH's popup controller exposes a composer-focus hook internally, but older
// Web builds do not bind it from InputBar. Return focus to the rendered
// composer after selection; this only enables continued typing and
// intentionally does not submit the message.
const focusComposerAfterSelection = () => {
  const documentRef = globalThis.document;
  if (!documentRef?.querySelectorAll) return;
  const textareas = documentRef.querySelectorAll('[data-composer-card] textarea');
  const textarea = Array.from(textareas).find((element) => !element.disabled);
  if (!textarea || typeof textarea.focus !== 'function') return;
  const focus = () => textarea.focus({ preventScroll: true });
  if (typeof globalThis.queueMicrotask === 'function') globalThis.queueMicrotask(focus);
  else globalThis.setTimeout?.(focus, 0);
};

const fillComposer = (ctx, runner, option, session) => {
  const actx = ctx.sessions.scope(session.sessionId);
  const conversation = actx?.get?.('conversation');
  const input = conversation?.input?.for?.(actx);
  const state = input?.state?.getSnapshot?.();
  if (!state || typeof state.draft !== 'string' || typeof state.draftRev !== 'number') {
    throw new Error('dsh-quick-shell cannot access the session composer');
  }
  const token = `/${runner}`;
  const tokenStart = state.draft.lastIndexOf(token);
  const text = option?.id ? `${token} ${option.id} ` : `${token} `;
  actx.emit('slash/input-insert-text', {
    text,
    span: { start: tokenStart >= 0 ? tokenStart : 0, end: state.draft.length, draftRev: state.draftRev }
  });
  focusComposerAfterSelection();
};

/**
 * The command line as the user typed it: `command/run`'s name plus its
 * verbatim rawInput (leading separator whitespace included). Rendering the
 * pair is what turns a bare `cmd` title into `cmd "dir"`.
 *
 * @param {{ name?: unknown, args?: unknown }} node - folded command lifecycle.
 * @returns {string} the command line, or an empty string when both parts are absent.
 */
export function commandTitle(node) {
  const name = typeof node?.name === 'string' ? node.name : '';
  const args = typeof node?.args === 'string' ? node.args : '';
  return `${name}${args}`;
}

// Stylesheet mirroring ui-chat's GenericCommandCard, injected once. The
// primitive supplies the row chrome; these rules cover the summary and the
// expanded output body only.
const ensureCommandCardStyles = () => {
  const documentRef = globalThis.document;
  if (!documentRef?.createElement || !documentRef.head) return;
  if (documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    '.dsh-quick-shell-command { display: flex; flex-direction: column; }',
    '.dsh-quick-shell-command-summary {',
    '  min-width: 0; overflow: hidden; flex: 1 1 auto; margin-left: 8px;',
    '  color: var(--dsw-alias-label-tertiary);',
    '  font-size: var(--dsh-content-font-size-secondary, 13px);',
    '  line-height: calc(24px + var(--dsh-content-font-delta, 0px));',
    '  text-overflow: ellipsis; white-space: nowrap;',
    '}',
    '.dsh-quick-shell-command-summary[data-error] { color: var(--dsw-alias-state-error-primary); }',
    '.dsh-quick-shell-command-body {',
    '  max-height: 260px; margin: 4px 0 4px 4px; padding: 12px 16px; overflow: auto;',
    '  border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 12px;',
    '  background: var(--dsw-alias-markdown-code-block); color: var(--dsw-alias-label-primary);',
    '  font: var(--dsw-font-markdown-code-block-small); white-space: pre-wrap;',
    '}'
  ].join('\n');
  documentRef.head.append(style);
};

const removeCommandCardStyles = () => {
  globalThis.document?.getElementById?.(STYLE_ID)?.remove?.();
};

/**
 * Build the command card component for one runner name.
 *
 * Mirrors ui-chat's generic command card, except the title carries the invoked
 * command line (`name` + verbatim `args`) instead of the bare name. React and
 * the primitives arrive as parameters so this module stays testable in Node
 * while client.js passes the module-table values it requires.
 *
 * @param {object} React - React namespace (createElement, useState).
 * @param {object} primitives - ui-primitives exports (DisclosureRow, icons).
 * @returns {(props: { node: object, t?: (key: string) => string }) => unknown} the card component.
 */
export function createCommandCard(React, primitives) {
  const { DisclosureRow, IconApiOutline14, StateDot } = primitives;
  return function QuickShellCommandCard({ node, t }) {
    const [expanded, setExpanded] = React.useState(false);
    const translate = (key) => (typeof t === 'function' ? t(key) : key);
    const outcome = node.outcome ?? null;
    const state = outcome === null ? 'running' : outcome.kind === 'error' ? 'error' : 'ok';
    const text = outcome?.text;
    const summary = outcome === null
      ? translate('command.running')
      : text ?? (outcome.kind === 'error' ? translate('command.failed') : translate('command.done'));
    const title = commandTitle(node) || translate('command.title');
    const body = typeof text === 'string' && text.includes('\n') ? text : null;
    const open = expanded && body !== null;
    return React.createElement(
      'div',
      { className: 'dsh-quick-shell-command', 'data-state': state },
      React.createElement(DisclosureRow, {
        icon: state === 'error'
          ? React.createElement(StateDot, { state: 'error' })
          : React.createElement(IconApiOutline14, { size: 14 }),
        title,
        open,
        expandable: body !== null,
        expandOnRowClick: true,
        keepContentWhenOpen: true,
        onToggle: () => { setExpanded((value) => !value); },
        collapsedContent: React.createElement(
          'span',
          { className: 'dsh-quick-shell-command-summary', 'data-error': state === 'error' || undefined },
          summary
        )
      }),
      body === null ? null : React.createElement('pre', { className: 'dsh-quick-shell-command-body' }, body)
    );
  };
}

/**
 * Register the "/" menu decorations and the per-runner command result cards.
 *
 * @param {object} ctx - the Cordis context exposing `commandUi` and `slots`.
 * @param {{ React?: object, primitives?: object }} [deps] - module-table values for the card.
 * @returns {() => void} disposer that unregisters every contribution.
 */
export function apply(ctx, deps = {}) {
  if (!ctx?.commandUi?.decorate) throw new TypeError('dsh-quick-shell requires commandUi.decorate');
  const slots = ctx.get?.('slots') ?? ctx.slots;
  if (!slots?.inject || typeof slots.register !== 'function') {
    throw new TypeError('dsh-quick-shell requires slots.inject and slots.register');
  }
  ensureCommandCardStyles();
  const decoration = (runner) => ({
    name: runner.id,
    available: () => true,
    ui: {
      kind: 'popupSelect',
      async options() {
        // No dynamic candidates: a runner takes freeform command text. Offer
        // a single placeholder so the menu still advertises the command, and
        // selecting it fills the prefix and returns focus for typing.
        return [{ id: '', label: '<command>', detail: runner.detail }];
      },
      onSelect: (option, session) => fillComposer(ctx, runner.id, option, session)
    }
  });
  const disposers = RUNNERS.map((runner) => ctx.commandUi.decorate(decoration(runner)));
  const cardDisposers = RUNNERS.map((runner) => slots.inject(COMMAND_SLOT, () => slots.register(
    { name: COMMAND_SLOT, key: runner.id, locale: CHAT_NS },
    createCommandCard(deps.React, deps.primitives)
  )));
  return () => {
    cardDisposers.reverse().forEach((dispose) => dispose?.());
    disposers.reverse().forEach((dispose) => dispose?.());
    removeCommandCardStyles();
  };
}
