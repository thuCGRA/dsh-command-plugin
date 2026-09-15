import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { apply, inject, name } from '../src/index.js';
import { apply as applyClient, inject as injectClient } from '../client/index.js';

const read = (url) => readFile(new URL(url, import.meta.url), 'utf8');

test('exports a DSH host plugin entry contract', () => {
  assert.equal(name, 'dsh-quick-shell');
  assert.deepEqual(inject, ['commands']);
  assert.equal(typeof apply, 'function');
});

test('exports a Web client decoration contract', () => {
  assert.deepEqual(injectClient, ['commandUi', 'connection', 'sessions', 'slots']);
  assert.equal(typeof applyClient, 'function');
});

test('cordis.patch.yml registers the host plugin', async () => {
  const yaml = await read('../cordis.patch.yml');
  assert.match(yaml, /id:\s*dsh-quick-shell/);
  assert.match(yaml, /name:\s*dsh-quick-shell/);
});

test('package declares host bundle patch and client inject', async () => {
  const pkg = JSON.parse(await read('../package.json'));
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.deepEqual(pkg.dsh.client.inject, ['commandUi', 'connection', 'sessions', 'slots']);
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
});

test('browser client uses ModuleLoader and commandUi.decorate', async () => {
  const source = await read('../client/client.js');
  assert.match(source, /window\.\__ModuleLoader__\.load\(\{/);
  assert.match(source, /id:\s*["']dsh-quick-shell["']/);
  assert.match(source, /commandUi\.decorate/);
  assert.match(source, /inject:\s*\[[^\]]*["']commandUi["'][^\]]*["']connection["'][^\]]*["']sessions["']/s);
});

test('browser decorations advertise the three runners and fill the composer', async () => {
  const source = await read('../client/client.js');
  let plugin;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { plugin = value.factory(() => {}); } } } });
  const decorations = [];
  const emitted = [];
  const slotWaits = [];
  const context = {
    get(name) {
      if (name === 'commandUi') return { decorate(value) { decorations.push(value); return () => {}; } };
      if (name === 'sessions') return {
        scope() {
          return {
            get() { return { input: { for: () => ({ state: { getSnapshot: () => ({ draft: '/shell', draftRev: 1 }) } }) } }; },
            emit(event, request) { emitted.push([event, request]); }
          };
        }
      };
      if (name === 'connection') return { api: {} };
      // The declaration wait is not exercised here: the callback needs the
      // module table (React + primitives), which this VM realm does not seed.
      if (name === 'slots') return { inject(key) { slotWaits.push(key); return () => {}; }, register() { return () => {}; } };
      throw new Error(`unexpected service ${name}`);
    },
    effect(fn) { return fn(); }
  };
  plugin.apply(context);
  assert.deepEqual(decorations.map((d) => d.name).sort(), ['cmd', 'pwsh', 'shell']);
  assert.equal(decorations[0].ui.kind, 'popupSelect');
  assert.deepEqual(slotWaits, ['conversation.chat.commandview', 'conversation.chat.commandview', 'conversation.chat.commandview']);

  const options = await decorations[0].ui.options({ sessionId: 's1' });
  // Array.from builds the comparison array in this realm: options comes from
  // the VM realm, whose Array.prototype deepStrictEqual rejects.
  assert.deepEqual(Array.from(options, (option) => option.id), ['', ':error', ':warning']);
  await decorations[0].ui.onSelect(options[0], { sessionId: 's1' });
  // The request object is created inside the VM realm; compare primitives to
  // avoid cross-realm prototype rejection under deepStrictEqual.
  assert.deepEqual(
    emitted.map(([event, request]) => [event, request.text]),
    [['slash/input-insert-text', '/shell ']]
  );
  assert.equal(emitted[0][1].span.start, 0);
  assert.equal(emitted[0][1].span.end, 6);
  assert.equal(emitted[0][1].span.draftRev, 1);

  // The level prefix rides after the separating whitespace: DSH requires
  // whitespace after the command name, so /shell:error is never a command.
  await decorations[0].ui.onSelect(options[1], { sessionId: 's1' });
  assert.equal(emitted[1][1].text, '/shell :error ');
});
