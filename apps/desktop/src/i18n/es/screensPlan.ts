// Spanish texts of the `screensPlan` namespace: plan and addresses screens.
// This is the shape `en/screensPlan.ts` must repeat.
//
// Texts that belong to another namespace (`mail.unnamedAddress`,
// `screensMail.sidebar.yourAddresses`...) are read from there and not repeated here.
import { PAID_PLAN, TOKEN_NAME, TOKEN_NAME_PLURAL, tokenAmount } from '../brand.ts';
import { plural } from '../locale.ts';

const REFRESH = 'Actualizar';

export default {
  // Words used by several screens.
  checking: 'Comprobando…',
  cancel: 'Cancelar',
  nameNotRead: 'No hemos podido leer su nombre. Escríbelo tal como lo elegiste y comprobaremos que coincide.',
  /** "Nombre del buzón": `what` is only the kind, from `slotKindName` ("buzón", "alias"). Never "buzón ana": in English
   *  the word order would break. */
  nameOf: (what: string): string => `Nombre del ${what}`,
  /** `staleState` in what creates an address (create, resume, provide the name): the app has already synced again on
   *  its own (`explainAfterSync`), so the text does not send the user to a button. */
  staleAfterSync:
    'Los datos que llegan de Midnight siguen atrasados o no cuadran, aunque la app ya ha vuelto a sincronizar. ' +
    'Vuelve a intentarlo dentro de unos minutos.',
  // PlanSection.tsx
  plan: {
    keepWaiting: 'No, seguir esperando',
    free: 'gratis',
    paid: PAID_PLAN,
    title: 'Tu plan',
    quotaOf: (limit: number): string => `de ${limit}`,
    price: 'Precio',
    balance: 'Tu saldo',
    paidFromWallet:
      'Se paga desde tu cartera de pago, con tokens privados de la red Midnight: el operador no sabe quién paga.',
    confirmPayment: 'Confirmar el pago',
    paidTitle: PAID_PLAN,
    shieldedHint: 'Con tokens privados de la red Midnight: el operador no sabe quién paga',
    payShielded: 'Pagar con tokens privados…',
    // The price and the balance, in the test token ("1 NightMail token", "100 NightMail tokens").
    amount: tokenAmount,
    cardHint: 'Con tarjeta (simulado en esta versión)',
    fiatMonthly: 'Pago simulado mensual',
    fiatAnnual: 'Pago simulado anual',
    freeTitle: 'Gratis',
    requestFree: 'Pedir el plan gratis',
    buyAnother: 'Comprar otro bono',
    opening: 'Abriendo la cartera…',
  },
  // WalletSection.tsx
  wallet: {
    title: 'Cartera de pago',
    intro:
      'Desde ella puedes pagar el plan con tokens privados de la red Midnight: el operador cobra sin saber quién paga. ' +
      'Las comisiones se pagan con DUST, que genera el NIGHT de la cartera.',
    dustInfo:
      'El DUST es un recurso que sirve para pagar las comisiones. Se regenera solo a partir del NIGHT de la cartera.',
    dustInfoLabel: 'Qué es el DUST',
    tokenName: `${TOKEN_NAME} (moneda de prueba)`,
    receiveNight: 'Dirección para recibir NIGHT',
    addressUnavailable: `Ahora no está disponible. Pulsa ${REFRESH} más tarde.`,
    refresh: REFRESH,
    view: 'Ver cartera',
    requestToken: `Pedir ${TOKEN_NAME_PLURAL} de prueba`,
    tokenNote: `El ${TOKEN_NAME} es una moneda de prueba, sin valor real. Sirve para pagar el plan en esta red de pruebas.`,
    faucetBlocked:
      'Necesitas NIGHT. La comisión se paga con DUST, que se genera a partir del NIGHT. Envía NIGHT a la dirección de ' +
      `arriba y pulsa ${REFRESH}.`,
    faucetDone: `Se han pedido ${TOKEN_NAME_PLURAL}. Si aún no aparecen, pulsa ${REFRESH} en unos segundos.`,
    waitForPlan: 'Espera a que termine la operación del plan.',
    opening: 'Abriendo la cartera',
    openingNote: 'La primera vez puede tardar.',
  },
  // AddressesSection.tsx
  addresses: {
    new: 'nuevo',
    createdOn: (day: string): string => `Creado el ${day}`,
    seeMail: 'Ver correo',
    createdBold: 'Dirección creada.',
    createdRest: ' Ya puede recibir correo. Nadie puede relacionarla con tus otras direcciones.',
  },
  // PendingSection.tsx
  pending: {
    keepGoing: 'No, seguir',
    yesCancel: 'Sí, cancelar',
    cancelTitle: '¿Cancelar la creación?',
    cancelBody: 'Todavía no se había terminado de crear. Su hueco en tu plan queda libre para otra dirección.',
    title: 'En proceso',
  },
  // NewAddress.tsx
  newAddress: {
    leftBefore: 'te quedan ',
    leftMiddle: ' de ',
    available: (name: string): string => `«${name}» está disponible`,
    unavailable: (name: string): string => `«${name}» no está disponible. Prueba con otro nombre.`,
    viewPlans: 'Ver planes',
    mailbox: 'Buzón',
    alias: 'Alias',
    youChoose: 'Tú eliges el nombre.',
    mailboxName: 'Nombre del buzón',
    creating: 'Creando…',
    createMailbox: 'Crear buzón',
    check: 'Comprobar',
    createAlias: 'Crear alias',
    aliasNote: 'Nombre al azar, para registrarte en webs o dar una dirección de usar y tirar.',
    proofNote: 'Puede tardar. Mientras, puedes seguir leyendo tu correo.',
  },
  // ProvideName.tsx
  provideName: {
    save: 'Guardar nombre',
  },
  // ServiceStatus.tsx
  service: {
    title: 'Estado del servicio',
    down: (failures: number): string =>
      `caído (${plural(failures, { one: '1 intento fallido', other: `${failures} intentos fallidos` }, 'es')})`,
    noConnection: 'sin conexión, el componente que habla con Midnight no contesta',
    midnightNetwork: 'Red de Midnight',
    server: 'Servidor de NightMail',
    checkConnection: 'Comprobar conexión',
  },
};
