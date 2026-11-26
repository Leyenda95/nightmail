import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, errorKind } from '../src/log.ts';

test('errorKind: error name and code, never its message', () => {
  assert.equal(errorKind(new TypeError('fetch failed http://x?project_id=SECRETO')), 'TypeError');
  assert.equal(errorKind(Object.assign(new Error('database is full: /home/u/mail.sqlite'), { code: 'ERR_SQLITE_ERROR' })), 'Error/ERR_SQLITE_ERROR');
  assert.equal(errorKind(Object.assign(new Error('x'), { code: 'not a code /secreto' })), 'Error', 'an odd code is not copied');
  assert.equal(errorKind(Object.assign(new Error('x'), { code: 13 })), 'Error');
  assert.equal(errorKind(Object.assign(new Error('disk full: /x'), { code: 'ERR_SQLITE_ERROR', errcode: 13 })), 'Error/ERR_SQLITE_ERROR/13');
  assert.equal(errorKind(Object.assign(new Error('x'), { errcode: '13' })), 'Error', 'an errcode that is not a number is not copied');
  assert.equal(errorKind('cadena'), 'unknown');
});

test('createLogger: debug only when asked', () => {
  const lines: string[] = [];
  const quiet = createLogger(false, (l) => lines.push(l));
  quiet.info('a');
  quiet.warn('b');
  quiet.debug('c');
  createLogger(true, (l) => lines.push(l)).debug('d');
  assert.deepEqual(lines, ['[mail] a', '[mail] WARN b', '[mail] debug d']);
});
