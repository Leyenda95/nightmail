// Spanish texts of the `status` namespace: states and pending items.
// This is the shape `en/status.ts` must repeat.
//
// Only the words are here: which stage or code gets which text (and why) is stated by the `src/` modules. The
// names of buttons that appear inside a sentence (`pending.button`, `notices.retryNow`) are the same source as the
// button, so the sentence never names one that is not there.
import type { ProgressText } from '../../progress.ts';
import { PAID_PLAN, TOKEN_NAME_PLURAL, tokenAmount } from '../brand.ts';
import { plural } from '../locale.ts';

/** A stage: the headline and, if there is one, the note (a `null` one is not stored: a dictionary holds no `null`).
 *  English must carry a note on the same stages (checked by `test/i18n.test.ts`). */
const stage = (title: string, note: string | null): ProgressText => (note === null ? { stage: title } : { stage: title, note });

const RETRY = 'Reintentar';
const RESUME = 'Reanudar';
const RETRY_NOW = 'Reintentar ahora';

export default {
  // progress.ts
  progress: {
    stages: {
      queued: stage('En cola', 'Hay otra operación de dirección en marcha. Esta empieza cuando termine.'),
      requestingBono: stage('Pidiendo el bono', null),
      waitingIssuer: stage('Esperando a que se emita el bono', null),
      waitingInclusion: stage('Esperando a que el bono entre en la cadena', 'Cuando entre, el bono quedará confirmado.'),
      walletSyncing: stage('Sincronizando la cartera', 'La primera vez puede tardar.'),
      registeringDust: stage(
        'Registrando el NIGHT para generar DUST',
        'El DUST paga las comisiones. Lo genera el NIGHT de la cartera y puede tardar en aparecer.',
      ),
      paying: stage(
        'Pagando',
        'Midnight tiene que confirmar el pago y la confirmación puede tardar. Mientras tanto, puedes seguir leyendo tu ' +
          'correo.',
      ),
      proving: stage(
        'Generando la prueba',
        'Se calcula en este dispositivo, con datos recién leídos de Midnight. Es un cálculo pesado: por eso tarda.',
      ),
      relaying: stage('Enviando a Midnight', 'Esperando a que Midnight confirme la operación.'),
      retrying: stage('Reintentando', 'Un servicio no ha podido atender la petición. Se vuelve a probar tras una pausa.'),
      serverUnreachable: stage('No se puede contactar con el servidor de NightMail', 'Se vuelve a probar tras una pausa.'),
      waitingDust: stage(
        'Esperando a que la cartera genere DUST para la comisión',
        'El DUST se genera solo a partir del NIGHT de la cartera.',
      ),
      walletStateDiscarded: stage(
        'Recuperando los datos de la cartera',
        'Parte de los datos guardados de la cartera no se ha podido usar. Puede tardar más que otras veces.',
      ),
      addressReady: stage('Dirección lista', null),
      recovering: stage('Buscando tus bonos en Midnight', 'Tu frase semilla ya está guardada y cifrada en este dispositivo.'),
    },
    bonoReady: stage('Bono confirmado', null),
    waitingRound: stage(
      'Falta un último paso',
      'Suele tardar unos minutos.',
    ),
    unknown: stage('En marcha', null),
  },

  // pending.ts
  pending: {
    // Lowercase: `pendingParts` capitalises the headline.
    stage: {
      reserving: { mailbox: 'reservando el nombre', alias: 'reservando' },
      reserved: { mailbox: 'nombre reservado', alias: 'reservado' },
      revealing: { mailbox: 'activando el nombre', alias: 'activando' },
    },
    button: { resume: RESUME, retry: RETRY },
    inProcess: 'en proceso',
    stopped: 'detenido',
    stoppedWith: (reason: string): string => `detenido: ${reason}`,
    stopGeneric: 'no se pudo completar',
    stopReason: {
      needsName: 'falta el nombre',
      attemptsExhausted: 'tras varios intentos sin éxito',
      nameTaken: 'nombre ocupado',
      nameRejected: 'nombre no válido',
      aliasSuffixTaken: 'terminación del alias ocupada',
      relayerRefused: 'rechazado por el servicio de envío',
      callRejected: 'rechazado por Midnight',
      staleState: 'datos de Midnight atrasados',
      clock: 'la hora del dispositivo no coincide',
      contractMismatch: 'hace falta una versión nueva de la app',
      sidecarTooOld: 'hace falta volver a instalar la app',
    },
    stopCall: {
      notABono: 'Midnight no reconoce el bono',
      noSlotsLeft: 'no quedan huecos en el plan',
      wrongReveal: 'los datos no coinciden con la reserva',
    },
    mailboxNamed: (name: string): string => `buzón ${name}`,
    actions: {
      resume: (what: string): string => `${RESUME} el ${what}`,
      retry: (what: string): string => `${RETRY} el ${what}`,
      abandon: (what: string): string => `Cancelar la creación del ${what}`,
    },
    // How the button that finishes a slot is named: one, or both if it is unknown whether it is paused. Buttons go
    // without quotes.
    finishOne: (button: string): string => `el botón ${button}`,
    finishEither: `el botón ${RETRY} (o con el botón ${RESUME}, si se detuvo tras varios intentos)`,
    stillPendingSlot: (button: string): string =>
      'No se puede cancelar: su último intento ya ha llegado a Midnight o está a punto de hacerlo. Termínalo con ' +
      `${button}.`,
    stillPendingBono:
      'Aún no se puede cancelar: la petición todavía puede completarse. Se podrá cancelar cuando venza su plazo.',
  },

  // payment.ts
  payment: {
    unreadable: 'No se pudo leer el precio o el saldo.',
    insufficient: (token: string, price: string): string =>
      `Saldo insuficiente: tienes ${tokenAmount(token)} y el plan cuesta ${price}.`,
    noNight: 'La cartera no tiene NIGHT para generar el DUST de la comisión: envía NIGHT a su dirección.',
    dustActivating: 'Activando la generación de DUST',
    dustFailed: 'No se ha podido activar la generación de DUST. Se volverá a intentar cuando vuelvas a abrir la aplicación.',
    offerNone: 'Elige un plan',
    offerFree: 'Pasar al plan de pago',
    bonoTitle: (paid: boolean): string => `Bono ${paid ? 'de pago' : 'gratis'}`,
    confirmed: 'Confirmado.',
    pending: 'pendiente',
    usableFrom: (at: string): string => `Se podrá usar a partir del ${at}`,
    cancel: 'Cancelar',
    cancelPaid: {
      label: (title: string): string => `Cancelar el pago pendiente del ${title.toLowerCase()}`,
      title: '¿Cancelar este pago pendiente?',
      note: 'Si ya se pagó y aún puede completarse, no se podrá cancelar.',
      yes: 'Sí, cancelar el pago',
    },
    cancelFree: {
      label: (title: string): string => `Cancelar la petición pendiente del ${title.toLowerCase()}`,
      title: '¿Cancelar esta petición pendiente?',
      note: 'Si la petición ya se aceptó y aún puede completarse, no se podrá cancelar.',
      yes: 'Sí, cancelar la petición',
    },
  },

  // addresses.ts
  addresses: {
    noPlan: 'Aún no tienes plan: elige uno para poder crear direcciones.',
    // `paid`: the paid plan, named by its brand (with its capitals), or the free one.
    quotaFull: (paid: boolean, mailboxes: number, aliases: number): string =>
      `No te quedan huecos libres en tu plan ${paid ? PAID_PLAN : 'gratis'} (${mailboxes} ` +
      `${plural(mailboxes, { one: 'buzón', other: 'buzones' }, 'es')} y ${aliases} alias).`,
    // "Direcciones" in the feminine: "1 detenida".
    stoppedTag: (n: number): string => plural(n, { one: '1 detenida', other: `${n} detenidas` }, 'es'),
    inProcessTag: (n: number): string => `${n} en proceso`,
    abandon: {
      title: '¿Abandonar esta dirección?',
      body: [
        'Esta operación no se puede deshacer.',
        'El hueco de tu plan no se libera y nadie podrá volver a registrar esta dirección, tampoco tú.',
      ],
      yes: 'Abandonar dirección',
      no: 'Cancelar',
    },
    abandonButton: 'Abandonar',
    seeMail: (address: string): string => `Ver correo de ${address}`,
    abandonAddress: (address: string): string => `Abandonar ${address}`,
    abandoned: 'Dirección abandonada.',
    abandonNote: 'Al abandonar una dirección, el hueco de tu plan no se libera.',
    // "buzón" and "alias" are masculine.
    abandonedCount: (n: number): string => plural(n, { one: '(1 abandonado)', other: `(${n} abandonados)` }, 'es'),
  },

  // notices.ts
  notices: {
    title: 'No se ha podido terminar lo pendiente.',
    busy: 'Reintentando.',
    retryNow: RETRY_NOW,
    serverDown: `El servidor de NightMail no responde. Cuando vuelva a responder, pulsa el botón ${RETRY_NOW} para terminar.`,
    serverBack: `El servidor de NightMail ya responde. Pulsa el botón ${RETRY_NOW}.`,
    failedLabel: (kind: 'mailbox' | 'alias', count: number): string =>
      kind === 'mailbox'
        ? plural(count, { one: 'Un buzón', other: `${count} buzones` }, 'es')
        : plural(count, { one: 'Un alias', other: `${count} alias` }, 'es'),
    unfinished: 'sin terminar.',
    unfinishedWith: (text: string): string => `sin terminar: ${text}`,
    bonosLabel: 'Bonos pendientes',
    unchecked: 'sin comprobar.',
    uncheckedWith: (text: string): string => `sin comprobar: ${text}`,
  },

  // health.ts
  health: {
    noNetwork:
      'No hay conexión con la red de Midnight (el indexer no responde). Hasta que vuelva no se puede sincronizar la ' +
      'cartera, pagar ni crear direcciones. Si usas una red local, arráncala. Si no, espera unos minutos y vuelve a ' +
      'intentarlo.',
    noProofServer:
      `El proof server de este equipo no responde. Hace falta para crear direcciones, pagar y pedir ${TOKEN_NAME_PLURAL}.` +
      'Arráncalo y vuelve a intentarlo.',
    waiting:
      'Midnight no responde ahora mismo (el indexer no contesta). La operación sigue esperando. Si usas una red local, ' +
      'arráncala.',
  },
};
