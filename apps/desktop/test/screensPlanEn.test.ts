// Texts of the plan and addresses screens: the usual Spanish and the English say the same.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DICTIONARIES } from '../src/i18n/index.ts';

const en = DICTIONARIES.en.screensPlan;
const es = DICTIONARIES.es.screensPlan;

test('en screensPlan: texts with data', () => {
  assert.equal(en.plan.quotaOf(5), 'of 5');
  assert.equal(en.addresses.createdOn('Nov 14'), 'Created on Nov 14');
  assert.equal(en.nameOf('mailbox'), 'Mailbox name');
  assert.equal(en.nameOf('alias'), 'Alias name');
  assert.equal(en.newAddress.leftBefore + '1' + en.newAddress.leftMiddle + '5', 'Slots left: 1 of 5');
  assert.equal(en.newAddress.available('ana'), '“ana” is available');
  assert.equal(en.newAddress.unavailable('ana'), '“ana” isn\'t available. Try another name.');
  assert.equal(en.service.down(1), 'down (1 failed attempt)');
  assert.equal(en.service.down(3), 'down (3 failed attempts)');
});

test('en screensPlan: the fixed glossary', () => {
  assert.equal(en.addresses.seeMail, 'See mail');
  assert.equal(en.pending.title, 'In progress');
  assert.equal(en.service.title, 'Service status');
  assert.equal(en.service.midnightNetwork, 'Midnight network');
  assert.equal(en.wallet.opening, 'Opening the wallet');
  assert.equal(en.wallet.openingNote, 'The first time can take a while.');
  assert.equal(en.plan.opening, 'Opening the wallet…');
  assert.equal(en.plan.buyAnother, 'Buy another voucher');
  // The button is named without quotes.
  assert.equal(en.wallet.addressUnavailable, 'Not available right now. Press Refresh later.');
  assert.equal(
    en.wallet.faucetBlocked,
    'You need NIGHT. The fee is paid with DUST, which is generated from NIGHT. Send NIGHT to the address above and ' +
      'press Refresh.',
  );
  assert.equal(en.wallet.faucetDone, "NightMail tokens requested. If they don't show up yet, press Refresh in a few seconds.");
  for (const text of [en.wallet.addressUnavailable, en.wallet.faucetBlocked, en.wallet.faucetDone]) {
    assert.doesNotMatch(text, /[“”"]/, text);
  }
  assert.equal(en.wallet.refresh, 'Refresh');
});

test('en screensPlan: what it says about payment matches the Spanish', () => {
  // The amount and balance are shown in the test token, payment is with shielded tokens of the Midnight network
  // (Midnight's own term, owner 2026-11-26) and
  // the operator does not know who pays. No promise beyond that (no "leaves no trace"). The wallet intro is checked apart below: it says "fully privately".
  for (const text of [en.plan.paidFromWallet, en.plan.shieldedHint]) {
    assert.match(text, /shielded tokens on the Midnight network/);
    assert.match(text, /who's paying/);
    assert.doesNotMatch(text, /private tokens|trace/i);
  }
  for (const text of [es.plan.paidFromWallet, es.plan.shieldedHint]) {
    assert.match(text, /tokens protegidos de la red Midnight/);
    assert.match(text, /quién paga/);
    assert.doesNotMatch(text, /tokens privados|shielded|rastro/i);
  }
  assert.equal(en.plan.payShielded, 'Pay with shielded tokens…');
  assert.equal(es.plan.payShielded, 'Pagar con tokens protegidos…');
  assert.equal(
    es.wallet.intro,
    'Con ella puedes pagar el plan de forma totalmente privada, gracias a los tokens protegidos de la red Midnight.',
  );
  // The test token is called "NightMail token" in both languages, and it still says it has no real value.
  // The amounts take the plural, the brand keeps its capitals.
  assert.equal(en.plan.amount('100'), '100 NightMail tokens');
  assert.equal(es.plan.amount('100'), '100 NightMail tokens');
  assert.equal(en.plan.amount('0'), '0 NightMail tokens');
  assert.equal(en.plan.amount('1'), '1 NightMail token');
  assert.equal(es.plan.amount('1'), '1 NightMail token');
  assert.equal(en.wallet.tokenName, 'NightMail token (test currency)');
  assert.equal(es.wallet.tokenName, 'NightMail token (moneda de prueba)');
  assert.equal(en.wallet.requestToken, 'Request NightMail tokens');
  assert.equal(es.wallet.requestToken, 'Pedir NightMail tokens de prueba');
  assert.equal(
    en.wallet.tokenNote,
    "The NightMail token is a test currency with no real value. It's used to pay for the plan on this test network.",
  );
  // The paid plan is "Night Plus" in both languages.
  assert.equal(en.plan.paid, 'Night Plus');
  assert.equal(es.plan.paid, 'Night Plus');
  assert.equal(en.plan.paidTitle, 'Night Plus');
  assert.equal(es.plan.paidTitle, 'Night Plus');
  assert.equal(en.wallet.intro, 'With it you can pay for the plan fully privately, thanks to shielded tokens on the Midnight network.');
  assert.equal(es.wallet.intro, 'Con ella puedes pagar el plan de forma totalmente privada, gracias a los tokens protegidos de la red Midnight.');
  assert.match(en.wallet.intro, /shielded tokens/);
  assert.doesNotMatch(en.wallet.intro, /private tokens|trace/i);
  assert.match(en.wallet.tokenNote, /no real value/);
  assert.match(es.wallet.tokenNote, /sin valor real/);
  assert.match(en.pending.cancelBody, /slot in your plan becomes free/);
  assert.match(es.pending.cancelBody, /hueco en tu plan queda libre/);
  assert.match(en.newAddress.proofNote, /^It may take a while. You can keep reading your mail.$/);
  assert.match(es.newAddress.proofNote, /^Puede tardar. Mientras, puedes seguir leyendo tu correo.$/);
});

test('es screensPlan: the usual Spanish', () => {
  assert.equal(es.plan.quotaOf(5), 'de 5');
  assert.equal(es.addresses.createdOn('14 nov'), 'Creado el 14 nov');
  assert.equal(es.nameOf('buzón'), 'Nombre del buzón');
  assert.equal(es.newAddress.leftBefore + '1' + es.newAddress.leftMiddle + '5', 'te quedan 1 de 5');
  assert.equal(es.newAddress.available('ana'), '«ana» está disponible');
  assert.equal(es.service.down(1), 'caído (1 intento fallido)');
  assert.equal(es.service.down(3), 'caído (3 intentos fallidos)');
  assert.equal(es.addresses.seeMail, 'Ver correo');
  assert.equal(es.wallet.addressUnavailable, 'Ahora no está disponible. Pulsa Actualizar más tarde.');
  assert.equal(es.wallet.faucetDone, 'Se han pedido NightMail tokens. Si aún no aparecen, pulsa Actualizar en unos segundos.');
  assert.equal(
    es.wallet.faucetBlocked,
    'Necesitas NIGHT. La comisión se paga con DUST, que se genera a partir del NIGHT. Envía NIGHT a la dirección de ' +
      'arriba y pulsa Actualizar.',
  );
  assert.equal(es.wallet.tokenNote, 'El NightMail token es una moneda de prueba, sin valor real. Sirve para pagar el plan en esta red de pruebas.');
  assert.equal(es.addresses.createdBold + es.addresses.createdRest, 'Dirección creada. Ya puede recibir correo. Nadie puede relacionarla con tus otras direcciones.');
});
