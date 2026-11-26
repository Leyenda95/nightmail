// The light, the brand's own marker: "yours / new / active". Never decoration nor error.
// It is only an ornament for whoever sees it: what it means is ALWAYS in the adjacent text (no state depends
// on colour or motion alone), which is why it is hidden from screen readers.
import { luzClass, type LuzMode } from '../pieces.ts';

/** `rhythm` only counts with `mode="late"`: the address's position in the list, so each one beats at its own rhythm. */
export function Luz({ mode = 'encendida', rhythm = 0 }: { mode?: LuzMode; rhythm?: number }) {
  // `keep-motion` only on "trabaja": the base stylesheet turns off all animation under reduced motion except on `.keep-motion`.
  const keep = mode === 'trabaja' ? ' keep-motion' : '';
  return <span className={luzClass(mode, rhythm) + keep} aria-hidden="true" />;
}
