#!/usr/bin/env bash
# Fetches a pinned version of the base stylesheet sources (GPLv3) into vendor/base-styles.
# Only what NightMail uses: the SCSS styles and the button SCSS (no React components).
# Not committed (~70 MB); this script reproduces it exactly.
#
# Fonts: the @font-face rules of the base stylesheet are stripped at build time
# (apps/desktop/vite.config.ts); the app only bundles the brand fonts
# (design/brand/fonts, SIL OFL 1.1). Never use the package's commercial fonts.
set -euo pipefail

REPO="https://github.com/ProtonMail/WebClients.git"
COMMIT="d34c0343906121c8f8312916e55f4727f9995fe8"
DEST="$(cd "$(dirname "$0")/.." && pwd)/vendor/base-styles"

if [ -d "$DEST/.git" ]; then
  cd "$DEST"
else
  git clone -q --filter=blob:none --no-checkout "$REPO" "$DEST"
  cd "$DEST"
fi
git sparse-checkout set packages/styles packages/atoms
git fetch -q --depth 1 origin "$COMMIT" 2>/dev/null || git fetch -q origin
git checkout -q "$COMMIT"
echo "Base styles $(git log -1 --format='%h %cs') → $DEST"
