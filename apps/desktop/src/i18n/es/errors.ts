// Spanish texts of the `errors` namespace.
// This is the shape `en/errors.ts` must repeat.
//
// The logic (which code says what, which "safe" sentence goes with which path) lives in `src/errors.ts`; only the
// words are here. "What is still safe" is not a template: each code claims only what the core guarantees on every path
// by which that code arrives (`src-tauri/src/**`), and when nothing true can reassure, it is `null`. English must have
// `null` in the same places and claim no more and no less. Written literally: no light metaphors, no exclamation
// marks, informal "tu" and short sentences.
import type { ErrorText } from '../../errors.ts';
import { PAID_PLAN, TOKEN_NAME_PLURAL } from '../brand.ts';

/** An error in three parts; a `null` part is not stored (a dictionary holds no `null`). `tsc` does not check that English omits
 *  the same ones (the parts are optional): the tests do at run time
 *  (`test/i18n.test.ts` compares the keys and `test/pure.test.ts` the parts of each error). */
const parts = (what: string, safe: string | null, action: string | null): ErrorText => ({
  what,
  ...(safe === null ? {} : { safe }),
  ...(action === null ? {} : { action }),
});

/** The payment is rejected before it is built, and the sidecar only builds one if no other for the same bono can land. */
const NOT_PAID = 'No se ha pagado nada.';

const RETRY = 'Vuelve a intentarlo.';
const RETRY_SOON = 'Vuelve a intentarlo en un momento.';
const OTHER_NAME = 'Elige otro nombre.';

/** What is not known: nothing is claimed to still be safe. */
const GENERIC = parts('Ha ocurrido un error inesperado.', null, RETRY);

/** `storage` (application layer) and `store` (orchestrator): they can arrive midway through an operation, also after a payment. */
const STORAGE = parts(
  'No se han podido leer o guardar los datos de la app en este dispositivo.',
  null,
  'Cierra la app y ábrela de nuevo.',
);

export default {
  generic: GENERIC,
  retry: RETRY,
  retrySoon: RETRY_SOON,
  otherName: OTHER_NAME,

  // One message per code without data; `errors.ts` forces them all to be covered.
  simple: {
    // --- Seed phrase and session
    noSeed: parts(
      'Todavía no hay una frase semilla en este dispositivo.',
      null,
      'Crea una o restaura la tuya con sus 24 palabras.',
    ),
    seedExists: parts('Ya hay una frase semilla en este dispositivo.', null, 'Desbloquea con tu contraseña.'),
    wrongPassword: parts('Contraseña incorrecta.', null, RETRY),
    invalidPhrase: parts(
      'La frase semilla no es válida.',
      null,
      'Revisa que estén las 24 palabras, en su orden y sin erratas.',
    ),
    emptyPassword: parts('La contraseña no puede estar vacía.', null, 'Escribe una contraseña.'),
    // On Unix it is rejected with nothing fixed. On Windows the app tries to close them itself and only gets here if it
    // cannot (see `fsutil.rs`).
    insecureFiles: parts(
      'Los ficheros de NightMail en este dispositivo no son privados, así que la app no los abre.',
      null,
      'Haz que solo tu usuario pueda leerlos y cambiarlos, y vuelve a abrir la app.',
    ),
    outOfMemory: parts(
      'A este dispositivo le falta memoria libre para trabajar con la frase semilla.',
      null,
      'Cierra otras aplicaciones y vuelve a intentarlo.',
    ),
    notUnlocked: parts('NightMail está bloqueado.', null, 'Desbloquéalo con tu contraseña.'),
    alreadyUnlocked: parts('NightMail ya está desbloqueado.', null, null),
    badConfig: parts(
      'Faltan ajustes de la app o no son válidos.',
      null,
      'Revisa la configuración y vuelve a abrir la app.',
    ),
    profileInUse: parts(
      'Este perfil ya está abierto en otra ventana de NightMail.',
      null,
      'Usa esa ventana o ciérrala y vuelve a abrir la app.',
    ),
    storage: STORAGE,
    notFound: parts('No se ha encontrado ese mensaje.', null, 'Vuelve a la bandeja.'),
    invalidInput: parts('Ese dato no es válido o es demasiado largo.', null, 'Corrígelo y vuelve a intentarlo.'),
    sessionBusy: parts(
      'Ahora no se puede bloquear: hay una operación en marcha.',
      null,
      'Espera a que termine y vuelve a bloquear.',
    ),
    recoveryPending: parts(
      'La restauración no ha terminado.',
      'Tu frase semilla ya está guardada y cifrada en este dispositivo.',
      'Termina la restauración. Después podrás usar el plan y las direcciones.',
    ),
    noTestToken: parts(`En esta red no se pueden pedir ${TOKEN_NAME_PLURAL} de prueba.`, null, null),
    internal: GENERIC,
    // --- Connection to Midnight
    midnightUnavailable: parts('Ahora mismo no hay conexión con Midnight.', null, RETRY_SOON),
    midnightRestarting: parts('Midnight se está reiniciando.', null, 'Vuelve a intentarlo en unos segundos.'),
    midnightTimeout: parts('Midnight no ha respondido a tiempo.', null, RETRY),
    // Fails when starting the connection: true of NOW (the pending notice may carry a payment from another session).
    sidecarTooOld: parts(
      'La parte de NightMail que conecta con Midnight es más antigua que esta app.',
      'Ahora no se ha enviado ni pagado nada.',
      'Vuelve a instalar NightMail.',
    ),
    contractMismatch: parts(
      'Esta versión de NightMail no coincide con el servicio en Midnight.',
      null,
      'Comprueba si hay una versión nueva de NightMail.',
    ),
    // It also appears while waiting for a payment ALREADY sent (the time is checked on each read).
    clock: parts(
      'La hora de este dispositivo no coincide con la de Midnight.',
      null,
      'Pon el dispositivo en hora y vuelve a intentarlo.',
    ),
    // It can arrive while waiting for a bono ALREADY paid.
    staleState: parts(
      'Los datos que llegan de Midnight están atrasados o no cuadran.',
      null,
      'Vuelve a sincronizar y repite la operación.',
    ),
    // --- Plan and bonos
    alreadyHasPlan: parts(
      'Ya tienes el plan gratis. Solo hay uno por frase semilla.',
      null,
      `Si necesitas más direcciones, mira el plan ${PAID_PLAN}.`,
    ),
    busy: parts('Hay otra operación de plan o de cartera en marcha.', null, 'Espera a que termine y vuelve a intentarlo.'),
    // It answered "busy", with an error or halfway: the service may have taken the request as good.
    serviceUnavailable: parts('El servicio no está disponible ahora mismo.', null, 'Vuelve a intentarlo en unos minutos.'),
    // No answer arrived (connection refused or unanswered): most likely the server is not running.
    serverUnreachable: parts('El servidor de NightMail no responde.', null, 'Vuelve a intentarlo en unos minutos.'),
    // The issuer checks the verification and the card BEFORE creating the request: it holds for THIS attempt (an
    // earlier attempt for the same bono may have been accepted, and charged, before issuing failed).
    captchaFailed: parts('No se ha superado la verificación.', 'Con este intento no se ha emitido ningún bono.', RETRY),
    paymentFailed: parts(
      'El pago con tarjeta no se ha aceptado.',
      'Este intento no ha cobrado nada.',
      'Vuelve a intentarlo, o cancela el pago pendiente para pagar de otra forma.',
    ),
    // Here the service DID accept the request: nothing is claimed about what was charged.
    issueFailed: parts('El servicio no ha podido emitir el bono.', null, 'Vuelve a pedirlo.'),
    badReceipt: parts(
      'El servicio ha dado un recibo que no se puede comprobar. No sabemos si tu petición ha quedado registrada.',
      null,
      'Vuelve a intentarlo más tarde.',
    ),
    // It also arrives when YOUR operation had not even started: the bono is claimed by another payment method, and waiting
    // does not fix that (that payment must be repeated or abandoned). Repeating uses the same bono identifier or the same
    // slot: there is no second charge nor second slot.
    stillPending: parts(
      'Hay una operación pendiente que todavía no se ve terminada en Midnight.',
      'Sigue guardada. Repetirla no paga ni gasta dos veces.',
      'Espera unos minutos y vuelve a intentarlo. Si es un pago y quieres hacerlo de otra forma, cancela antes el pago ' +
        'pendiente.',
    ),
    priceChanged: parts('El precio ha cambiado.', NOT_PAID, 'Revisa el precio nuevo y vuelve a pagar.'),
    store: STORAGE,
    // --- Addresses
    nameTaken: parts('Ese nombre ya está en uso.', null, OTHER_NAME),
    // It also appears with no plan at all.
    noFreeSlot: parts(
      'No tienes huecos libres para crear direcciones.',
      null,
      'Para crear más, mira las opciones de «Plan y cartera».',
    ),
    // No "agotado". What happened and what to do: "Reintentar ahora" does not fix it.
    attemptsExhausted: parts(
      'La dirección se ha detenido después de varios intentos.',
      null,
      'Para volver a intentarlo, pulsa Reanudar en «Direcciones».',
    ),
    slotBurned: parts(
      'Ese hueco ya no sirve: se gastó sin llegar a dar una dirección.',
      null,
      'Si te quedan huecos, crea la dirección de nuevo.',
    ),
    needsName: parts(
      'Falta el nombre de un buzón.',
      null,
      'Escribe el nombre tal como lo elegiste y comprobaremos que coincide.',
    ),
    wrongName: parts('Ese nombre no es el de este buzón.', null, 'Escríbelo tal como lo elegiste.'),
    // Deterministic (it comes from fixed keys): repeating gives the same, so nothing is proposed.
    aliasSuffixTaken: parts('No se ha podido crear el alias: su terminación ya la usa otro alias.', null, null),
    // The attempt was already counted on the slot, so it is not released: it stays half-done.
    relayerRefused: parts(
      'El servicio que envía las operaciones a Midnight ha rechazado esta.',
      'La dirección queda sin terminar, guardada en este dispositivo.',
      'Vuelve a intentarlo más tarde desde «En proceso».',
    ),
    // --- Links: the text already says it does not open (fixed by `test/links.test.ts`).
    linkTooLong: parts('Este enlace no se abre porque es demasiado largo.', null, null),
    linkHiddenChars: parts('Este enlace no se abre porque tiene espacios o caracteres ocultos.', null, null),
    linkMalformed: parts('Este enlace no se abre porque no es una dirección web válida.', null, null),
    linkScheme: parts('Este enlace no se abre. Solo se abren direcciones web (https o http).', null, null),
    linkCredentials: parts('Este enlace no se abre porque esconde un usuario o una contraseña.', null, null),
    linkLocal: parts(
      'Este enlace apunta a tu propio equipo o a una red privada y no se puede abrir desde aquí.',
      null,
      null,
    ),
    browserFailed: parts('No se ha podido abrir el navegador.', null, null),
    // --- Sending mail (`send_mail`): the core answers these only when nothing was stored or sent, but nothing is
    // claimed about it (no comforting sentence). The form also uses them for its own checks before sending.
    senderUnavailable: parts('La dirección elegida en «De» no puede enviar correo ahora mismo.', null, 'Elige otra dirección.'),
    subjectInvalid: parts(
      'El asunto es demasiado largo o tiene caracteres ocultos que no se pueden enviar.',
      null,
      'Acórtalo o, si lo has pegado de otro sitio, escríbelo de nuevo.',
    ),
    bodyInvalid: parts(
      'El mensaje tiene caracteres ocultos que no se pueden enviar.',
      null,
      'Si has pegado el texto de otro sitio, escríbelo de nuevo.',
    ),
    messageTooLarge: parts('El mensaje es demasiado grande para enviarlo.', null, 'Acórtalo y vuelve a intentarlo.'),
    recipientInvalid: parts('Esa dirección no es válida.', null, 'Comprueba que está bien escrita.'),
    recipientForeignDomain: parts(
      'Por ahora solo se puede enviar a direcciones de NightMail.',
      null,
      'Comprueba lo que va después de la arroba (@).',
    ),
    recipientNotFound: parts('No se ha encontrado esa dirección en NightMail.', null, 'Comprueba que está bien escrita.'),
    // Its keys cannot receive mail (or two aliases share its ending): repeating gives the same, so nothing is proposed.
    recipientUnusable: parts('Esa dirección existe, pero ahora mismo no puede recibir correo.', null, null),
    registryUnavailable: parts(
      'No se ha podido comprobar la dirección de destino en Midnight.',
      null,
      'Vuelve a intentarlo en unos minutos.',
    ),
    registryStale: parts(
      'No se ha podido comprobar la dirección de destino porque los datos de Midnight no están al día.',
      null,
      RETRY_SOON,
    ),
    registryClock: parts(
      'La fecha y la hora de este equipo no coinciden con las de Midnight.',
      null,
      'Corrígelas y vuelve a intentarlo.',
    ),
    serverTimeUnavailable: parts(
      'No se ha podido obtener la hora del servidor de NightMail.',
      null,
      'Vuelve a intentarlo en unos minutos.',
    ),
  },

  // --- Codes with data

  /** A wait in words (`errors.ts` decides whether seconds or minutes). */
  wait: {
    moment: 'un momento',
    seconds: (n: number) => `${n} s`,
    minutes: (n: number) => `${n} min`,
  },

  // Unlocking, viewing the phrase or changing the password after 5 failures in a row: the core sets the wait.
  tooManyAttempts: {
    what: 'Demasiados intentos.',
    action: (wait: string) => `Espera ${wait} y vuelve a probar.`,
  },

  // It almost always appears before choosing a slot, but can also arrive on finishing a mailbox ALREADY reserved.
  nameRejected: {
    what: (problem: string) => `Ese nombre ${problem}.`,
    problem: {
      invalid: 'no es válido',
      'alias-form': 'tiene forma de alias',
      reserved: 'está reservado',
    },
    /** A reason this version does not know. */
    unknown: 'no se admite',
  },

  /** The bono is on chain (confirmed), but the core does not let it be used yet. The time is a minimum, not a
   *  promise: the core may also require other bonos to land after yours. */
  bonoNotReady: {
    safe: 'El bono está confirmado. Solo falta esperar.',
    what: 'Tu bono aún no se puede usar.',
    action: 'Vuelve a intentarlo más tarde.',
    whatBefore: (at: string) => `Tu bono no se puede usar antes del ${at}.`,
    actionAfter: 'Vuelve a intentarlo a partir de entonces.',
  },

  callRejected: {
    what: (problem: string) => `La operación no se puede hacer: ${problem}.`,
    problem: {
      // No "todavía": it does not clear by itself (and each repetition counts an attempt), so waiting is not suggested.
      'not-a-bono': 'Midnight no reconoce tu bono',
      'no-slots-left': 'no quedan huecos en tu plan',
      'slot-already-used': 'ese hueco ya se había usado',
      'stale-round': 'el plazo para reservar el nombre ya había pasado',
      'not-reserved': 'el nombre no estaba reservado',
      'wrong-reveal': 'los datos no coinciden con los de la reserva',
      'too-early': 'todavía es pronto para terminar el buzón',
      'address-taken': 'el nombre ya es de otra dirección',
      'wrong-token': 'el token no es el que se pide',
      'wrong-amount': 'el importe no es el precio actual',
      'old-price-expired': 'el precio que aceptaste ya ha caducado',
      other: 'no ha pasado una comprobación',
    },
  },

  // It can arrive with a request already accepted (on asking about it): it is not claimed that it did not go out.
  rateLimited: {
    what: 'Hay demasiadas peticiones ahora mismo.',
    action: (wait: string) => `Vuelve a intentarlo dentro de ${wait}.`,
  },

  insufficientFunds: {
    // DUST is missing when balancing the payment, before signing and sending it.
    dust: parts(
      'A la cartera de pago le falta DUST para la comisión.',
      NOT_PAID,
      'El DUST se genera solo a partir del NIGHT: envía NIGHT a la cartera o, si ya tiene, espera unos minutos.',
    ),
    // The app does not show how to receive the token: from it, it is only added with the test networks' faucet.
    token: parts(
      'No hay saldo suficiente en la cartera de pago.',
      NOT_PAID,
      `Si estás en una red de pruebas, pide ${TOKEN_NAME_PLURAL} desde la cartera y vuelve a intentarlo.`,
    ),
    /** A balance this version does not know: which step lacked it is unknown, so nothing is claimed to still be safe. */
    unknown: parts('A la cartera de pago le falta saldo.', null, 'Revisa la cartera y vuelve a intentarlo.'),
  },

  wallet: {
    what: (problem: string) => `La cartera de pago no está disponible: ${problem}.`,
    problem: {
      'not-open': 'no está abierta',
      'already-open': 'ya está abierta',
      'in-use': 'la está usando otro programa',
      'not-synced': 'aún se está sincronizando',
    },
    unknown: 'motivo desconocido',
    /** What to do if another program holds it: after a restart the wallet lock is released by itself. */
    inUseAction: 'Si hay otra ventana de NightMail abierta, ciérrala. Si no hay ninguna, espera un momento y vuelve a intentarlo. Si se repite, reinicia el equipo.',
    /** Only for the reasons the wallet gives BEFORE building a payment (`errors.ts`). */
    notPaid: 'Este intento no ha pagado nada.',
  },

  // It only comes from Midnight's health query, which changes nothing.
  midnightError: {
    what: 'Midnight ha devuelto un error.',
    /** With the JSON-RPC code, if it arrives well formed. */
    withCode: (code: number) => `Midnight ha devuelto un error (código ${code}).`,
  },
};
