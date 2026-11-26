"""NightMail identity: "Luciérnagas". The brand's single source of truth.

The palette, typography, logo colours and the preview's own texts are here.
The engine (build.py) reads this file.
"""

NAME = "Luciérnagas"

# --------------------------------------------------------------------------- #
# Palette
# --------------------------------------------------------------------------- #

PRIMITIVES = {
    "noche-950": "#050d18",
    "noche-900": "#0a1828",  # Noche: deep blue of a moonless summer night
    "noche-850": "#0e1f33",
    "noche-800": "#13273d",
    "noche-700": "#1e3650",
    "noche-600": "#2a4563",
    "noche-500": "#51647a",
    "noche-400": "#687c93",
    "noche-300": "#8496ab",
    "noche-200": "#a9b7c8",
    "alba-0": "#ffffff",
    "alba-50": "#fbf8f1",
    "alba-100": "#f5f0e4",  # Alba: warm paper, the clarity of dawn
    "alba-200": "#e9e2d0",
    "alba-300": "#d5ccb8",
    "alba-400": "#b8b2a3",
    "lumbre": "#ffcf5c",  # Lumbre: the firefly's light (accent over Noche)
    "miel": "#b07400",  # Miel: the same light, by day (the logo's lantern and markers over Alba)
    "anil": "#1c4a7a",  # Añil: the night used as ink (accent and interaction over Alba)
}
PRIMITIVE_NOTES = {
    "noche-900": "Noche · fondo oscuro, texto en claro",
    "noche-400": "Luz apagada (segundo punto del wordmark)",
    "alba-100": "Alba · fondo débil en claro, texto en oscuro",
    "lumbre": "Lumbre · la luz, sobre Noche",
    "miel": "Miel · la luz, sobre Alba",
    "anil": "Añil · botones y enlaces sobre Alba",
}

LIGHT = {
    "primary": "#1c4a7a",
    "signal-danger": "#c2283f",
    "signal-warning": "#a85a00",
    "signal-success": "#0f7a63",
    "signal-info": "#17759c",
    "interaction-norm": "#1c4a7a",
    "interaction-weak": "#e9e2d0",
    "text-norm": "#0a1828",
    "text-weak": "#45546a",
    "text-hint": "#5a687b",
    "text-disabled": "#b8b2a3",
    "text-invert": "#ffffff",
    "field-norm": "#857f70",
    "field-hover": "#5f5a4e",
    "field-disabled": "#d5ccb8",
    "focus-outline": "#1c4a7a",
    "focus-ring": "rgb(28 74 122 / 0.25)",
    "border-norm": "#d5ccb8",
    "border-weak": "#e9e2d0",
    "background-norm": "#ffffff",
    "background-weak": "#f5f0e4",
    "background-strong": "#e9e2d0",
    "background-invert": "#0a1828",
    "interaction-default": "transparent",
    "interaction-default-hover": "rgb(104 124 147 / 0.16)",
    "interaction-default-active": "rgb(104 124 147 / 0.3)",
    "shadow-norm-opacity": "0.1",
    "shadow-raised-opacity": "0.1",
    "shadow-lifted-opacity": "0.16",
    "backdrop-norm": "rgb(10 24 40 / 0.48)",
}
LIGHT_OPTIONAL = {
    "scrollbar-thumb-color": "#d5ccb8",
    "background-elevated": "#ffffff",
    "background-lowered": "#fbf8f1",
    "email-item-read-background-color": "#fbf8f1",
    "email-item-read-text-color": "#36455a",
    # The selected mail "lights up": a tint of Lumbre, not the whole Añil.
    "email-item-selected-background-color": "#fbeac0",
    "email-item-selected-text-color": "@text-norm",
    "email-item-selected-icon-background-color": "@background-norm",
    "mini-calendar-today-color": "@primary",
    "logo-text-brand-color": "#0a1828",
    "logo-text-product-color": "#0a1828",
    "mark-background-color": "#ffe08a",
    "mark-text-color": "#0a1828",
    "favorite-icon-color": "#a85a00",
    "highlight-background-norm": "#fdf1cf",
    "promotion-text-color": "#0a1828",
    "promotion-text-weak": "#1c4a7a",
    "promotion-interaction-hover": "rgb(28 74 122 / 0.08)",
    "promotion-background-start": "rgb(255 207 92 / 0.35)",
    "promotion-background-end": "rgb(255 207 92 / 0.08)",
    "promotion-secondary-color": "#0f7a63",
    "shadow-primary-color": "28 74 122",
}

DARK = {
    "primary": "#ffcf5c",
    "signal-danger": "#ff7a8a",
    "signal-warning": "#ff9d5c",
    "signal-success": "#45d0a8",
    "signal-info": "#5cc0ea",
    "interaction-norm": "#ffcf5c",
    "interaction-weak": "#2a4563",
    "text-norm": "#f5f0e4",
    "text-weak": "#a9b7c8",
    "text-hint": "#8496ab",
    "text-disabled": "#51647a",
    "text-invert": "#0a1828",
    "field-norm": "#687c93",
    "field-hover": "#8496ab",
    "field-disabled": "#1e3650",
    "focus-outline": "#ffcf5c",
    "focus-ring": "rgb(255 207 92 / 0.3)",
    "border-norm": "#2a4563",
    "border-weak": "#182d44",
    "background-norm": "#0a1828",
    "background-weak": "#13273d",
    "background-strong": "#1e3650",
    "background-invert": "#f5f0e4",
    "interaction-default": "transparent",
    "interaction-default-hover": "rgb(132 150 171 / 0.16)",
    "interaction-default-active": "rgb(132 150 171 / 0.3)",
    "shadow-norm-opacity": "0.5",
    "shadow-raised-opacity": "0.44",
    "shadow-lifted-opacity": "0.75",
    "backdrop-norm": "rgb(3 8 15 / 0.6)",
}
DARK_OPTIONAL = {
    "scrollbar-thumb-color": "#2a4563",
    "background-elevated": "#0e1f33",
    "background-lowered": "#050d18",
    "email-item-read-background-color": "#050d18",
    "email-item-read-text-color": "#a9b7c8",
    "email-item-selected-background-color": "@primary-minor-1",
    "email-item-selected-text-color": "@text-norm",
    "email-item-selected-icon-background-color": "@background-norm",
    "mini-calendar-today-color": "#f5f0e4",
    "logo-text-brand-color": "#f5f0e4",
    "logo-text-product-color": "#f5f0e4",
    "mark-background-color": "#ffcf5c",
    "mark-text-color": "#0a1828",
    "favorite-icon-color": "#ffcf5c",
    "highlight-background-norm": "#3a3220",
    "promotion-text-color": "#f5f0e4",
    "promotion-text-weak": "#ffe09a",
    "promotion-interaction-hover": "rgb(255 207 92 / 0.16)",
    "promotion-background-start": "rgb(255 207 92 / 0.22)",
    "promotion-background-end": "rgb(255 207 92 / 0.05)",
    "promotion-secondary-color": "#45d0a8",
    "shadow-primary-color": "255 207 92",
}

# The shades of each base colour are fixed in theme-base.json.

# Own tokens (the base stylesheet does not have them). They are emitted in tokens.css as --nm-<name>.
EXTRA = {
    "light": {
        "marca": "#b07400",  # the light: the logo's lantern, unread mail, each address's dot
        "marca-apagada": "#687c93",  # a light that is not shining right now
        "luz-rgb": "176 116 0",
        "halo": "0 0 0 3px rgb(176 116 0 / 0.14)",
        # Danger button: truly red (the dark signal red is a light pink, meant for text)
        "peligro-solido": "#c2283f",
        "peligro-solido-hover": "#af2439",
        "peligro-solido-activo": "#9b2032",
        "peligro-solido-texto": "#ffffff",
    },
    "dark": {
        "marca": "#ffcf5c",
        "marca-apagada": "#687c93",
        "luz-rgb": "255 207 92",
        "halo": "0 0 0 3px rgb(255 207 92 / 0.14), 0 0 10px 1px rgb(255 207 92 / 0.45)",
        "peligro-solido": "#d4354c",
        "peligro-solido-hover": "#c2283f",
        "peligro-solido-activo": "#af2439",
        "peligro-solido-texto": "#ffffff",
    },
}
EXTRA_PAIRS = [
    ("nm-marca", "background-norm", 3.0, "Luz (correo no leído, dirección) sobre fondo"),
    ("nm-marca", "background-weak", 3.0, "Luz sobre fondo débil (barra lateral)"),
    ("nm-marca", "optional-background-lowered", 3.0, "Luz sobre la lista de correo"),
    ("nm-marca-apagada", "background-weak", 3.0, "Luz apagada sobre fondo débil"),
    ("nm-peligro-solido-texto", "nm-peligro-solido", 4.5, "Texto del botón de peligro"),
    ("nm-peligro-solido-texto", "nm-peligro-solido-hover", 4.5, "Texto del botón de peligro (hover)"),
    ("nm-peligro-solido-texto", "nm-peligro-solido-activo", 4.5, "Texto del botón de peligro (activo)"),
    ("nm-peligro-solido", "optional-background-elevated", 3.0, "Botón de peligro sobre el diálogo"),
]
LOGO_PAIRS = [
    ("#0a1828", "#ffffff", 3.0, "Alas Noche sobre Alba 0"),
    ("#b07400", "#ffffff", 3.0, "Farol Miel sobre Alba 0"),
    ("#b07400", "#f5f0e4", 3.0, "Farol Miel sobre Alba 100"),
    ("#687c93", "#ffffff", 3.0, "Punto apagado sobre Alba 0"),
    ("#687c93", "#f5f0e4", 3.0, "Punto apagado sobre Alba 100"),
    ("#f5f0e4", "#0a1828", 3.0, "Alas Alba sobre Noche 900"),
    ("#ffcf5c", "#0a1828", 3.0, "Farol Lumbre sobre Noche 900"),
    ("#ffcf5c", "#13273d", 3.0, "Farol Lumbre sobre Noche 800"),
    ("#687c93", "#0a1828", 3.0, "Punto apagado sobre Noche 900"),
    ("#687c93", "#13273d", 3.0, "Punto apagado sobre Noche 800"),
]

# --------------------------------------------------------------------------- #
# Typography, radii and motion
# --------------------------------------------------------------------------- #

STATIC = {
    "font-sans": "'Figtree', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', sans-serif",
    "font-mono": "'Atkinson Hyperlegible Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace",
    "font-mono-features": "normal",
    "font-weight-normal": "400",
    "font-weight-semibold": "600",
    "font-weight-bold": "700",
    "radius": "10",  # unitless number, as the base stylesheet's --optional-border-radius expects
    "radius-sm": "5px",
    "radius-md": "10px",
    "radius-lg": "14px",
    "radius-xl": "18px",
    "destello-duracion": "700ms",
    "destello-curva": "cubic-bezier(0.2, 0.8, 0.2, 1)",
}
# (CSS family, file in fonts/, weight range, style)
FONTS = [
    ("Figtree", "Figtree-wght.woff2", "300 900", "normal"),
    ("Atkinson Hyperlegible Mono", "AtkinsonHyperlegibleMono-wght.woff2", "200 800", "normal"),
]

# --------------------------------------------------------------------------- #
# Logo
# --------------------------------------------------------------------------- #

WORDMARK = {"text": "NightMail", "weight": 700, "tracking": -0.01, "split_dots": True}
# 48 x 48 symbol; wordmark with capital height 22, vertically centred; gap 14.
LOCKUP = {"symbol_w": 48, "symbol_h": 48, "cap": 22, "gap": 14, "align": "center"}
# The dots of the two "i": the first one lit; the second, off. Each shines on its own.
LOGO_THEMES = {
    "": {"ink": "#0a1828", "dots": ["#b07400", "#687c93"]},
    "-dark": {"ink": "#f5f0e4", "dots": ["#ffcf5c", "#687c93"]},
}
# So the embedded logo follows the theme (light colour to variable).
THEME_MAP = {"#0a1828": "var(--text-norm)", "#b07400": "var(--nm-marca)", "#687c93": "var(--nm-marca-apagada)"}

SIZE_BY = "height"
SYMBOL_SIZES = (16, 24, 32, 48, 64, 128)
MONO_SIZES = (16, 32, 64)
LOCKUP_SIZES = (20, 32, 56)

# --------------------------------------------------------------------------- #
# Preview
# --------------------------------------------------------------------------- #

STAGES = {  # name: (background, text, border)
    "p0": ("#ffffff", "#0a1828", "#e9e2d0"),
    "p1": ("#f5f0e4", "#0a1828", "#e9e2d0"),
    "t9": ("#0a1828", "#f5f0e4", "#182d44"),
    "t8": ("#13273d", "#f5f0e4", "#182d44"),
    "ac1": ("#ffcf5c", "#0a1828", "#ffcf5c"),
    "ac2": ("#1c4a7a", "#ffffff", "#1c4a7a"),
}

# Own marker: a round light. {S} is the scope selector (empty in preview.html).
MARKER_CSS = """{S} .dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--nm-marca);box-shadow:var(--nm-halo);flex:none;margin:0 .1rem}
{S} .list .unread::before{content:"";position:absolute;left:.4rem;top:1.02rem;width:.42rem;height:.42rem;border-radius:50%;background:var(--nm-marca);box-shadow:var(--nm-halo)}
@keyframes nm-latido{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes nm-destello{0%{transform:scale(1);box-shadow:0 0 0 0 rgb(var(--nm-luz-rgb)/0)}18%{transform:scale(1.7);box-shadow:0 0 0 6px rgb(var(--nm-luz-rgb)/.28),0 0 18px 4px rgb(var(--nm-luz-rgb)/.6)}100%{transform:scale(1);box-shadow:var(--nm-halo)}}
/* Each address beats with its own period (coprime numbers): they never synchronise. */
{S} .addr li:nth-child(1) .dot{animation:nm-latido 5.3s ease-in-out infinite}
{S} .addr li:nth-child(2) .dot{animation:nm-latido 7.1s ease-in-out -2s infinite}
{S} .addr li:nth-child(3) .dot{animation:nm-latido 11.3s ease-in-out -6s infinite}
@media (prefers-reduced-motion:reduce){{S} .dot,{S} .unread::before,.flash{animation:none!important}}"""

_BUILD = """
<svg viewBox="-8 -8 64 64" role="img" aria-label="Construcción del símbolo sobre una rejilla de 48 unidades">
  <rect x="0" y="0" width="48" height="48" fill="none" stroke="var(--field-norm)" stroke-width=".3" stroke-dasharray="1.5 1.5"/>
  <path d="M3 45 45 3" stroke="var(--signal-danger)" stroke-width=".3" stroke-dasharray="1 1"/>
  <path fill="var(--text-norm)" d="M23.31 22.02 19.41 10.37A5.6 5.6 0 1 1 29.55 11.43zM25.98 24.69 36.57 18.45A5.6 5.6 0 1 1 37.63 28.59z"/>
  <circle cx="13.5" cy="34.5" r="10.5" fill="var(--nm-marca)"/>
  <g fill="none" stroke="var(--signal-danger)" stroke-width=".3">
    <circle cx="23" cy="25" r=".9" fill="var(--signal-danger)"/>
    <path d="M23 25 24.72 8.59M23 25 39.41 23.28M13.5 34.5H3"/>
    <circle cx="24.72" cy="8.59" r="5.6" stroke-dasharray="1 1"/><circle cx="39.41" cy="23.28" r="5.6" stroke-dasharray="1 1"/>
  </g>
  <g font-family="var(--nm-font-mono)" font-size="2.4" fill="var(--text-weak)">
    <text x="8.2" y="33.6" text-anchor="middle">r 10,5</text><text x="30.5" y="16">16,5</text><text x="31.5" y="5">r 5,6</text><text x="24.5" y="32">pivote</text><text x="24" y="52" text-anchor="middle">48 × 48 · margen 3</text>
  </g>
</svg>
<ul>
  <li><strong>Tres piezas que no se tocan:</strong> un farol (círculo de radio 10,5) y dos alas iguales en forma de gota.</li>
  <li>Todo se ordena sobre la <strong>diagonal</strong>: el farol abajo a la izquierda, las alas abiertas 39° a cada lado, hacia arriba y a la derecha. La luciérnaga está en vuelo.</li>
  <li>El farol ocupa más que las dos alas juntas: <strong>se dibuja la luz, no el insecto</strong>. No hay cabeza, patas ni antenas.</li>
  <li><strong>Zona de respeto:</strong> el radio del farol (10,5 unidades) por cada lado.</li>
  <li>De noche, alas en Alba y farol en Lumbre. De día, alas en Noche y farol en Miel.</li>
</ul>
"""

_TYPE = """
<div>
  <p class="big">Cada dirección,<br>una luz.<br>Ninguna dice de quién.</p>
  <dl>
    <dt>Figtree 400 · texto</dt><dd>El correo se cifra al recibirlo, con la clave de cada dirección.</dd>
    <dt>Figtree 600 · énfasis, botones</dt><dd style="font-weight:600">Encender una dirección nueva</dd>
    <dt>Figtree 700 · títulos</dt><dd style="font-weight:700">Guarda tu frase semilla</dd>
  </dl>
</div>
<div>
  <dl>
    <dt>Atkinson Hyperlegible Mono · direcciones</dt><dd class="mono">nube.verde.k7m2q9xa4b3c@nightmail.local</dd>
    <dt>Mono · caracteres que no se confunden</dt><dd class="mono" style="font-size:1.5rem">0O o 1lI| 5S 8B rn m</dd>
    <dt>Mono · frase semilla</dt>
    <dd><ol class="seed"><li>faro</li><li>nube</li><li>tinta</li><li>brasa</li><li>lento</li><li>verde</li><li>papel</li><li>musgo</li></ol></dd>
  </dl>
</div>
"""

_SECTIONS = """
<section class="blk">
  <h2>Luces: microinteracciones</h2>
  <p class="lead">La luz es el único elemento que se mueve, y siempre poco. Con «reducir movimiento» activado en el sistema, las tres quedan fijas.</p>
  <div class="cards">
    <div class="card">
      <h4>Llega un correo</h4>
      <p>El punto de ese correo destella una sola vez (700 ms) y se queda encendido. Sin sonido, sin rebote, sin contador que salte.</p>
      <div class="demo" data-theme="dark"><i class="dot flash" id="flash"></i><span>Cooperativa La Imprenta</span></div>
      <button class="demo-btn" id="flash-btn">Reproducir el destello</button>
    </div>
    <div class="card">
      <h4>Cada dirección, a su ritmo</h4>
      <p>En la barra lateral cada dirección late con un periodo distinto (5,3 s, 7,1 s y 11,3 s). Nunca coinciden: no hay patrón que seguir.</p>
      <div class="demo" data-theme="dark"><ul class="addr" style="gap:.9rem;display:flex"><li><i class="dot"></i></li><li><i class="dot"></i></li><li><i class="dot"></i></li></ul></div>
    </div>
    <div class="card">
      <h4>El nombre también parpadea</h4>
      <p>Los puntos de las dos «i» nunca brillan a la vez: uno encendido, otro apagado. En la cabecera pueden turnarse cada varios segundos.</p>
      <div class="demo" data-theme="dark"><span class="im h" style="height:30px">%%SVG:logo-wordmark-dark.svg%%</span></div>
    </div>
  </div>
  <h3 class="sub">Ilustración · bandeja vacía</h3>
  <div class="grid2">
    <div class="stage t9" style="padding:0;overflow:hidden;align-items:flex-end;justify-content:center"><span class="im w" style="width:100%">%%SVG:ilustracion-bandeja-vacia.svg%%</span></div>
    <div class="stage p1" style="align-items:center"><ul style="margin:0;padding-left:1.1rem;max-width:34ch">
      <li>La ilustración siempre es de noche, también en el tema claro: va dentro de un panel Noche.</li>
      <li>Luces de tamaños distintos, sin alinear y sin líneas que las unan: no es una constelación.</li>
      <li>Solo una lleva alas: la tuya. Las demás son luces de otros.</li>
      <li>Sin tarros, redes ni manos: una luciérnaga nunca aparece atrapada.</li>
    </ul></div>
  </div>
</section>
"""

PREVIEW = {
    "title": "identidad · Luciérnagas",
    "kicker": "Identidad visual · Luciérnagas",
    "h1": "Una luz pequeña que solo ve quien sabe mirar.",
    "hero_lead": "Cada dirección de NightMail es una luz que brilla por su cuenta. Nadie, ni el proveedor, sabe cuáles son tuyas. "
    "Vista previa de la identidad: logo, paleta, tipografía, luces y una maqueta de la bandeja en claro y oscuro. "
    "Todo está incrustado en este archivo; no se carga nada de la red.",
    "logo_title": "Logo: la luciérnaga",
    "logo_lead": "Un farol y dos alas. La luz ocupa casi todo: es lo que se ve en la oscuridad. Las tres piezas no se tocan, "
    "así el símbolo funciona igual en una sola tinta.",
    "build": _BUILD,
    "palette_lead": "Noche y Alba para casi todo; una sola luz. La Lumbre solo vive sobre Noche. De día las luciérnagas no se ven: "
    "la interacción pasa al Añil y la luz queda como Miel en los marcadores.",
    "type_lead": "Figtree para la interfaz y el nombre; Atkinson Hyperlegible Mono para direcciones, frases semilla y huellas. "
    "Ambas SIL OFL 1.1, incrustadas aquí; si no cargan, se usa la fuente del sistema.",
    "type": _TYPE,
    "sections": _SECTIONS,
    "css": ".card .demo{background:var(--background-norm);border:1px solid var(--border-weak)}"
    ".flash.go{animation:nm-destello var(--nm-destello-duracion) var(--nm-destello-curva) 1}",
    "script": "var f=document.getElementById('flash');document.getElementById('flash-btn').addEventListener('click',function(){"
    "f.classList.remove('go');void f.offsetWidth;f.classList.add('go');});",
    "footer": "NightMail · identidad «Luciérnagas» · archivos en <code>design/brand/</code>. "
    "Fuentes: Figtree, © The Figtree Project Authors, y Atkinson Hyperlegible Mono, © The Atkinson Hyperlegible Mono Project Authors; ambas SIL OFL 1.1.",
}
