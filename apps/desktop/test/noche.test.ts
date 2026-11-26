// The front screen's inline illustration uses the same strokes as the brand SVG.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const marca = readFileSync(new URL('../../../design/brand/ilustracion-bandeja-vacia.svg', import.meta.url), 'utf8');
const noche = readFileSync(new URL('../src/components/Noche.tsx', import.meta.url), 'utf8');

const trazos = (s: string) => [...s.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);

test('Noche.tsx has the same paths (d=) as the brand SVG', () => {
  assert.equal(trazos(marca).length, 2);
  assert.deepEqual(trazos(noche), trazos(marca));
});

test('Noche.tsx has the same lights as the brand SVG', () => {
  const luces = [...marca.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="url\(#halo\)"\/><circle cx="[\d.]+" cy="[\d.]+" r="([\d.]+)" fill="#ffcf5c" fill-opacity="([\d.]+)"/g)];
  assert.equal(luces.length, 5);
  for (const [, cx, cy, rh, r, o] of luces) {
    assert.ok(noche.includes(`[${cx}, ${cy}, ${rh}, ${r}, ${Number(o)}]`), `missing light ${cx},${cy}`);
  }
  assert.ok(noche.includes('cx="144.25" cy="91.75" r="15.75"'));
});
