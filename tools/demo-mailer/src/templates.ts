// Realistic demo email templates, written in Spanish on purpose.
// The texts are data with placeholders that `template()` fills in:
// {pedido} (order number), {kb}, {cliente} (name or "cliente") and {comaNombre} (", Ana" or nothing).
import type { Attachment, InlineImage, Mailbox, MessageSpec } from "./message.ts";
import { bombPng, solidPng } from "./png.ts";

export interface TemplateContext {
  to: Mailbox;
  /** Name for the greeting; without it greetings are neutral (an alias has no first name). */
  name?: string;
  /** Position of this message in the whole batch (0, 1, 2…). */
  index: number;
  now: Date;
  /** Approximate size of the long email, in KiB. */
  sizeKb: number;
}

export type Template = (ctx: TemplateContext) => MessageSpec;

interface Definition {
  from: Mailbox;
  subject: string;
  /** Body; a function receives the context (used by the long email). */
  body: string | ((ctx: TemplateContext) => string);
  /** HTML version with the same placeholders (values are escaped); a function is generated on use. */
  html?: string | (() => string);
  /** Inline images for the HTML; generated on first use of the template and reused. */
  inline?: () => InlineImage[];
  attachment?: Attachment;
  encoding?: "base64" | "8bit";
}

const TIENDA: Mailbox = { name: "Tienda Luna", address: "pedidos@tiendaluna.example" };
const FACTURAS: Mailbox = { name: "Suministros Aurora", address: "facturacion@aurora-suministros.example" };
const BOLETIN: Mailbox = { name: "El Faro Digital", address: "boletin@elfarodigital.example" };
const MARTA: Mailbox = { name: "Marta Núñez", address: "marta.nunez@correo.example" };

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function fill(text: string, ctx: TemplateContext, escape = (s: string) => s): string {
  const values: Record<string, string> = {
    cliente: ctx.name ?? "cliente",
    comaNombre: ctx.name ? `, ${ctx.name}` : "",
    pedido: String(48200 + ctx.index),
    kb: String(ctx.sizeKb),
  };
  return text.replace(/\{(\w+)\}/g, (_m, key: string) => escape(values[key] ?? ""));
}

function template(def: Definition): Template {
  return (ctx) => ({
    from: def.from,
    to: [ctx.to],
    date: ctx.now,
    subject: fill(def.subject, ctx),
    text: typeof def.body === "string" ? fill(def.body, ctx) : def.body(ctx),
    ...(def.html !== undefined && { html: fill(typeof def.html === "string" ? def.html : def.html(), ctx, escapeHtml) }),
    ...(def.inline && { inline: def.inline() }),
    ...(def.attachment && { attachment: def.attachment }),
    ...(def.encoding && { encoding: def.encoding }),
  });
}

/** Computes once, on first use (the test images are slow to generate). */
function once<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

const png = (cid: string, filename: string, content: Uint8Array): InlineImage => ({
  cid,
  filename,
  contentType: "image/png",
  content,
});

const LOGO = once(() => [png("logo@tiendaluna.example", "logo.png", solidPng(120, 40, [0xf4, 0x80, 0x3c]))]);

/** Side of the bomb image; exceeds the viewer's per-side cap (MAX_SIDE = 8192 in apps/desktop/src/images.ts). */
export const BOMB_SIDE = 16384;
/** Side that does fit the per-side cap (8192) but not the per-image pixel cap (MAX_PIXELS = 16 Mpx): 64 Mpx. */
export const PIXELS_BOMB_SIDE = 8000;
const BOMB_PNG = once(() => bombPng(BOMB_SIDE));
const BOMB = once(() => [
  png("bomba@pruebas.example", "escondida.png", BOMB_PNG()),
  png("bomba-8000@pruebas.example", "ancha.png", bombPng(PIXELS_BOMB_SIDE)),
  png("verde@pruebas.example", "verde.png", solidPng(20, 20, [0x2e, 0xa0, 0x60])),
]);
/** The same bomb embedded in the HTML as a `data:` URI (the other path images can take). */
const BOMB_DATA_URI = once(() => `data:image/png;base64,${Buffer.from(BOMB_PNG()).toString("base64")}`);

/** Medium images: more than the 20 inline images per message the app delivers (core, MAX_INLINE_IMAGES). */
export const MEDIUM_IMAGES = { count: 24, width: 1280, height: 960 } as const;
const IMAGES = once(() =>
  Array.from({ length: MEDIUM_IMAGES.count }, (_, i) => {
    const content = solidPng(MEDIUM_IMAGES.width, MEDIUM_IMAGES.height, [(i * 97) % 256, (i * 57 + 80) % 256, (i * 151 + 160) % 256]);
    return png(`imagen-${i + 1}@pruebas.example`, `imagen-${i + 1}.png`, content);
  }),
);

const IMAGES_HTML = Array.from(
  { length: MEDIUM_IMAGES.count },
  (_, i) =>
    `<p>Imagen ${i + 1} de ${MEDIUM_IMAGES.count}<br>` +
    `<img src="cid:imagen-${i + 1}@pruebas.example" width="320" height="240" alt="imagen ${i + 1}"></p>`,
).join("\n");

const PARAGRAPH =
  "Este párrafo de relleno sirve para probar los tramos de tamaño del servidor: " +
  "lleva tildes, eñes y signos como ¿qué tal? o ¡hasta pronto! para comprobar que " +
  "la codificación se mantiene íntegra de principio a fin.";

/** About `sizeKb` KiB of text (CRLF); some lines start with "." to exercise dot-stuffing. */
export function longText(sizeKb: number): string {
  const target = sizeKb * 1024;
  const lines: string[] = [];
  let size = 0;
  for (let i = 1; size < target; i++) {
    const line = `${i % 25 === 0 ? "." : ""}Línea ${i}. ${PARAGRAPH}`;
    lines.push(line);
    size += Buffer.byteLength(line) + 2;
  }
  return lines.join("\n");
}

const RESUMEN: Attachment = {
  filename: "resumen-pedido.csv",
  contentType: "text/csv; charset=utf-8",
  content: Buffer.from(
    "referencia,descripción,cantidad,importe\n" + "A-100,Papel reciclado A4,3,41.70\n" + "T-220,Tóner negro,1,58.90\n",
  ),
};

const DEFINITIONS: Record<string, Definition> = {
  welcome: {
    from: TIENDA,
    subject: "¡Bienvenido a Tienda Luna{comaNombre}!",
    body: `Hola{comaNombre},

Gracias por crear tu cuenta en Tienda Luna. Ya puedes guardar tus favoritos,
seguir tus pedidos y recibir ofertas antes que nadie.

Como regalo de bienvenida, usa el código LUNA10 y tendrás un 10 % de descuento
en tu primera compra.

Un saludo,
El equipo de Tienda Luna`,
  },
  invoice: {
    from: FACTURAS,
    subject: "Factura F-2026-{pedido} de Suministros Aurora",
    body: `Estimado/a {cliente}:

Le informamos de que su factura F-2026-{pedido} ya está disponible.

  Concepto                     Cantidad   Importe
  Papel reciclado A4 (caja)           3    41,70 €
  Tóner negro                         1    58,90 €
  IVA (21 %)                               21,13 €
  Total                                   121,73 €

Vencimiento: 30 días desde la fecha de emisión.

Atentamente,
Departamento de facturación`,
  },
  newsletter: {
    from: BOLETIN,
    subject: "El Faro Digital · Lo más leído de la semana",
    body: `Buenos días:

Estos son los cinco artículos más leídos de la semana:

1. Cómo cifrar tu correo sin ser experto
2. Guía rápida de contraseñas que sí se recuerdan
3. Por qué tu proveedor sabe más de ti de lo que crees
4. Entrevista: la privacidad como diseño, no como parche
5. Cinco hábitos digitales para empezar el año

Recibes este boletín porque te suscribiste en elfarodigital.example.
Para darte de baja, responde con la palabra BAJA.`,
  },
  personal: {
    from: MARTA,
    subject: "¡Cena el sábado! 🎉 ¿Te apuntas?",
    body: `¡Hola{comaNombre}! 😊

El sábado hacemos una cena en casa para celebrar el cumpleaños de Andrés 🎂.
Habrá paella 🥘, tortilla de patatas y, si nos da tiempo, churros con chocolate.

Empezamos sobre las 21:00. ¿Puedes traer algo de beber? 🍷
Dime algo antes del jueves para saber cuántos somos.

¡Un abrazo fuerte!
Marta ✨`,
  },
  attachment: {
    from: TIENDA,
    subject: "Tu pedido #{pedido} está en camino 📦",
    body: `Hola{comaNombre},

Tu pedido #{pedido} ha salido de nuestro almacén. Adjuntamos el resumen
en formato CSV por si quieres revisarlo.

Gracias por comprar en Tienda Luna.`,
    attachment: RESUMEN,
  },
  long: {
    from: MARTA,
    subject: "Informe largo de prueba ({kb} KiB)",
    body: (ctx) => longText(ctx.sizeKb),
    // 8bit: the size on the wire is the requested one (base64 would add 33 %) and "." lines arrive as is.
    encoding: "8bit",
  },
  html: {
    from: TIENDA,
    subject: "Confirmación de tu pedido #{pedido} 🌙",
    body: `Hola{comaNombre},

¡Gracias por tu pedido! Hemos recibido el pedido #{pedido} y ya lo estamos preparando.

  Lámpara de mesa «Creciente»       1 × 34,90 €
  Velas aromáticas (pack de 3)      2 ×  9,95 €
  Envío                                  Gratis
  Total (IVA incluido)                  54,80 €

Ver el estado del pedido: https://tiendaluna.example/pedidos/{pedido}
¿Dudas? Escríbenos a ayuda@tiendaluna.example.

Tienda Luna · Calle de la Luna 7, Madrid
Darse de baja: https://tiendaluna.example/baja`,
    html: `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Tienda Luna</title>
<style>
body { margin: 0; background: #f4f1ec; font-family: Helvetica, Arial, sans-serif; color: #2b2b2b; }
.caja { max-width: 560px; margin: 24px auto; background: #ffffff; border-radius: 8px; padding: 24px; }
h1 { font-size: 20px; color: #c4501b; }
table { width: 100%; border-collapse: collapse; }
td { padding: 6px 0; border-bottom: 1px solid #eeeeee; }
.total td { font-weight: bold; border-bottom: none; }
.boton { display: inline-block; background: #f4803c; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; }
.pie { font-size: 12px; color: #888888; text-align: center; }
</style></head>
<body>
<div class="caja">
<img src="cid:logo@tiendaluna.example" width="120" height="40" alt="Tienda Luna">
<h1>¡Gracias por tu pedido{comaNombre}!</h1>
<p>Hemos recibido tu pedido <strong>#{pedido}</strong> y ya lo estamos preparando.</p>
<table>
<tr><td>Lámpara de mesa «Creciente»</td><td align="right">1 × 34,90 €</td></tr>
<tr><td>Velas aromáticas (pack de 3)</td><td align="right">2 × 9,95 €</td></tr>
<tr><td>Envío</td><td align="right">Gratis</td></tr>
<tr class="total"><td>Total (IVA incluido)</td><td align="right">54,80 €</td></tr>
</table>
<p><a class="boton" href="https://tiendaluna.example/pedidos/{pedido}">Ver el estado del pedido</a></p>
<p>¿Dudas? Escríbenos a <a href="mailto:ayuda@tiendaluna.example">ayuda@tiendaluna.example</a>.</p>
</div>
<p class="pie">Tienda Luna · Calle de la Luna 7, Madrid<br>
<a href="https://tiendaluna.example/baja">Darse de baja</a></p>
</body></html>`,
    inline: LOGO,
  },
  bomb: {
    from: MARTA,
    subject: "Prueba del lector: imágenes enormes escondidas",
    body: `Este correo es una prueba. Lleva tres imágenes que en el correo ocupan muy poco
pero que, abiertas, no caben en los topes del lector:

1. Una de ${BOMB_SIDE} × ${BOMB_SIDE} puntos (más de 1 GB de memoria), adjunta en línea.
2. La misma, escrita dentro del propio HTML.
3. Una de ${PIXELS_BOMB_SIDE} × ${PIXELS_BOMB_SIDE}: cada lado cabe, pero el total de puntos no.

Qué debe pasar: en los tres recuadros pone «imagen no disponible» y la app sigue
respondiendo con normalidad. El cuadrado verde pequeño sí debe verse.`,
    html: () => `<p>Este correo es una prueba. Lleva tres imágenes que en el correo ocupan muy poco pero que, abiertas,
no caben en los topes del lector.</p>
<p>Qué debe pasar: en los tres recuadros de abajo pone «imagen no disponible» y la app sigue respondiendo con normalidad.</p>
<p>1. ${BOMB_SIDE} × ${BOMB_SIDE} puntos (más de 1 GB de memoria), adjunta en línea:
<img src="cid:bomba@pruebas.example" width="64" height="64" alt="imagen escondida"></p>
<p>2. La misma, escrita dentro del HTML:
<img src="${BOMB_DATA_URI()}" width="64" height="64" alt="imagen escondida en el HTML"></p>
<p>3. ${PIXELS_BOMB_SIDE} × ${PIXELS_BOMB_SIDE} puntos (cada lado cabe, el total no):
<img src="cid:bomba-8000@pruebas.example" width="64" height="64" alt="imagen demasiado grande"></p>
<p>Esta imagen pequeña sí debe verse (un cuadrado verde):
<img src="cid:verde@pruebas.example" width="20" height="20" alt="cuadrado verde"></p>`,
    inline: BOMB,
  },
  images: {
    from: MARTA,
    subject: `Prueba del lector: ${MEDIUM_IMAGES.count} imágenes medianas`,
    body: `Este correo es una prueba. Lleva ${MEDIUM_IMAGES.count} imágenes de ${MEDIUM_IMAGES.width} × ${MEDIUM_IMAGES.height} puntos.

Qué debe pasar: se abre sin atascarse y se desplaza con soltura. La app enseña
como mucho 20 imágenes por mensaje: las 4 últimas salen como «imagen no disponible».`,
    html: `<p>Este correo es una prueba. Lleva ${MEDIUM_IMAGES.count} imágenes de ${MEDIUM_IMAGES.width} × ${MEDIUM_IMAGES.height} puntos.</p>
<p>Qué debe pasar: se abre sin atascarse y se desplaza con soltura. La app enseña como mucho 20 imágenes por mensaje:
las 4 últimas salen como «imagen no disponible».</p>
${IMAGES_HTML}`,
    inline: IMAGES,
  },
};

export const TEMPLATES: Readonly<Record<string, Template>> = Object.fromEntries(
  Object.entries(DEFINITIONS).map(([name, def]) => [name, template(def)]),
);

/** Templates rotated by default (the test ones, long, bomb and images, are only sent on request). */
export const DEFAULT_ROTATION: readonly string[] = ["welcome", "invoice", "newsletter", "personal", "attachment", "html"];
