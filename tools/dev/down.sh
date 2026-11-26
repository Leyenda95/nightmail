#!/usr/bin/env bash
# Stops the payer and mail server started by tools/dev/up.sh (only those processes, by PID).
#
#   bash tools/dev/down.sh            # leaves the devnet running
#   bash tools/dev/down.sh --devnet   # also stops the devnet containers (keeping their data)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN="$ROOT/.data/dev/run.env"

if [ -f "$RUN" ]; then
  # shellcheck disable=SC1090
  . "$RUN"
  kill -TERM -- "-$SERVER" "-$PAYER" 2>/dev/null
  for _ in $(seq 1 60); do ps -p "$SERVER,$PAYER" >/dev/null || break; sleep 1; done
  if ps -p "$SERVER,$PAYER" >/dev/null; then echo "WARNING: one of them is still running."; else echo "Payer and server stopped."; fi
else
  echo "No $RUN: nothing to stop."
fi

if [ "${1:-}" = "--devnet" ]; then
  docker compose -f "$ROOT/infra/devnet/docker-compose.yml" stop
fi
