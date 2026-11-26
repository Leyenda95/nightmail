#!/usr/bin/env bash
# Builds the desktop app on Linux or WSL: debug build with the app's security policy, no installer.
#
#   bash tools/dev/build.sh
#
# Requires npm ci and the vendored base stylesheet (bash tools/vendor-base-styles.sh).
# The binary lands in apps/desktop/src-tauri/target/debug/nightmail-desktop (or $CARGO_TARGET_DIR/debug).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
cd "$ROOT" || exit 1
set +u
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use >/dev/null
set -u
[ -d "$ROOT/vendor/base-styles" ] || { echo "ERROR: vendor/base-styles is missing. Run: bash tools/vendor-base-styles.sh"; exit 1; }

mkdir -p "$ROOT/.data/dev"
LOG="$ROOT/.data/dev/build.log"
cd "$ROOT/apps/desktop" || exit 1
start=$(date +%s)
npx tauri build --debug --no-bundle > "$LOG" 2>&1
code=$?
echo "Exit $code in $(( $(date +%s) - start )) s. Full log: $LOG"
tail -n 5 "$LOG"
exit $code
