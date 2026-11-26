// Mailbox names: normalization, alias shape and reserved names (a single definition).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addrKey, InvalidInput, mailboxName, nameBytes, NameRejected, RESERVED_NAMES } from '../src/index.ts';

const problem = (name: string) => {
  try {
    mailboxName(name);
  } catch (e) {
    assert.ok(e instanceof NameRejected && e instanceof InvalidInput, String(e));
    return e.problem;
  }
  return 'ok';
};

test('mailboxName normalizes and accepts a normal mailbox name', () => {
  assert.equal(mailboxName('Juan.Perez'), 'juan.perez');
  assert.equal(mailboxName('ana_2-b'), 'ana_2-b');
  assert.equal(mailboxName('a'.repeat(64)), 'a'.repeat(64));
});

test('mailboxName rejects the alias shape (it would only resolve as an alias)', () => {
  for (const name of ['around.rubber.hc9n6db283sn', 'Juan.ABCDEFGHIJKL', 'x.000000000000', 'juan_perez.iiiiiiiiiiii']) {
    assert.equal(problem(name), 'alias-form', name);
  }
  assert.equal(problem('juan.abcdefghijk'), 'ok', '11 characters is not an alias shape');
});

test('mailboxName rejects reserved names (also in uppercase)', () => {
  for (const name of ['postmaster', 'Admin', 'ADMINISTRATOR', 'abuse', 'no-reply', 'noreply', 'mailer-daemon', 'root', 'info']) {
    assert.equal(problem(name), 'reserved', name);
  }
  assert.equal(problem('post.master'), 'ok', 'dots are significant');
  assert.equal(problem('admins'), 'ok');
});

test('mailboxName: what is not a valid name is "invalid"', () => {
  for (const name of ['', 'a..b', 'a.-b', 'juan perez', 'a'.repeat(65), 'josé']) assert.equal(problem(name), 'invalid', name);
});

test('the reserved list: RFC 2142, those of certificate authorities and mail ones', () => {
  for (const name of ['postmaster', 'hostmaster', 'webmaster', 'admin', 'administrator', 'abuse', 'security', 'root',
    'noreply', 'no-reply', 'mailer-daemon', 'info', 'support', 'sales', 'marketing', 'noc', 'usenet', 'news', 'www', 'uucp', 'ftp']) {
    assert.ok(RESERVED_NAMES.has(name), name);
  }
  for (const name of RESERVED_NAMES) assert.equal(problem(name), 'reserved', name);
});

test('nameBytes and addrKey only accept mailbox names', () => {
  assert.equal(Buffer.from(nameBytes('Ana')).subarray(0, 4).toString('latin1'), 'ana\0');
  for (const name of ['admin', 'x.000000000000', 'a..b']) {
    assert.throws(() => nameBytes(name), NameRejected, name);
    assert.throws(() => addrKey(name), NameRejected, name);
  }
});
