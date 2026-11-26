// Spanish texts of the `mail` namespace: list and selection.
// This is the shape `en/mail.ts` must repeat.
import { PAID_PLAN } from '../brand.ts';
import { plural } from '../locale.ts';

const mensajes = (n: number): string => plural(n, { one: '1 mensaje', other: `${n} mensajes` }, 'es');

export default {
  // sidebar.ts
  slotKind: (kind: 'mailbox' | 'alias'): string => (kind === 'mailbox' ? 'buzón' : 'alias'),
  unnamedAddress: (kind: 'mailbox' | 'alias'): string => `${kind === 'mailbox' ? 'buzón' : 'alias'} sin nombre`,
  addressesNote: (count: number): string => {
    if (count <= 0) return 'Aún no tienes ninguna.';
    return plural(
      count,
      { one: 'Solo tú sabes que esta dirección es tuya.', other: 'Solo tú sabes que estas direcciones son tuyas.' },
      'es',
    );
  },
  planFree: 'Plan gratis',
  planPaid: PAID_PLAN,
  status: {
    noAnswer: 'sin respuesta',
    offline: 'sin conexión',
    checkingDots: 'comprobando…',
    proofServerMissing: 'falta el proof server',
    connected: 'conectado',
    starting: 'arrancando…',
    down: 'caído',
    unavailableInBuild: 'no disponible en esta build',
    waiting: '…',
    notChecked: 'sin comprobar',
    notResponding: 'no responde',
    mailNotResponding: 'el correo no responde',
    partlyAvailable: 'parcialmente disponible',
    checking: 'comprobando',
    responding: 'responde',
    unavailable: 'no disponible',
    withIssues: 'con incidencias',
    operational: 'operativo',
  },
  serverMail: 'Correo',
  serverIssuer: 'Emisión de bonos',
  serverRelayer: 'Creación de direcciones',
  mailDown: 'No hay conexión con el servidor de correo. Los mensajes nuevos llegarán cuando se restablezca.',
  // inbox.ts
  inbox: {
    title: 'Bandeja de entrada',
    allAddresses: 'todas tus direcciones',
    unread: (n: number): string => `${n} sin leer`,
    archiveTitle: 'Archivo',
    archivedCount: (n: number): string =>
      n === 0
        ? 'Ningún mensaje archivado'
        : plural(n, { one: '1 mensaje archivado', other: `${n} mensajes archivados` }, 'es'),
    archiveEmpty: 'Lo que archives desde el lector se guarda aquí, fuera de la bandeja.',
    cappedNote: (n: number): string => `Se ven los ${n} mensajes más recientes.`,
  },
  // selection.ts
  selection: {
    selected: (n: number): string => plural(n, { one: '1 seleccionado', other: `${n} seleccionados` }, 'es'),
    doneDeleted: (n: number): string => `${mensajes(n)} ${plural(n, { one: 'borrado', other: 'borrados' }, 'es')}.`,
    doneArchived: (n: number): string => `${mensajes(n)} ${plural(n, { one: 'archivado', other: 'archivados' }, 'es')}.`,
    doneUnarchived: (n: number): string =>
      `${mensajes(n)} ${plural(n, { one: 'sacado', other: 'sacados' }, 'es')} del archivo.`,
    deleteTitle: (n: number): string => (n === 1 ? '¿Borrar este mensaje?' : `¿Borrar ${mensajes(n)}?`),
    deleteButton: (n: number): string => (n === 1 ? 'Borrar mensaje' : `Borrar ${mensajes(n)}`),
    deleteBody: (n: number): string =>
      n === 1
        ? 'Dejará de verse en la bandeja y en el archivo. Esta decisión es irreversible.'
        : 'Dejarán de verse en la bandeja y en el archivo. Esta decisión es irreversible.',
  },
  // pieces.ts
  copied: 'Copiada',
  copiedSecret: (seconds: number): string => `Copiada. Se borrará del portapapeles en ${seconds} segundos.`,
  copyFailed: 'No se ha podido copiar. Selecciónala y pulsa Ctrl+C.',
  // sanitize.ts
  imageUnavailable: 'imagen no disponible',
};
