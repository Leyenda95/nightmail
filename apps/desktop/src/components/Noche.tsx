// The front screen's illustration inline (the same strokes as design/brand/ilustracion-bandeja-vacia.svg; a test compares them)
// so each light has its class and can move with CSS. The motion lives in app.css and is
// off for now (only with `<html data-movimiento>`): still, it looks exactly like the drawing.
import { useId } from 'react';

const PUNTOS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  // cx, cy, halo radius, light radius, light opacity
  [52, 46, 18, 3.5, 0.7],
  [262, 34, 12, 2.2, 0.5],
  [286, 112, 24, 4.8, 0.85],
  [108, 126, 10, 1.8, 0.45],
  [206, 150, 15, 2.8, 0.6],
];

export function Noche() {
  const halo = `halo-${useId().replace(/:/g, '')}`;
  return (
    <svg className="nm-noche" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" aria-hidden="true">
      <defs>
        <radialGradient id={halo} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#ffcf5c" stopOpacity=".45" />
          <stop offset=".5" stopColor="#ffcf5c" stopOpacity=".12" />
          <stop offset="1" stopColor="#ffcf5c" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path
        fill="none"
        stroke="#1e3650"
        strokeWidth="3"
        strokeLinecap="round"
        d="M14 180v-22M31 180v-36M47 180v-15M70 180v-28M96 180v-12M118 180v-31M139 180v-18M171 180v-25M190 180v-13M214 180v-34M236 180v-20M262 180v-27M283 180v-14M305 180v-30"
      />
      {PUNTOS.map(([cx, cy, rh, r, o], i) => (
        <g key={i} className={`nm-noche__luz nm-noche__luz--${i + 1}`}>
          <circle cx={cx} cy={cy} r={rh} fill={`url(#${halo})`} />
          <circle cx={cx} cy={cy} r={r} fill="#ffcf5c" fillOpacity={o} />
        </g>
      ))}
      <g className="nm-noche__tuya">
        <circle cx="144.25" cy="91.75" r="52" fill={`url(#${halo})`} />
        <path
          fill="#f5f0e4"
          d="M158.97 73.03 153.12 55.56A8.4 8.4 0 1 1 168.33 57.15zM162.97 77.04 178.86 67.68A8.4 8.4 0 1 1 180.45 82.89z"
        />
        <circle cx="144.25" cy="91.75" r="15.75" fill="#ffcf5c" />
      </g>
    </svg>
  );
}
