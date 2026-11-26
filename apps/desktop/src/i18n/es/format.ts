// Spanish texts of the `format` namespace.
// This is the shape `en/format.ts` must repeat.
import { plural } from '../locale.ts';

/** "1, 3 y 5": commas and a "y" before the last. */
function lista(numeros: readonly number[]): string {
  if (numeros.length <= 1) return numeros.join('');
  return `${numeros.slice(0, -1).join(', ')} y ${numeros[numeros.length - 1]}`;
}

export default {
  // format.ts: short dates of the list and the day of addresses (by hand: they do not depend on the system's language
  // data nor on a dot after the month).
  months: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
  weekdays: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
  yesterday: 'ayer',
  /** "14 nov". */
  dayMonth: (day: number, month: string): string => `${day} ${month}`,
  /** "14 nov 2025". */
  dayMonthYear: (day: number, month: string, year: number): string => `${day} ${month} ${year}`,
  // format.ts: figures. Thousands always with a dot (4-digit numbers too: "5.000"), decimals with a comma.
  thousandsSeparator: '.',
  decimalSeparator: ',',
  /** What is not an unsigned integer is shown as is (an amount is never invented). */
  rawUnits: (units: string): string => `${units} (unidades)`,
  /** "115 %", with a space. */
  percent: (n: number): string => `${n} %`,
  // format.ts: sender.
  unknownSender: '(remitente desconocido)',
  noAddress: (text: string): string => `(sin dirección) "${text}"`,
  // format.ts: slots, seed phrase and restore.
  slotInCreation: (kind: 'mailbox' | 'alias'): string => `${kind === 'mailbox' ? 'buzón' : 'alias'} en creación`,
  seedWordCount: (n: number, total: number): string => `${n} de ${total} palabras`,
  recovery: {
    bonos: 'Bonos',
    addresses: 'Direcciones',
    burned: 'Huecos que ya no sirven',
    conflicts: 'Datos que no coincidían',
  },
  // format.ts: attachments.
  inlineShown: 'Imagen del mensaje (ya se ve arriba)',
  unnamedAttachment: 'Sin nombre',
  fileType: 'Archivo',
  textType: 'Texto',
  // seedCheck.ts
  invalidWords: (positions: readonly number[]): string =>
    positions.length === 1
      ? `La palabra ${positions[0]} no es válida. Corrígela y vuelve a intentarlo.`
      : `Las palabras ${lista(positions)} no son válidas. Corrígelas y vuelve a intentarlo.`,
  // images.ts
  remoteImages: (n: number): string =>
    `${plural(n, { one: '1 imagen remota bloqueada', other: `${n} imágenes remotas bloqueadas` }, 'es')}. El remitente no sabe que has abierto este mensaje.`,
  // links.ts
  invalidLink: '(dirección no válida)',
};
