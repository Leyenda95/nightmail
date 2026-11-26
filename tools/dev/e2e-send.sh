#!/usr/bin/env bash
# End-to-end check of NightMail-to-NightMail mail on the local devnet: two temporary profiles (A and B) each create a
# mailbox through the real Issuer and relayer, A writes to B, B receives it with the sender checked and answers A,
# plus the refusals (no such address, too large, the same Message-ID twice). Prints the times.
#
#   bash tools/dev/e2e-send.sh               # uses the stack's mail server if it has the delivery route
#   bash tools/dev/e2e-send.sh --own-server  # always starts a mail server of its own for the test
#   bash tools/dev/e2e-send.sh --keep        # keeps the two profiles in .data/dev/e2e-send and reuses them next time
#
# Each new profile takes a plan from the Issuer, which gives 3 free plans per IP and day (then the simulated card,
# 3 more): with --keep, runs after the first one create no addresses and take seconds.
#
# Needs the stack running (tools/dev/up.sh: devnet, payer, mail server with its Issuer and relayer) and Node 24 (nvm).
# It does not stop or restart anything of the stack, and never touches the app's own profiles.
# If the stack's mail server predates the delivery route (POST /v1/box/<addrKey>/deliver), or with --own-server, it
# starts apps/server/test/serve-mail-server.ts (the same server code, without Issuer, relayer or payer) on free
# loopback ports with a temporary database, synced with the same chain, and stops it at the end.
set -uo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1
OWN=0
for arg in "$@"; do
  case "$arg" in
    --own-server) OWN=1 ;;
    --keep) export NIGHTMAIL_E2E_PROFILES="$ROOT/.data/dev/e2e-send" ;;
    *) echo "usage: bash tools/dev/e2e-send.sh [--own-server] [--keep]"; exit 2 ;;
  esac
done

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
set +u
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use >/dev/null
set -u
command -v node >/dev/null || { echo "ERROR: node not found (Node 24, see .nvmrc)."; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "ERROR: Node 24 or later is needed."; exit 1; }
command -v cargo >/dev/null || { echo "ERROR: cargo not found."; exit 1; }

up() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for port in 9944 8088 6300 8788 8789; do
  up "$port" || { echo "ERROR: nothing on 127.0.0.1:$port. Start the stack first: bash tools/dev/up.sh"; exit 1; }
done
[ -f .data/operator/undeployed/contracts.json ] || { echo "ERROR: no contracts deployed on the devnet (see README)."; exit 1; }

if [ -z "${NIGHTMAIL_ISSUER_RECEIPT_KEY:-}" ]; then
  NIGHTMAIL_ISSUER_RECEIPT_KEY=$(grep -s '^NIGHTMAIL_ISSUER_RECEIPT_KEY=' .data/dev/run.env | cut -d= -f2)
fi
case "${NIGHTMAIL_ISSUER_RECEIPT_KEY:-}" in
  sha256:*) export NIGHTMAIL_ISSUER_RECEIPT_KEY ;;
  *) echo "ERROR: NIGHTMAIL_ISSUER_RECEIPT_KEY=sha256:... is missing (printed by the mail server, kept in .data/dev/run.env)."; exit 1 ;;
esac

# Does the stack's server have the delivery route? A body of the wrong length is a 400 there, a 404 on an older one.
has_route() {
  local box
  box=$(printf '0%.0s' $(seq 1 64))
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/octet-stream' \
    --data-binary 'xx' "$1/v1/box/$box/deliver")" = 400 ]
}

TMP=$(mktemp -d)
SERVER=""
HOLD=""
cleanup() {
  # Closing the server's stdin stops it.
  [ -n "$HOLD" ] && kill "$HOLD" 2>/dev/null
  [ -n "$SERVER" ] && wait "$SERVER" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

if [ -z "${NIGHTMAIL_API_URL:-}" ]; then
  if [ "$OWN" = 0 ] && up 8787 && has_route http://127.0.0.1:8787; then
    export NIGHTMAIL_API_URL=http://127.0.0.1:8787
  else
    [ "$OWN" = 0 ] && echo "The stack's mail server has no delivery route (restart it with tools/dev/down.sh and up.sh to use it)."
    echo "Starting a mail server of its own for the test (log in $TMP/server.log while it runs)..."
    # Its stdin is a pipe held open until the end.
    mkfifo "$TMP/stdin"
    sleep infinity > "$TMP/stdin" &
    HOLD=$!
    NIGHTMAIL_NETWORK=undeployed node apps/server/test/serve-mail-server.ts "$TMP/mail.sqlite" \
      < "$TMP/stdin" > "$TMP/url" 2> "$TMP/server.log" &
    SERVER=$!
    for _ in $(seq 1 120); do [ -s "$TMP/url" ] && break; kill -0 "$SERVER" 2>/dev/null || break; sleep 1; done
    [ -s "$TMP/url" ] || { echo "ERROR: the test's mail server did not start:"; tail -n 20 "$TMP/server.log"; exit 1; }
    NIGHTMAIL_API_URL=$(head -n 1 "$TMP/url")
    export NIGHTMAIL_API_URL
    has_route "$NIGHTMAIL_API_URL" || { echo "ERROR: the test's mail server does not answer."; exit 1; }
  fi
fi
echo "Mailbox API: $NIGHTMAIL_API_URL"

cd apps/desktop/src-tauri || exit 1
cargo test --lib app::e2e_send -- --ignored --nocapture
