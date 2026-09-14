import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject, commandTitle, createCommandCard } from '../client/index.js';

// Minimal React stand-in: enough for the card's createElement/useState usage
// without pulling the browser module table into Node. Like React, it always
// collects children into an array.
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: (initial) => [initial, () => {}]
};

const fakePrimitives = {
  DisclosureRow: function DisclosureRow() {},
  IconApiOutline14: function IconApiOutline14() {},
  StateDot: function StateDot() {}
};

const cardProps = (node, t = (key) => key) => ({ node, t });

test('client injects slots alongside the command UI', () => {
  assert.deepEqual(inject, ['commandUi', 'connection', 'sessions', 'slots']);
});

test('commandTitle renders the invoked command line', () => {
  assert.equal(commandTitle({ name: 'cmd', args: ' "dir"' }), 'cmd "dir"');
  assert.equal(commandTitle({ name: 'cmd', args: ' dir' }), 'cmd dir');
  assert.equal(commandTitle({ name: 'shell', args: null }), 'shell');
  assert.equal(commandTitle({ name: 'pwsh', args: undefined }), 'pwsh');
  assert.equal(commandTitle({ name: null, args: null }), '');
  assert.equal(commandTitle({}), '');
});

test('card title shows the input command, not the bare runner name', () => {
  const Card = createCommandCard(fakeReact, fakePrimitives);
  const tree = Card(cardProps({ name: 'cmd', args: ' "dir"', outcome: { kind: 'success', text: '[exit code 0]\nvolume' } }));
  const row = tree.props.children[0];
  assert.equal(row.props.title, 'cmd "dir"');
});

test('card falls back to the command label when the command line is absent', () => {
  const Card = createCommandCard(fakeReact, fakePrimitives);
  const tree = Card(cardProps({ name: null, args: null, outcome: { kind: 'success' } }, (key) => `t:${key}`));
  assert.equal(tree.props.children[0].props.title, 't:command.title');
});

test('card expands multi-line output and summarizes the settled outcome', () => {
  const Card = createCommandCard(fakeReact, fakePrimitives);
  const tree = Card(cardProps({ name: 'cmd', args: ' dir', outcome: { kind: 'success', text: '[exit code 0]\nline 2' } }));
  const row = tree.props.children[0];
  assert.equal(row.props.expandable, true);
  // collapsed summary receives the full outcome text (the primitive clamps it).
  assert.equal(row.props.collapsedContent.props.children[0], '[exit code 0]\nline 2');
  assert.equal(tree.props.children[1].type, 'pre');
});

test('running card summarizes with the locale running label and is not expandable', () => {
  const Card = createCommandCard(fakeReact, fakePrimitives);
  const tree = Card(cardProps({ name: 'cmd', args: ' dir', outcome: null }, (key) => `t:${key}`));
  const row = tree.props.children[0];
  assert.equal(row.props.expandable, false);
  assert.equal(row.props.collapsedContent.props.children[0], 't:command.running');
  assert.equal(tree.props.children[1], null);
});

test('apply registers a command card per runner into the command view slot', () => {
  const decorationNames = [];
  const slotKeys = [];
  const registrations = [];
  const slots = {
    inject(key, callback) {
      slotKeys.push(key);
      return callback();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    }
  };
  const context = {
    commandUi: { decorate(value) { decorationNames.push(value.name); return () => {}; } },
    sessions: { scope: () => ({}) },
    get: (name) => (name === 'slots' ? slots : undefined),
    effect(fn) { return fn(); }
  };
  const dispose = apply(context, { React: fakeReact, primitives: fakePrimitives });
  assert.deepEqual(decorationNames.sort(), ['cmd', 'pwsh', 'shell']);
  assert.deepEqual(slotKeys, ['conversation.chat.commandview', 'conversation.chat.commandview', 'conversation.chat.commandview']);
  assert.deepEqual(registrations.map((entry) => entry.options.key).sort(), ['cmd', 'pwsh', 'shell']);
  assert.equal(registrations[0].options.locale, 'chat');
  assert.equal(typeof dispose, 'function');
});
