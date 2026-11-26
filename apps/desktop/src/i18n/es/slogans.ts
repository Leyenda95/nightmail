// Spanish texts of the `slogans` namespace: front screen slogans.
// This is the shape `en/slogans.ts` must repeat.
//
// The rotating slogans under the front screen's logo (`slogans.ts`), in their order. They are a fixed list
// (`as const`): English must carry the same ones, one by one and in the same order.
export default {
  // Fixed headline above the rotating slogans: it never rotates and is always read.
  headline: 'El correo más privado del mundo.',
  list: [
    'Ni nosotros podemos atar cabos.',
    'Sin cuenta. Sin número de teléfono. Sin IP.',
    'Tu correo privado. Regístrate con libertad.',
    'Regístrate donde quieras. Sin compartir nada.',
  ],
} as const;
