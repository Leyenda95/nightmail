#!/usr/bin/env bash
# Opens the desktop app (debug build) against the local stack from tools/dev/up.sh, on Linux or WSL.
#
#   bash tools/dev/window.sh [profile]
#
# Each profile is an app data folder under .data/dev/profiles/<profile> (default: perfil-a).
# Use a new name to start with an empty profile, e.g. to test restoring from the seed phrase.
# Never open two windows with the same profile at once.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PERFIL="${1:-perfil-a}"
STATE="$ROOT/.data/dev"
RUN="$STATE/run.env"
BIN="${CARGO_TARGET_DIR:-$ROOT/apps/desktop/src-tauri/target}/debug/nightmail-desktop"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
cd "$ROOT" || exit 1
set +u
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use >/dev/null
set -u

[ -x "$BIN" ] || { echo "ERROR: $BIN does not exist. Build first with tools/dev/build.sh."; exit 1; }
[ -f "$RUN" ] || { echo "ERROR: $RUN does not exist. Start the stack first with tools/dev/up.sh."; exit 1; }
KEY=$(grep '^NIGHTMAIL_ISSUER_RECEIPT_KEY=' "$RUN" | cut -d= -f2-)
[ -n "$KEY" ] || { echo "ERROR: $RUN has no receipt key fingerprint."; exit 1; }

export NIGHTMAIL_ISSUER_RECEIPT_KEY="$KEY"
export NIGHTMAIL_NETWORK=undeployed
export NIGHTMAIL_PROFILE_DIR="$STATE/profiles/$PERFIL"

# Never two windows with the same profile: if one is open, leave it as it is.
for pid in $(pgrep -fx "$BIN"); do
  if tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qxF "NIGHTMAIL_PROFILE_DIR=$NIGHTMAIL_PROFILE_DIR"; then
    echo "The window with profile $PERFIL is already open (pid $pid)."
    exit 0
  fi
done
NIGHTMAIL_NODE="$(command -v node)"
export NIGHTMAIL_NODE
mkdir -p "$STATE/profiles"
chmod 700 "$STATE/profiles"

# On WSL: tell xdg-desktop-portal about the display (otherwise the window takes ~23 s to appear)
# and detect a broken WSLg connection (the window would come up invisible).
if grep -qi microsoft /proc/version 2>/dev/null; then
  systemctl --user import-environment DISPLAY WAYLAND_DISPLAY 2>/dev/null || true
  if ! ls /mnt/wslg >/dev/null 2>&1 || tail -n 50 /mnt/wslg/weston.log 2>/dev/null | grep -q 'rdp_allocate_shared_memory: Failed'; then
    echo "ERROR: the WSL window connection is broken. Restart WSL (wsl --shutdown from Windows) and launch tools/dev/up.sh again."
    exit 1
  fi
fi

# Without the payer and server the app still opens and shows stored mail, but cannot create addresses or request plans.
FALTA=
pgrep -f '^node .*src/bin/operator-wallet[.]ts' >/dev/null || FALTA="the payer"
ss -ltn 'sport = :8789' 2>/dev/null | grep -q LISTEN || FALTA="${FALTA:+$FALTA and }the mail server"
[ -z "$FALTA" ] || echo "WARNING: $FALTA not running. Start it with tools/dev/up.sh."

cd "$ROOT/apps/desktop" || exit 1
setsid "$BIN" > "$STATE/window-$PERFIL.log" 2>&1 < /dev/null &
echo "Window open (pid $!), profile $NIGHTMAIL_PROFILE_DIR. Log: $STATE/window-$PERFIL.log"
