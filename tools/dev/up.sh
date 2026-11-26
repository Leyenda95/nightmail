#!/usr/bin/env bash
# Starts the local NightMail stack on Linux or WSL: the devnet (Docker), the payer and the mail server.
#
#   bash tools/dev/up.sh
#
# One-time setup first: npm ci, compile the contracts and deploy them to the devnet (see README).
# Logs go to .data/dev/payer.log and .data/dev/server.log; .data/dev/run.env gets the PIDs and the
# receipt key fingerprint the app needs (NIGHTMAIL_ISSUER_RECEIPT_KEY). Stop it with tools/dev/down.sh.
set -uo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$ROOT/.data/dev"
mkdir -p "$STATE"
chmod 700 "$ROOT/.data" "$STATE"
cd "$ROOT" || exit 1

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
set +u
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use >/dev/null
set -u
command -v node >/dev/null || { echo "ERROR: node not found (Node 24, see .nvmrc)."; exit 1; }

# With Docker Desktop (WSL), start it if it is stopped.
# shellcheck source=tools/dev/docker-desktop.sh
. "$ROOT/tools/dev/docker-desktop.sh"
if docker_desktop_stopped; then
  echo "Starting Docker Desktop (up to 3 min)"
  start_docker_desktop
fi
docker info >/dev/null 2>&1 || { echo "ERROR: Docker is not responding. Start it and try again."; exit 1; }
docker compose -f infra/devnet/docker-compose.yml up -d --wait || exit 1

if [ ! -f .data/operator/undeployed/contracts.json ]; then
  echo "ERROR: no contracts deployed on the devnet. Deploy them first (with the payer stopped):"
  echo "       NIGHTMAIL_NETWORK=undeployed npm run deploy-contracts -w apps/server -- --price 100"
  exit 1
fi
if pgrep -f '^node .*src/bin/operator-wallet[.]ts' >/dev/null; then
  echo "ERROR: a payer is already running. Stop it first (tools/dev/down.sh) to avoid having two."
  exit 1
fi

export NIGHTMAIL_NETWORK=undeployed
setsid npm run operator-wallet -w apps/server > "$STATE/payer.log" 2>&1 < /dev/null &
PAYER=$!
for _ in $(seq 1 240); do grep -q "ready to pay" "$STATE/payer.log" && break; sleep 1; done
if ! grep -q "ready to pay" "$STATE/payer.log"; then
  echo "WARNING: the payer is not ready yet. Last lines of $STATE/payer.log:"
  tail -n 20 "$STATE/payer.log"
fi

setsid npm run mail-server -w apps/server > "$STATE/server.log" 2>&1 < /dev/null &
SERVER=$!
for _ in $(seq 1 120); do grep -q "relayer: listening" "$STATE/server.log" && break; sleep 1; done
if ! grep -q "relayer: listening" "$STATE/server.log"; then
  echo "WARNING: the mail server is not ready yet. Last lines of $STATE/server.log:"
  tail -n 20 "$STATE/server.log"
fi

KEY=$(grep -o "sha256:[0-9a-f]*" "$STATE/server.log" | head -n 1)
printf 'PAYER=%s\nSERVER=%s\nNIGHTMAIL_ISSUER_RECEIPT_KEY=%s\n' "$PAYER" "$SERVER" "$KEY" > "$STATE/run.env"
echo "Payer (pid $PAYER) and mail server (pid $SERVER) running. State in $STATE/run.env"
