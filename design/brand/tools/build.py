#!/usr/bin/env python3
"""NightMail brand engine (the «Luciérnagas» identity).

Everything that defines the identity lives in `identity.py`, next to this file.

From `theme_base.py` it takes the fixed theme data (`theme-base.json`: the list of base
stylesheet variables and the shades of each base colour), the WCAG 2.x contrast calculation
and the list of pairs that are checked. It only needs the Python 3 standard library,
except `wordmark`, which requires fontTools and the original TTF of the font.

Usage (from any directory):
    python3 tools/build.py contrast          table + AA check (exits with 1 on failure)
    python3 tools/build.py contrast --md     the table in Markdown, ready to paste
    python3 tools/build.py build             rewrites tokens.css and theme-base.css
    python3 tools/build.py wordmark <ttf>    rewrites logo-wordmark*.svg and logo-lockup-horizontal*.svg
    python3 tools/build.py preview           rewrites preview.html (local, not tracked)
    python3 tools/build.py validate          validates the SVGs and that the HTML files load nothing remote
    python3 tools/build.py all               build + preview + contrast + validate
"""
from __future__ import annotations

import base64
import html
import importlib.util
import re
import sys
import xml.dom.minidom
from html.parser import HTMLParser
from pathlib import Path

sys.dont_write_bytecode = True  # keeps __pycache__ out of tools/

HERE = Path(__file__).resolve().parent
DIR = HERE.parent
SVG_NS = "http://www.w3.org/2000/svg"


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_tag = re.sub(r"\W", "_", DIR.name)
base = _load(HERE / "theme_base.py", "nm_base_" + _tag)  # theme data, contrast and pairs
ident = _load(HERE / "identity.py", "nm_ident_" + _tag)

# --------------------------------------------------------------------------- #
# Theme
# --------------------------------------------------------------------------- #


def expand(theme: dict, light: bool) -> dict:
    """The theme with each base colour expanded into its fixed shades (theme-base.json)."""
    mode = "light" if light else "dark"
    out: dict[str, str] = {}
    for name, value in theme.items():
        if name in base.BUTTON_BASES:
            shades = base.SHADES[mode][name]
            assert shades[2] == value, f"{name}: base colour does not match theme-base.json ({mode})"
            for suffix, col in zip(base.SHADE_NAMES, shades):
                out[name + suffix] = col
            out[name + "-contrast"] = base.CONTRAST[mode][name]
        else:
            out[name] = value
    return out


def full_theme(light: bool) -> dict:
    b, opt = (ident.LIGHT, ident.LIGHT_OPTIONAL) if light else (ident.DARK, ident.DARK_OPTIONAL)
    theme = expand(b, light)
    theme.update({"optional-" + k: (theme[v[1:]] if v.startswith("@") else v) for k, v in opt.items()})
    return theme


def extras(light: bool) -> dict:
    """The identity's own tokens that the base stylesheet does not have (e.g. --nm-marca)."""
    return dict(ident.EXTRA["light" if light else "dark"])


def lookup(light: bool) -> dict:
    t = full_theme(light)
    t.update({"nm-" + k: v for k, v in extras(light).items()})
    return t


# The same variables as the reference list in theme-base.json: checked on import.
assert set(full_theme(True)) == {base.own_name(v) for v in base.VARIABLES} == set(full_theme(False)), (
    "identity.py must define exactly the variables of theme-base.json"
)

# --------------------------------------------------------------------------- #
# Contrast
# --------------------------------------------------------------------------- #

PAIRS = list(base.PAIRS) + list(ident.EXTRA_PAIRS)


def contrast_rows(light: bool):
    t = lookup(light)
    for fg, bg, minimum, desc in PAIRS:
        yield desc, fg, t[fg], bg, t[bg], base.contrast(t[fg], t[bg]), minimum


def cmd_contrast(md: bool) -> int:
    failures = 0
    if md:
        print("| Par | Claro | Ratio | Oscuro | Ratio | Mín. |")
        print("|---|---|---:|---|---:|---:|")
        for l, d in zip(contrast_rows(True), contrast_rows(False)):
            failures += (l[5] < l[6]) + (d[5] < d[6])
            num = lambda r: f"{r:.2f}".replace(".", ",")  # noqa: E731
            print(f"| {l[0]} | `{l[2]}` / `{l[4]}` | {num(l[5])} | `{d[2]}` / `{d[4]}` | {num(d[5])} | {l[6]:g} |".replace("4.5 |", "4,5 |"))
        print("\n| Logo | Primer plano / fondo | Ratio | Mín. |\n|---|---|---:|---:|")
    else:
        for label, light in (("Light theme", True), ("Dark theme", False)):
            print(f"\n== {label} ==")
            for desc, fg, fgv, bg, bgv, ratio, minimum in contrast_rows(light):
                ok = ratio >= minimum
                failures += not ok
                print(f"{'ok  ' if ok else 'FAIL'} {ratio:5.2f} (min {minimum:g})  {desc}: --{fg} {fgv} / --{bg} {bgv}")
        print("\n== Logo ==")
    for fg, bg, minimum, desc in ident.LOGO_PAIRS:
        ratio = base.contrast(fg, bg)
        ok = ratio >= minimum
        failures += not ok
        if md:
            print(f"| {desc} | `{fg}` / `{bg}` | {ratio:.2f} | {minimum:g} |".replace(".", ","))
        else:
            print(f"{'ok  ' if ok else 'FAIL'} {ratio:5.2f} (min {minimum:g})  {desc}: {fg} / {bg}")
    print(f"\n{'OK: all pairs pass' if not failures else f'FAILURES: {failures}'}", file=sys.stderr if md else sys.stdout)
    return 1 if failures else 0


# --------------------------------------------------------------------------- #
# CSS
# --------------------------------------------------------------------------- #

HEADER = """/*
 * NightMail: {title}
 * Identity "{name}". GENERATED by tools/build.py from
 * tools/identity.py. Do not edit by hand: change the palette there and run
 * `python3 tools/build.py build`.
 */
"""


def _block(selector: str, decls: dict, indent: str = "", tail: str = "") -> str:
    lines = [f"{indent}{selector} {{"]
    lines += [f"{indent}  --{k}: {v};" for k, v in decls.items()]
    if tail:
        lines.append(f"{indent}  {tail}")
    lines.append(f"{indent}}}")
    return "\n".join(lines)


def nm_tokens(light: bool) -> dict:
    out = {"nm-" + k.replace("optional-", ""): v for k, v in full_theme(light).items()}
    out.update({"nm-" + k: v for k, v in extras(light).items()})
    out["nm-color-scheme"] = "light" if light else "dark"
    return out


def static_tokens() -> dict:
    out = {"nm-" + k: v for k, v in ident.PRIMITIVES.items()}
    out.update({"nm-" + k: v for k, v in ident.STATIC.items()})
    return out


def build_tokens() -> str:
    light, dark = nm_tokens(True), nm_tokens(False)
    return "\n".join(
        [
            HEADER.format(title="brand tokens (light and dark theme)", name=ident.NAME),
            "/* Primitives, typography and radii: they do not change with the theme. */",
            _block(":root", static_tokens()),
            "",
            "/* Light theme (default). */",
            _block(':root,\n[data-theme="light"]', light, tail="color-scheme: light;"),
            "",
            "/* Dark theme: by system preference, unless light is forced. */",
            "@media (prefers-color-scheme: dark) {",
            _block(':root:not([data-theme="light"])', dark, "  ", tail="color-scheme: dark;"),
            "}",
            "",
            "/* Forced dark theme. */",
            _block('[data-theme="dark"]', dark, tail="color-scheme: dark;"),
            "",
        ]
    )


def build_theme_base() -> str:
    # The same order and names as the reference list in theme-base.json.
    decls = {k: f"var(--nm-{base.own_name(k).replace('optional-', '')})" for k in base.VARIABLES}
    decls["optional-font-family"] = "var(--nm-font-sans)"
    decls["optional-border-radius"] = "var(--nm-radius)"
    return "\n".join(
        [
            HEADER.format(title="theme for the base stylesheet", name=ident.NAME),
            "/*\n"
            " * The theme of the base stylesheet (the variables its rules read).\n"
            " * It defines the same variables, in the same order, as the reference in theme-base.json.\n"
            " * It requires THIS folder's tokens.css to be loaded first. Each base variable\n"
            " * points to its equivalent --nm-* token; the light/dark switch is done by tokens.css.\n"
            " * `[data-theme]` is in the selector so a nested theme recalculates.\n"
            " */",
            _block(":root,\n.ui-standard,\n[data-theme]", decls),
            "",
        ]
    )


def cmd_build() -> int:
    (DIR / "tokens.css").write_text(build_tokens(), encoding="utf-8", newline="\n")
    (DIR / "theme-base.css").write_text(build_theme_base(), encoding="utf-8", newline="\n")
    print("Escritos tokens.css y theme-base.css en", DIR)
    return 0


def scoped_vars(scope: str, light: dict, dark: dict, static: dict) -> str:
    """Variables with the base stylesheet's names, wrapped in a selector (for the preview.html mock-up)."""
    return "\n".join(
        [
            _block(scope, static),
            _block(f'{scope} [data-theme="light"]', light),
            _block(f'{scope} [data-theme="dark"]', dark),
        ]
    )


def own_scoped_vars(scope: str) -> str:
    def both(light: bool) -> dict:
        d = dict(full_theme(light))
        d.update({"nm-" + k: v for k, v in extras(light).items()})
        return d

    static = {"nm-" + k: v for k, v in ident.STATIC.items()}
    return scoped_vars(scope, both(True), both(False), static)


# --------------------------------------------------------------------------- #
# Wordmark and lockup (text converted to paths)
# --------------------------------------------------------------------------- #


def fmt(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def symbol_inner(name: str) -> str:
    """Content of a symbol SVG, without wrapper, title or comments."""
    s = (DIR / name).read_text(encoding="utf-8")
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"<title[^>]*>.*?</title>", "", s, flags=re.S)
    s = re.sub(r"^\s*<svg[^>]*>|</svg>\s*$", "", s.strip())
    return re.sub(r">\s+<", "><", s).strip()


def cmd_wordmark(ttf: str) -> int:
    try:
        from fontTools.ttLib import TTFont
    except ModuleNotFoundError:
        import site

        sys.path.append(site.getusersitepackages())
        from fontTools.ttLib import TTFont
    from fontTools.pens.recordingPen import DecomposingRecordingPen
    from fontTools.varLib import instancer

    wm, lk = ident.WORDMARK, ident.LOCKUP
    font = instancer.instantiateVariableFont(TTFont(ttf), {"wght": wm["weight"]})
    upm, cap = font["head"].unitsPerEm, font["OS/2"].sCapHeight
    cmap, glyphs = font.getBestCmap(), font.getGlyphSet()

    def contours_for(name):
        pen = DecomposingRecordingPen(glyphs)
        glyphs[name].draw(pen)
        out, cur = [], []
        for op, args in pen.value:
            if op == "moveTo":
                cur = [(op, args)]
            elif op in ("closePath", "endPath"):
                cur.append((op, args))
                out.append(cur)
                cur = []
            else:
                cur.append((op, args))
        return out

    def cbounds(contour):
        pts = [p for _op, args in contour for p in args]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        return min(xs), min(ys), max(xs), max(ys)

    x = 0.0
    letters, dots = [], []
    for ch in wm["text"]:
        name = cmap[ord(ch)]
        contours = contours_for(name)
        if ch == "i" and wm.get("split_dots"):
            contours.sort(key=lambda c: cbounds(c)[1])
            *contours, dot = contours
            dots.append((x, [dot]))
        letters.append((x, contours))
        x += glyphs[name].width + wm["tracking"] * upm

    def bounds(groups):
        b = [1e9, 1e9, -1e9, -1e9]
        for x0, contours in groups:
            for c in contours:
                x1, y1, x2, y2 = cbounds(c)
                b = [min(b[0], x0 + x1), min(b[1], y1), max(b[2], x0 + x2), max(b[3], y2)]
        return b

    def to_path(contours, tx):
        out = []
        for contour in contours:
            for op, args in contour:
                pts = [tx(p) for p in args]
                if op == "moveTo":
                    out.append("M" + " ".join(f"{fmt(px)} {fmt(py)}" for px, py in pts))
                elif op == "lineTo":
                    out.append("L" + " ".join(f"{fmt(px)} {fmt(py)}" for px, py in pts))
                elif op == "qCurveTo":
                    ctrl, end = pts[:-1], pts[-1]
                    for i, c in enumerate(ctrl):
                        on = ((c[0] + ctrl[i + 1][0]) / 2, (c[1] + ctrl[i + 1][1]) / 2) if i + 1 < len(ctrl) else end
                        out.append(f"Q{fmt(c[0])} {fmt(c[1])} {fmt(on[0])} {fmt(on[1])}")
                elif op == "curveTo":
                    out.append("C" + " ".join(f"{fmt(px)} {fmt(py)}" for px, py in pts))
                elif op == "closePath":
                    out.append("Z")
        return "".join(out)

    def run(groups, scale, ox, baseline):
        return [
            to_path(contours, lambda p, x0=x0: (ox + (x0 + p[0]) * scale, baseline - p[1] * scale))
            for x0, contours in groups
        ]

    def paths(scale, ox, baseline, colors):
        out = f'<path fill="{colors["ink"]}" d="{"".join(run(letters, scale, ox, baseline))}"/>'
        for d, fill in zip(run(dots, scale, ox, baseline), colors.get("dots", [])):
            out += f'<path fill="{fill}" d="{d}"/>'
        return out

    head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" role="img" aria-labelledby="t"><title id="t">NightMail</title>'
    x1, y1, x2, y2 = bounds(letters + dots)
    scale = lk["cap"] / cap
    w, h = (x2 - x1) * scale, (y2 - y1) * scale

    # Wordmark alone: viewBox fitted to the ink.
    for suffix, colors in ident.LOGO_THEMES.items():
        svg_text = head.format(w=fmt(w), h=fmt(h)) + paths(scale, -x1 * scale, y2 * scale, colors) + "</svg>\n"
        (DIR / f"logo-wordmark{suffix}.svg").write_text(svg_text, encoding="utf-8", newline="\n")

    # Horizontal lockup: symbol + gap + wordmark.
    sw, sh = lk["symbol_w"], lk["symbol_h"]
    baseline = sh if lk["align"] == "baseline" else (sh + lk["cap"]) / 2
    top, bottom = min(0.0, baseline - y2 * scale), max(float(sh), baseline - y1 * scale)
    ty = -top
    total_w, total_h = sw + lk["gap"] + w, bottom - top
    for suffix, colors in ident.LOGO_THEMES.items():
        sym = symbol_inner(f"logo-symbol{suffix}.svg")
        if ty:
            sym = f'<g transform="translate(0 {fmt(ty)})">{sym}</g>'
        svg_text = (
            head.format(w=fmt(total_w), h=fmt(total_h))
            + sym
            + paths(scale, sw + lk["gap"] - x1 * scale, baseline + ty, colors)
            + "</svg>\n"
        )
        (DIR / f"logo-lockup-horizontal{suffix}.svg").write_text(svg_text, encoding="utf-8", newline="\n")

    print(f"wordmark {fmt(w)} × {fmt(h)} (altura de mayúsculas {lk['cap']}); lockup {fmt(total_w)} × {fmt(total_h)}")
    print(f"ascendente sobre mayúsculas: {fmt((y2 - cap) * scale)}; descendente: {fmt(-y1 * scale)}; desplazamiento vertical: {fmt(ty)}")
    return 0


# --------------------------------------------------------------------------- #
# Preview
# --------------------------------------------------------------------------- #

_n = 0


def svg(name: str, directory: Path = DIR) -> str:
    """Embeddable SVG: without title (avoids repeated ids), without comments and with unique ids."""
    global _n
    s = (directory / name).read_text(encoding="utf-8")
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"<title[^>]*>.*?</title>", "", s, flags=re.S)
    s = re.sub(r'\s*role="img"\s*aria-labelledby="t"', ' aria-hidden="true"', s)
    _n += 1
    for ident_id in set(re.findall(r'\bid="([^"]+)"', s)):
        s = s.replace(f'id="{ident_id}"', f'id="{ident_id}-{_tag}-{_n}"').replace(f"url(#{ident_id})", f"url(#{ident_id}-{_tag}-{_n})")
    return re.sub(r">\s+<", "><", s).strip()


def themed(name: str) -> str:
    """Logo that follows the theme: each fixed colour is replaced by the variable given by identity.THEME_MAP."""
    s = svg(name)
    for hex_color, var in ident.THEME_MAP.items():
        s = s.replace(f'fill="{hex_color}"', f'fill="{var}"').replace(f'stroke="{hex_color}"', f'stroke="{var}"')
    return s


def font_face_css() -> str:
    out = []
    for family, filename, weights, style in ident.FONTS:
        data = base64.b64encode((DIR / "fonts" / filename).read_bytes()).decode("ascii")
        out.append(
            f"@font-face{{font-family:'{family}';font-weight:{weights};font-style:{style};font-display:swap;"
            f"src:url(data:font/woff2;base64,{data}) format('woff2')}}"
        )
    return "\n".join(out)


def img(name: str, px: int, label: str | None = None, by: str = "height") -> str:
    other = "width" if by == "height" else "height"
    unit = " px" if by == "height" else " px de ancho"
    cap = f"<figcaption>{label or str(px) + unit}</figcaption>"
    return f'<figure><span class="im {by[0]}" style="{by}:{px}px;{other}:auto">{svg(name)}</span>{cap}</figure>'


def swatch(name: str, value: str, note: str = "") -> str:
    return (
        f'<div class="sw"><span class="chip" style="background:{value}"></span>'
        f"<strong>{html.escape(name)}</strong><span>{html.escape(value)}</span>"
        f'{f"<small>{html.escape(note)}</small>" if note else ""}</div>'
    )


SEMANTIC = [
    "primary", "primary-minor-1", "primary-major-1", "primary-contrast", "interaction-weak",
    "text-norm", "text-weak", "text-hint", "text-disabled",
    "background-norm", "background-weak", "background-strong", "border-norm", "field-norm",
    "signal-danger", "signal-warning", "signal-success", "signal-info",
]  # fmt: skip


def semantic(light: bool) -> str:
    t = full_theme(light)
    out = "".join(swatch("--" + k, t[k]) for k in SEMANTIC)
    return out + "".join(swatch("--nm-" + k, v) for k, v in extras(light).items() if v.startswith("#"))


def contrast_table(light: bool) -> str:
    rows = []
    for desc, fg, fgv, bg, bgv, r, minimum in contrast_rows(light):
        rows.append(
            f'<tr><td><span class="pair" style="color:{fgv};background:{bgv}">Aa</span></td>'
            f"<td>{html.escape(desc)}</td><td><code>--{fg.replace('optional-', '')}</code> {fgv}</td>"
            f"<td><code>--{bg.replace('optional-', '')}</code> {bgv}</td>"
            f'<td class="num">{r:.2f}:1</td><td class="num">{minimum:g}:1</td>'
            f'<td>{"AA" if r >= minimum else "FALLA"}</td></tr>'
        )
    return "".join(rows)


ICONS = {  # the same generic pictograms the mock-up uses
    "inbox": '<path d="M2 9.5 3.6 3h8.8L14 9.5V13H2zM2 9.5h3.5l1 1.5h3l1-1.5H14"/>',
    "star": '<path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z"/>',
    "archive": '<path d="M2 3h12v3H2zM3 6v7h10V6M6.5 9h3"/>',
    "trash": '<path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.5 8.5h6l.5-8.5"/>',
    "plus": '<path d="M8 3v10M3 8h10"/>',
    "search": '<path d="M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.3 10.3 14 14"/>',
    "check": '<path d="m3 8.5 3.2 3L13 4.5"/>',
    "alert": '<path d="M8 2 1.5 13.5h13zM8 6.5v3.5M8 11.8v.2"/>',
}


def icon(name: str) -> str:
    return (
        '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" '
        f'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{ICONS[name]}</svg>'
    )


def mock(theme: str, lockup: str) -> str:
    """Inbox mock-up (same content and structure as before)."""
    return f"""
<div class="mock" data-theme="{theme}">
  <aside class="side">
    <div class="brand">{lockup}</div>
    <button class="btn primary">{icon('plus')} Nueva dirección</button>
    <nav>
      <a class="cur">{icon('inbox')} Bandeja de entrada <b>3</b></a>
      <a>{icon('star')} Destacados</a>
      <a>{icon('archive')} Archivo</a>
      <a>{icon('trash')} Papelera</a>
    </nav>
    <h4>Tus direcciones</h4>
    <ul class="addr">
      <li><i class="dot"></i><span class="mono">ana.ruiz@nightmail.local</span><em>Buzón</em></li>
      <li><i class="dot"></i><span class="mono">nube.verde.k7m2q9@…</span><em>Alias</em></li>
      <li><i class="dot"></i><span class="mono">faro.lento.p3x8d1@…</span><em>Alias</em></li>
    </ul>
    <p class="hint">Solo esta app sabe que las tres son tuyas.</p>
  </aside>
  <section class="list">
    <label class="search">{icon('search')}<input placeholder="Buscar en este dispositivo" aria-label="Buscar"></label>
    <article class="unread"><h5>Cooperativa La Imprenta <time>10:42</time></h5><p>Tu pedido de papel reciclado</p><small class="mono">ana.ruiz@</small></article>
    <article class="sel"><h5>Redacción · El Faro <time>09:15</time></h5><p>Documentos para el reportaje</p><small class="mono">nube.verde.k7m2q9@</small></article>
    <article class="unread"><h5>Asamblea de Vecinas <time>Ayer</time></h5><p>Orden del día del jueves</p><small class="mono">ana.ruiz@</small></article>
    <article class="read"><h5>Biblioteca Municipal <time>Lun</time></h5><p>Tu préstamo vence el viernes</p><small class="mono">faro.lento.p3x8d1@</small></article>
    <article class="read"><h5>Taller de bicis <time>12 nov</time></h5><p>Factura n.º 2031</p><small class="mono">faro.lento.p3x8d1@</small></article>
  </section>
  <section class="view">
    <h3>Documentos para el reportaje</h3>
    <p class="meta"><strong>Redacción · El Faro</strong> · hoy, 09:15<br>Recibido en <span class="mono">nube.verde.k7m2q9xa4b3c@nightmail.local</span> <span class="tag">Alias</span></p>
    <p class="banner ok">{icon('check')} Cifrado al recibirlo. Solo este dispositivo puede abrirlo.</p>
    <p>Hola: te mando el índice y las dos entrevistas transcritas. Dime si te llega bien por esta dirección y seguimos usando solo esta. <a href="#">Ver el índice</a></p>
    <p class="banner err">{icon('alert')} No se pudo descargar el adjunto. Tu correo sigue a salvo; vuelve a intentarlo.</p>
    <div class="row"><button class="btn weak">{icon('archive')} Archivar</button><button class="btn danger">{icon('trash')} Eliminar</button><button class="btn ghost">Marcar como no leído</button></div>
    <div class="toast">{icon('check')} Dirección creada. Nadie puede vincularla con las demás.</div>
  </section>
</div>"""


# Styles of the mock-up, without the marker, which is specific to this identity.
MOCK_CSS = r"""
[data-theme]{background:var(--background-norm);color:var(--text-norm)}
.mono,code{font-family:var(--nm-font-mono);font-size:.92em;font-feature-settings:var(--nm-font-mono-features,normal)}
.mock{display:grid;grid-template-columns:15.5rem 19rem 1fr;border:1px solid var(--border-norm);border-radius:var(--nm-radius-xl);overflow:hidden;font-family:var(--nm-font-sans);font-size:.875rem;line-height:1.43;margin-bottom:1rem;min-height:31rem;text-align:left}
.mock a{color:var(--primary)}
.mock .ic{width:1rem;height:1rem;flex:none}
.side{background:var(--background-weak);padding:1rem;display:flex;flex-direction:column;gap:.75rem;border-right:1px solid var(--border-weak)}
.brand svg{height:26px;width:auto;display:block}
.btn{font:inherit;font-weight:600;display:inline-flex;align-items:center;justify-content:center;gap:.4rem;padding:.5rem .9rem;border-radius:var(--nm-radius-md);border:1px solid transparent;cursor:pointer}
.btn.primary{background:var(--interaction-norm);color:var(--interaction-norm-contrast)}
.btn.primary:hover{background:var(--interaction-norm-major-1)}
.btn.weak{background:var(--interaction-weak);color:var(--text-norm)}
.btn.weak:hover{background:var(--interaction-weak-major-1)}
.btn.danger{background:var(--signal-danger);color:var(--signal-danger-contrast)}
.btn.ghost{background:var(--interaction-default);color:var(--primary)}
.btn.ghost:hover{background:var(--interaction-default-hover)}
.side nav{display:grid;gap:.125rem}
.side nav a{display:flex;align-items:center;gap:.55rem;padding:.4rem .6rem;border-radius:var(--nm-radius-md);color:var(--text-weak);cursor:pointer}
.side nav a:hover{background:var(--interaction-default-hover)}
.side nav a.cur{background:var(--interaction-default-active);color:var(--text-norm);font-weight:600;box-shadow:inset 3px 0 0 var(--primary)}
.side nav b{margin-left:auto;background:var(--primary);color:var(--primary-contrast);border-radius:99px;padding:0 .45rem;font-size:.75rem}
.side h4{margin:.5rem 0 0;font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-hint)}
.addr{list-style:none;margin:0;padding:0;display:grid;gap:.4rem}
.addr li{display:flex;align-items:center;gap:.45rem;min-width:0}
.addr .mono{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.78rem}
.addr em{margin-left:auto;font-style:normal;font-size:.6875rem;color:var(--text-weak);border:1px solid var(--field-norm);border-radius:99px;padding:0 .4rem}
.hint{margin:auto 0 0;color:var(--text-hint);font-size:.78rem}
.list{background:var(--optional-background-lowered,var(--background-weak));border-right:1px solid var(--border-weak);display:flex;flex-direction:column}
.search{display:flex;align-items:center;gap:.5rem;margin:.75rem;padding:.45rem .65rem;border:1px solid var(--field-norm);border-radius:var(--nm-radius-md);background:var(--background-norm);color:var(--text-hint)}
.search:hover{border-color:var(--field-hover)}
.search:focus-within{border-color:var(--focus-outline);box-shadow:0 0 0 3px var(--focus-ring)}
.search input{border:0;background:none;font:inherit;color:var(--text-norm);width:100%;outline:0}
.search input::placeholder{color:var(--text-hint);opacity:1}
.list article{padding:.6rem .85rem .6rem 1.15rem;border-top:1px solid var(--border-weak);cursor:pointer;position:relative}
.list article h5{margin:0;font-size:.875rem;font-weight:400;display:flex;justify-content:space-between;gap:.5rem}
.list article time{font-size:.75rem;color:var(--text-weak);font-weight:400}
.list article p{margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.list article small{color:var(--text-weak);font-size:.72rem}
.list .unread{background:var(--background-norm)}
.list .unread h5,.list .unread p{font-weight:700}
.list .read{background:var(--optional-email-item-read-background-color);color:var(--optional-email-item-read-text-color)}
.list .sel{background:var(--optional-email-item-selected-background-color);color:var(--optional-email-item-selected-text-color);box-shadow:inset 3px 0 0 var(--primary)}
.view{padding:1.25rem 1.5rem;position:relative;display:flex;flex-direction:column;gap:.75rem;background:var(--background-norm)}
.view h3{margin:0;font-size:1.25rem;font-weight:700}
.view p{margin:0;max-width:60ch}
.meta{color:var(--text-weak)}.meta strong{color:var(--text-norm)}
.tag{font-size:.6875rem;border:1px solid var(--field-norm);border-radius:99px;padding:0 .4rem;color:var(--text-weak)}
.banner{display:flex;gap:.5rem;align-items:center;padding:.5rem .75rem;border-radius:var(--nm-radius-md)}
.banner.ok{background:var(--signal-success-minor-2);color:var(--text-norm)}.banner.ok .ic{color:var(--signal-success)}
.banner.err{background:var(--signal-danger-minor-2);color:var(--text-norm)}.banner.err .ic{color:var(--signal-danger)}
.row{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.25rem}
.toast{margin-top:auto;align-self:flex-end;display:flex;gap:.5rem;align-items:center;background:var(--background-invert);color:var(--text-invert);padding:.6rem .9rem;border-radius:var(--nm-radius-md);box-shadow:0 8px 24px rgb(0 0 0/var(--shadow-lifted-opacity))}
@media (max-width:60rem){.mock{grid-template-columns:1fr}.side,.list{border-right:0;border-bottom:1px solid var(--border-weak)}}
"""

PAGE_CSS = r"""
*{box-sizing:border-box}
html{font-size:100%}
body{margin:0;background:var(--background-norm);color:var(--text-norm);font-family:var(--nm-font-sans);font-size:1rem;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--primary)}
:focus-visible{outline:2px solid var(--focus-outline);outline-offset:2px}
.wrap{max-width:72rem;margin:0 auto;padding:0 1.25rem}
header.top{border-bottom:1px solid var(--border-weak)}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-block:1rem;flex-wrap:wrap}
header.top svg{height:28px;width:auto;display:block}
.switch{display:flex;gap:.25rem;background:var(--background-weak);padding:.25rem;border-radius:var(--nm-radius-lg)}
.switch button,.demo-btn{font:inherit;font-size:.875rem;border:0;background:none;color:var(--text-weak);padding:.3rem .75rem;border-radius:var(--nm-radius-md);cursor:pointer}
.switch button[aria-pressed=true]{background:var(--background-norm);color:var(--text-norm);box-shadow:0 1px 3px rgb(0 0 0/.15)}
.demo-btn{background:var(--interaction-weak);color:var(--text-norm);font-weight:600}
.demo-btn:hover{background:var(--interaction-weak-major-1)}
.hero{padding:4rem 0 3rem}
.hero .kicker{font-family:var(--nm-font-mono);font-size:.8125rem;color:var(--text-weak);margin:0 0 1rem;letter-spacing:.02em}
.hero h1{font-size:clamp(2rem,5vw,3.5rem);line-height:1.08;letter-spacing:-.02em;margin:0 0 1rem;max-width:16ch;font-weight:700}
.hero p.lead{font-size:1.125rem;color:var(--text-weak);max-width:56ch;margin:0}
section.blk{padding:2.5rem 0;border-top:1px solid var(--border-weak)}
h2{font-size:1.75rem;letter-spacing:-.01em;margin:0 0 .25rem}
h2+p.lead{color:var(--text-weak);margin:0 0 1.5rem;max-width:70ch}
h3.sub{margin:2rem 0 .75rem;color:var(--text-weak);font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:.8125rem}
.stage{display:flex;flex-wrap:wrap;gap:1.75rem;align-items:flex-end;padding:1.5rem;border-radius:var(--nm-radius-xl);border:1px solid var(--border-weak);margin-bottom:.75rem}
figure{margin:0;display:flex;flex-direction:column;align-items:flex-start;gap:.5rem}
figcaption{font-size:.75rem;opacity:.75;font-family:var(--nm-font-mono)}
.im{display:block}.im.h svg{height:100%;width:auto;display:block}.im.w svg{width:100%;height:auto;display:block}
.im.px svg{image-rendering:pixelated;shape-rendering:crispEdges}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem}
@media (max-width:48rem){.grid2{grid-template-columns:1fr}}
.grid2 .stage{margin:0}
.build{display:grid;grid-template-columns:repeat(auto-fit,minmax(18rem,1fr));gap:1.5rem;align-items:center}
.build svg{width:100%;height:auto;max-width:26rem}
.build ul{margin:0;padding-left:1.1rem;color:var(--text-weak)}
.build li{margin:.35rem 0}
.sws{display:grid;grid-template-columns:repeat(auto-fill,minmax(11.5rem,1fr));gap:.75rem}
.sw{display:grid;gap:.15rem;font-size:.8125rem}
.sw .chip{height:3.25rem;border-radius:var(--nm-radius-md);border:1px solid var(--border-norm)}
.sw span:not(.chip){font-family:var(--nm-font-mono);color:var(--text-weak)}
.sw small{color:var(--text-weak)}
.themebox{border-radius:var(--nm-radius-xl);padding:1.25rem;border:1px solid var(--border-norm);margin-bottom:.75rem}
.tw{overflow-x:auto;border:1px solid var(--border-weak);border-radius:var(--nm-radius-lg)}
table{border-collapse:collapse;width:100%;font-size:.8125rem;min-width:46rem}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--border-weak);vertical-align:middle}
th{color:var(--text-weak);font-weight:600}
td.num{font-family:var(--nm-font-mono);white-space:nowrap}
.pair{display:inline-block;padding:.1rem .5rem;border-radius:var(--nm-radius-sm);font-weight:700;border:1px solid var(--border-weak)}
.type{display:grid;grid-template-columns:repeat(auto-fit,minmax(19rem,1fr));gap:2rem}
.type .big{font-size:2.25rem;line-height:1.12;font-weight:700;letter-spacing:-.015em;margin:0 0 .75rem}
.type dl{margin:0;display:grid;gap:.6rem}
.type dt{font-size:.75rem;color:var(--text-weak);font-family:var(--nm-font-mono)}
.type dd{margin:0}
.seed{display:grid;grid-template-columns:repeat(4,1fr);gap:.4rem;font-family:var(--nm-font-mono);font-size:.875rem;margin:.75rem 0 0;padding:0;list-style:none;counter-reset:w}
.seed li{counter-increment:w;background:var(--background-weak);border-radius:var(--nm-radius-sm);padding:.3rem .5rem}
.seed li::before{content:counter(w) " ";color:var(--text-hint)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));gap:.75rem}
.card{border:1px solid var(--border-norm);border-radius:var(--nm-radius-xl);padding:1.25rem;display:flex;flex-direction:column;gap:.6rem}
.card h4{margin:0;font-size:1rem}
.card p{margin:0;color:var(--text-weak);font-size:.9375rem}
.card .demo{margin-top:auto;min-height:5.5rem;border-radius:var(--nm-radius-lg);display:flex;align-items:center;justify-content:center;gap:.9rem;padding:1rem}
footer{padding:2rem 0 3rem;color:var(--text-weak);font-size:.875rem;border-top:1px solid var(--border-weak)}
"""

TEMPLATE = r"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NightMail — %%TITLE%%</title>
<!-- GENERATED by tools/build.py (preview). Do not edit by hand. -->
<style>
%%FONTS%%
</style>
<style>
/* ---- tokens.css ---- */
%%TOKENS%%
/* ---- theme-base.css ---- */
%%THEME_BASE%%
</style>
<style>%%PAGE_CSS%%%%STAGE_CSS%%
/* ---- inbox mock-up ---- */%%MOCK_CSS%%
/* ---- specific to this identity ---- */
%%MARKER_CSS%%
%%EXTRA_CSS%%
</style>
</head>
<body>
<header class="top"><div class="wrap">
  %%HERO_LOGO%%
  <div class="switch" role="group" aria-label="Tema de la página">
    <button data-t="" aria-pressed="true">Sistema</button><button data-t="light" aria-pressed="false">Claro</button><button data-t="dark" aria-pressed="false">Oscuro</button>
  </div>
</div></header>

<main class="wrap">
<div class="hero">
  <p class="kicker">%%KICKER%%</p>
  <h1>%%H1%%</h1>
  <p class="lead">%%HERO_LEAD%%</p>
</div>

<section class="blk">
  <h2>%%LOGO_TITLE%%</h2>
  <p class="lead">%%LOGO_LEAD%%</p>
  <div class="build">%%BUILD%%</div>

  <h3 class="sub">Símbolo · tamaños</h3>
  <div class="grid2"><div class="stage p0">%%SYMBOL_SIZES%%</div><div class="stage t9">%%SYMBOL_SIZES_DARK%%</div></div>
  <h3 class="sub">Lockup horizontal y wordmark</h3>
  <div class="grid2"><div class="stage p0">%%LOCKUP%%</div><div class="stage t9">%%LOCKUP_DARK%%</div>
  <div class="stage p1">%%WORDMARK%%</div><div class="stage t8">%%WORDMARK_DARK%%</div></div>
  <h3 class="sub">Una sola tinta (logo-mono.svg, currentColor)</h3>
  <div class="grid2"><div class="stage p0">%%MONO%%</div><div class="stage t9">%%MONO%%</div><div class="stage ac1">%%MONO%%</div><div class="stage ac2">%%MONO%%</div></div>
  <h3 class="sub">Icono de la app</h3>
  <div class="grid2"><div class="stage p1">%%ICON_BIG%%</div><div class="stage t8">%%ICON_BIG%%</div>
  <div class="stage p1">%%ICON_SMALL%%</div><div class="stage t8">%%ICON_SMALL%%</div></div>
</section>

<section class="blk">
  <h2>Paleta</h2>
  <p class="lead">%%PALETTE_LEAD%%</p>
  <h3 class="sub">Primitivos</h3>
  <div class="sws">%%PRIMITIVES%%</div>
  <h3 class="sub">Tokens semánticos · tema claro</h3>
  <div class="themebox" data-theme="light"><div class="sws">%%SEM_LIGHT%%</div></div>
  <h3 class="sub">Tokens semánticos · tema oscuro</h3>
  <div class="themebox" data-theme="dark"><div class="sws">%%SEM_DARK%%</div></div>
  <h3 class="sub">Contraste WCAG · tema claro</h3>
  <div class="tw"><table><thead><tr><th></th><th>Par</th><th>Primer plano</th><th>Fondo</th><th>Ratio</th><th>Mín.</th><th></th></tr></thead><tbody>%%CONTRAST_LIGHT%%</tbody></table></div>
  <h3 class="sub">Contraste WCAG · tema oscuro</h3>
  <div class="tw"><table><thead><tr><th></th><th>Par</th><th>Primer plano</th><th>Fondo</th><th>Ratio</th><th>Mín.</th><th></th></tr></thead><tbody>%%CONTRAST_DARK%%</tbody></table></div>
</section>

<section class="blk">
  <h2>Tipografía</h2>
  <p class="lead">%%TYPE_LEAD%%</p>
  <div class="type">%%TYPE%%</div>
</section>

%%EXTRA_SECTIONS%%

<section class="blk">
  <h2>Bandeja de entrada</h2>
  <p class="lead">Maqueta de la bandeja con las variables reales de la hoja de estilos base (<code>--background-norm</code>, <code>--interaction-norm</code>, <code>--text-weak</code>…) apuntando a los tokens de NightMail.</p>
  %%MOCK_LIGHT%%
  %%MOCK_DARK%%
</section>
</main>

<footer><div class="wrap">%%FOOTER%%</div></footer>

<script>
document.querySelectorAll('.switch button').forEach(function (b) {
  b.addEventListener('click', function () {
    var t = b.getAttribute('data-t');
    if (t) { document.documentElement.setAttribute('data-theme', t); } else { document.documentElement.removeAttribute('data-theme'); }
    document.querySelectorAll('.switch button').forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
  });
});
%%SCRIPT%%
</script>
</body>
</html>
"""


def stage_css() -> str:
    return "\n" + "\n".join(
        f".stage.{name}{{background:{bg};color:{fg};border-color:{border}}}" for name, (bg, fg, border) in ident.STAGES.items()
    )


def marker_css(scope: str = "") -> str:
    return ident.MARKER_CSS.replace("{S}", scope)


def build_preview() -> str:
    p = ident.PREVIEW
    by = ident.SIZE_BY
    lockup = themed("logo-lockup-horizontal.svg")
    lock_sizes = ident.LOCKUP_SIZES
    parts = {
        "TITLE": html.escape(p["title"]),
        "FONTS": font_face_css(),
        "TOKENS": (DIR / "tokens.css").read_text(encoding="utf-8"),
        "THEME_BASE": (DIR / "theme-base.css").read_text(encoding="utf-8"),
        "PAGE_CSS": PAGE_CSS,
        "STAGE_CSS": stage_css(),
        "MOCK_CSS": MOCK_CSS,
        "MARKER_CSS": marker_css(),
        "EXTRA_CSS": p.get("css", ""),
        "HERO_LOGO": lockup,
        "KICKER": p["kicker"],
        "H1": p["h1"],
        "HERO_LEAD": p["hero_lead"],
        "LOGO_TITLE": p["logo_title"],
        "LOGO_LEAD": p["logo_lead"],
        "BUILD": p["build"],
        "SYMBOL_SIZES": "".join(img("logo-symbol.svg", s, by=by) for s in ident.SYMBOL_SIZES),
        "SYMBOL_SIZES_DARK": "".join(img("logo-symbol-dark.svg", s, by=by) for s in ident.SYMBOL_SIZES),
        "LOCKUP": "".join(img("logo-lockup-horizontal.svg", s) for s in lock_sizes),
        "LOCKUP_DARK": "".join(img("logo-lockup-horizontal-dark.svg", s) for s in lock_sizes),
        "WORDMARK": img("logo-wordmark.svg", 14, "14 px (mínimo)") + img("logo-wordmark.svg", 28),
        "WORDMARK_DARK": img("logo-wordmark-dark.svg", 14, "14 px (mínimo)") + img("logo-wordmark-dark.svg", 28),
        "MONO": "".join(img("logo-mono.svg", s, by=by) for s in ident.MONO_SIZES),
        "ICON_BIG": img("app-icon.svg", 256, "app-icon.svg · 256 px (maestro a 1024)")
        + img("app-icon.svg", 128)
        + img("app-icon.svg", 64)
        + img("app-icon.svg", 48),
        "ICON_SMALL": img("app-icon-small.svg", 32, "app-icon-small.svg · 32 px")
        + img("app-icon-small.svg", 24)
        + img("app-icon-small.svg", 16)
        + '<figure><span class="im h px" style="height:128px">'
        + svg("app-icon-small.svg")
        + "</span><figcaption>16 px ampliado × 8</figcaption></figure>",
        "PALETTE_LEAD": p["palette_lead"],
        "PRIMITIVES": "".join(swatch("--nm-" + k, v, ident.PRIMITIVE_NOTES.get(k, "")) for k, v in ident.PRIMITIVES.items()),
        "SEM_LIGHT": semantic(True),
        "SEM_DARK": semantic(False),
        "CONTRAST_LIGHT": contrast_table(True),
        "CONTRAST_DARK": contrast_table(False),
        "TYPE_LEAD": p["type_lead"],
        "TYPE": p["type"],
        "EXTRA_SECTIONS": p.get("sections", ""),
        "MOCK_LIGHT": mock("light", lockup),
        "MOCK_DARK": mock("dark", lockup),
        "FOOTER": p["footer"],
        "SCRIPT": p.get("script", ""),
    }
    page = TEMPLATE
    for key, value in parts.items():
        page = page.replace("%%" + key + "%%", value)
    # Markers that the own sections can use to embed SVG from the folder.
    page = re.sub(r"%%SVG:([\w.\-]+)%%", lambda m: svg(m.group(1)), page)
    page = re.sub(r"%%THEMED:([\w.\-]+)%%", lambda m: themed(m.group(1)), page)
    assert "%%" not in page, "unreplaced markers left: " + ", ".join(sorted(set(re.findall(r"%%[\w:.\-]+%%", page))))
    return page


def cmd_preview() -> int:
    (DIR / "preview.html").write_text(build_preview(), encoding="utf-8", newline="\n")
    print("Escrito", DIR / "preview.html")
    return 0


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #

FORBIDDEN = ("<image", "<text", "font-family", "href", "<style", "<script", "<foreignObject", "http://", "https://")


def validate_svg(path: Path) -> str | None:
    """Returns None if the SVG is valid, or the reason for the failure."""
    text = path.read_text(encoding="utf-8")
    try:
        root = xml.dom.minidom.parseString(text).documentElement
    except Exception as exc:  # noqa: BLE001
        return f"invalid XML ({exc})"
    bad = [t for t in FORBIDDEN if t in text.replace(SVG_NS, "")]
    box = root.getAttribute("viewBox").split()
    if root.tagName != "svg" or root.getAttribute("xmlns") != SVG_NS or len(box) != 4 or bad:
        return f"root/viewBox/content not allowed {bad}"
    ids = re.findall(r'\bid="([^"]+)"', text)
    refs = set(re.findall(r"url\(#([^)]+)\)", text)) | set(re.findall(r'aria-labelledby="([^"]+)"', text))
    if len(ids) != len(set(ids)) or not refs <= set(ids):
        return f"duplicate ids or references without a target ({sorted(refs - set(ids))})"
    return None


def validate_html(path: Path) -> list[str]:
    """List of reasons why the HTML would load something remote or external (empty = correct)."""
    problems: list[str] = []
    page = path.read_text(encoding="utf-8")

    class Refs(HTMLParser):
        def handle_starttag(self, tag, attrs):
            for key, value in attrs:
                if key in ("src", "href", "srcset", "action", "data", "poster", "xlink:href") and value and not value.startswith("#"):
                    problems.append(f"<{tag} {key}={value[:60]!r}>")
            if tag in ("link", "iframe", "object", "embed", "base"):
                problems.append(f"tag <{tag}>")

    Refs().feed(page)
    urls = [u for u in re.findall(r"url\(\s*['\"]?([^)'\"]{0,24})", page) if not u.startswith(("data:", "#"))]
    if urls:
        problems.append(f"non-embedded url(): {sorted(set(urls))}")
    if "@import" in page:
        problems.append("@import")
    remote = sorted(set(re.findall(r"https?://[^\s\"'<)]+", page)) - {SVG_NS})
    if remote:
        problems.append(f"absolute URLs: {remote}")
    code = re.sub(r"url\(data:[^)]*\)", "url(data:)", page)  # without the embedded fonts (base64)
    if re.search(r"\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b", code):
        problems.append("the script uses a network API")
    return problems


def cmd_validate() -> int:
    errors = 0
    for path in sorted(DIR.rglob("*.svg")):
        why = validate_svg(path)
        errors += bool(why)
        box = re.search(r'viewBox="([^"]+)"', path.read_text(encoding="utf-8"))
        print(f"{'FAIL ' if why else 'ok   '} {path.relative_to(DIR)}  " + (why or f"viewBox={box.group(1)}  {path.stat().st_size} bytes"))
    for path in sorted(DIR.glob("*.html")):
        problems = validate_html(path)
        errors += len(problems)
        for why in problems:
            print(f"FAIL {path.name}: {why}")
        if not problems:
            print(f"ok    {path.name}  {path.stat().st_size // 1024} KiB, no remote resources")
    for name in ("tokens.css", "theme-base.css"):
        css = (DIR / name).read_text(encoding="utf-8")
        if "url(" in css or "@import" in css or "http" in css:
            errors += 1
            print(f"FAIL {name}: external reference")
        else:
            count = len(re.findall(r"--[\w-]+:", css))
            print(f"ok    {name}  {count} declarations")
    return 1 if errors else 0


if __name__ == "__main__":
    args = sys.argv[1:]
    cmd = args[0] if args else "contrast"
    if cmd == "contrast":
        sys.exit(cmd_contrast("--md" in args))
    if cmd == "build":
        sys.exit(cmd_build())
    if cmd == "wordmark" and len(args) == 2:
        sys.exit(cmd_wordmark(args[1]))
    if cmd == "preview":
        sys.exit(cmd_preview())
    if cmd == "validate":
        sys.exit(cmd_validate())
    if cmd == "all":
        sys.exit(cmd_build() or cmd_preview() or cmd_contrast(False) or cmd_validate())
    sys.exit(__doc__)
