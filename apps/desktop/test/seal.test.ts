// Pure rules of the sender seal and its texts: `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DICTIONARIES } from '../src/i18n/index.ts';
import { senderSeal } from '../src/seal.ts';

test('senderSeal: the verified seal needs e2e and a checked sender', () => {
  assert.equal(senderSeal({ e2e: true, senderVerified: true }), 'verified');
});

test('senderSeal: sealed but unchecked shows the warning', () => {
  assert.equal(senderSeal({ e2e: true, senderVerified: false }), 'unverified');
});

test('senderSeal: SMTP mail carries no seal, not even if the flag were set', () => {
  assert.equal(senderSeal({ e2e: false, senderVerified: false }), 'none');
  assert.equal(senderSeal({ e2e: false, senderVerified: true }), 'none');
});

test('seal texts exist in both languages and avoid forbidden characters', () => {
  const keys = ['sealVerified', 'sealUnverifiedTitle', 'sealUnverified', 'sealVerifiedShort', 'sealUnverifiedShort'] as const;
  for (const locale of ['es', 'en'] as const) {
    const reader = DICTIONARIES[locale].screensMail.reader;
    for (const key of keys) {
      const text = reader[key];
      assert.ok(text.trim() !== '', `${locale}.${key}`);
      assert.doesNotMatch(text, /[;—]|\/\//, `${locale}.${key}`);
    }
  }
  assert.equal(DICTIONARIES.es.screensMail.reader.sealVerified, 'Cifrado de punta a punta · remitente comprobado');
});
