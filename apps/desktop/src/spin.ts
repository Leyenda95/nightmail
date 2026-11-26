// Refresh icons that turn when pressed. A sync can finish in a few milliseconds: the icon still makes at least
// SPIN_MIN_MS of turn and always stops at the end of a whole turn (upright, never half turned).

/** Duration of one turn of `nm-fila__gira` (`styles/app.css`, `nm-gira 1s`). */
export const SPIN_TURN_MS = 1000;
/** Shortest time the icon turns after a press, even if the work ended at once. */
export const SPIN_MIN_MS = 600;

/** How long the icon keeps turning after the work ended, `elapsed` ms after the turn started: up to the end of the
 *  turn in course, and at least up to `min`. */
export function spinStopDelay(elapsed: number, min = SPIN_MIN_MS, turn = SPIN_TURN_MS): number {
  const at = Math.max(0, elapsed, min);
  return Math.max(1, Math.ceil(at / turn)) * turn - Math.max(0, elapsed);
}
