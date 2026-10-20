import test from 'node:test';
import assert from 'node:assert/strict';
import { copyText } from '../public/clipboard.js';

function fallbackDocument(result = true) {
  const state = { removed: false, copied: false };
  const textarea = { style: {}, setAttribute() {}, select() {}, remove() { state.removed = true; } };
  return { state, document: {
    createElement: () => textarea,
    body: { append() {} },
    execCommand(command) { assert.equal(command, 'copy'); state.copied = true; return result; }
  } };
}
test('clipboard success does not need fallback', async () => {
  let copied;
  await copyText('calendar', { navigator: { clipboard: { writeText: async value => { copied = value; } } }, document: null });
  assert.equal(copied, 'calendar');
});
test('clipboard rejection falls back and cleans up', async () => {
  const { state, document } = fallbackDocument();
  await copyText('calendar', { navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } }, document });
  assert.deepEqual(state, { removed: true, copied: true });
});
test('failed legacy copy reports failure and cleans up', async () => {
  const { state, document } = fallbackDocument(false);
  await assert.rejects(copyText('calendar', { navigator: {}, document }), /Unable to copy/);
  assert.equal(state.removed, true);
});
