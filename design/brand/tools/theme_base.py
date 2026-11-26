#!/usr/bin/env python3
"""Shared base of NightMail's brand engine (a library; Python 3 stdlib only).

`build.py` takes from here:

  * the theme data in `theme-base.json`, next to this file: the ordered list of the
    variables a theme must define for the base stylesheet (`VARIABLES`), the few that
    NightMail names differently in identity.py (`OWN_NAMES`), and the fixed shades
    (`-minor-*`, `-major-*`) and text colour (`-contrast`) of each base colour (`SHADES`,
    `CONTRAST`). The shades are fixed values: if a base colour changes in identity.py,
    its row there must change too (build.py stops if they do not match);
  * the WCAG 2.x contrast calculation (`contrast`) and the list of pairs that are
    checked (`PAIRS`).

This file is not executed: it writes nothing.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_DATA = json.loads((Path(__file__).resolve().parent / "theme-base.json").read_text(encoding="utf-8"))

VARIABLES: list[str] = _DATA["variables"]
OWN_NAMES: dict[str, str] = _DATA["own_names"]
SHADES: dict[str, dict[str, list[str]]] = _DATA["shades"]
CONTRAST: dict[str, dict[str, str]] = _DATA["contrast"]

BUTTON_BASES = [
    "primary",
    "signal-danger",
    "signal-warning",
    "signal-success",
    "signal-info",
    "interaction-norm",
    "interaction-weak",
]
SHADE_NAMES = ["-minor-2", "-minor-1", "", "-major-1", "-major-2", "-major-3"]


def own_name(variable: str) -> str:
    """The name identity.py uses for a variable of the base stylesheet."""
    return OWN_NAMES.get(variable, variable)


# --------------------------------------------------------------------------- #
# Contrast
# --------------------------------------------------------------------------- #


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def luminance(h: str) -> float:
    def lin(c: float) -> float:
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (lin(c) for c in hex_to_rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


# (text/foreground, background, minimum, description)
PAIRS = [
    ("text-norm", "background-norm", 4.5, "Texto principal sobre fondo"),
    ("text-norm", "background-weak", 4.5, "Texto principal sobre fondo débil (barra lateral)"),
    ("text-norm", "background-strong", 4.5, "Texto principal sobre fondo fuerte"),
    ("text-weak", "background-norm", 4.5, "Texto secundario sobre fondo"),
    ("text-weak", "background-weak", 4.5, "Texto secundario sobre fondo débil"),
    ("text-weak", "background-strong", 4.5, "Texto secundario sobre fondo fuerte"),
    ("text-hint", "background-norm", 4.5, "Texto de ayuda / placeholder sobre fondo"),
    ("text-hint", "background-weak", 4.5, "Texto de ayuda sobre fondo débil"),
    ("text-invert", "background-invert", 4.5, "Texto invertido (tooltips)"),
    ("primary", "background-norm", 4.5, "Enlace / acento como texto sobre fondo"),
    ("primary", "background-weak", 4.5, "Enlace / acento sobre fondo débil"),
    ("primary", "background-strong", 3.0, "Acento como componente sobre fondo fuerte"),
    ("primary-contrast", "primary", 4.5, "Texto de botón primario"),
    ("primary-contrast", "primary-major-1", 4.5, "Texto de botón primario (hover)"),
    ("primary-contrast", "primary-major-2", 4.5, "Texto de botón primario (activo)"),
    ("text-norm", "primary-minor-2", 4.5, "Texto sobre tinte del acento (-minor-2)"),
    ("text-norm", "primary-minor-1", 4.5, "Texto sobre tinte del acento (-minor-1)"),
    ("interaction-weak-contrast", "interaction-weak", 4.5, "Texto de botón secundario"),
    ("signal-danger-contrast", "signal-danger", 4.5, "Texto de botón de peligro"),
    ("signal-danger", "background-norm", 4.5, "Mensaje de error como texto"),
    ("signal-warning-contrast", "signal-warning", 4.5, "Texto sobre aviso"),
    ("signal-warning", "background-norm", 3.0, "Icono de aviso sobre fondo"),
    ("signal-success-contrast", "signal-success", 4.5, "Texto sobre éxito"),
    ("signal-success", "background-norm", 4.5, "Mensaje de éxito como texto"),
    ("signal-info-contrast", "signal-info", 4.5, "Texto sobre información"),
    ("signal-info", "background-norm", 4.5, "Información como texto"),
    ("field-norm", "background-norm", 3.0, "Borde de campo de formulario"),
    ("field-hover", "background-norm", 3.0, "Borde de campo (hover)"),
    ("focus-outline", "background-norm", 3.0, "Anillo de foco sobre fondo"),
    ("focus-outline", "background-weak", 3.0, "Anillo de foco sobre fondo débil"),
    ("optional-email-item-read-text-color", "optional-email-item-read-background-color", 4.5, "Correo leído en la lista"),
    (
        "optional-email-item-selected-text-color",
        "optional-email-item-selected-background-color",
        4.5,
        "Correo seleccionado en la lista",
    ),
    ("text-weak", "optional-email-item-selected-background-color", 4.5, "Texto secundario en correo seleccionado"),
    ("primary", "optional-email-item-selected-background-color", 3.0, "Marcador de acento en correo seleccionado"),
]


if __name__ == "__main__":
    sys.exit("theme_base.py es una biblioteca. Usa: python3 design/brand/tools/build.py all")
