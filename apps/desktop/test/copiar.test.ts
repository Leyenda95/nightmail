// "Copiar": `copyText` and the `Copiable` notice. `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyStatus, copyText } from '../src/pieces.ts';

const never = () => {
  throw new Error('should not have been called');
};

test('copyText: uses the clipboard and does not touch plan B', async () => {
  const written: string[] = [];
  const ok = await copyText('abc', { writeText: async (t) => void written.push(t), selectAndCopy: never });
  assert.equal(ok, true);
  assert.deepEqual(written, ['abc']);
});

test('copyText: if the clipboard fails or does not exist, tries select and copy', async () => {
  const denied = async () => Promise.reject(new Error('denegado'));
  assert.equal(await copyText('abc', { writeText: denied, selectAndCopy: () => true }), true);
  assert.equal(await copyText('abc', { selectAndCopy: () => true }), true);
});

test('copyText: if nothing works it returns false and does not throw', async () => {
  assert.equal(await copyText('abc', { selectAndCopy: () => false }), false);
  assert.equal(
    await copyText('abc', {
      selectAndCopy: () => {
        throw new Error('x');
      },
    }),
    false,
  );
});

test('copyStatus: "Copiada", the manual way out if it fails and nothing at rest', () => {
  assert.equal(copyStatus('idle'), '');
  assert.equal(copyStatus('ok'), 'Copiada');
  assert.match(copyStatus('fail'), /Ctrl\+C/);
});
