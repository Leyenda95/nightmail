#!/usr/bin/env bash
# Manages the payer process (operator wallet) as a systemd user service.
#
#   tools/operator-wallet-service.sh install   # create/update the unit (does not start it)
#   tools/operator-wallet-service.sh start     # started by hand
#   tools/operator-wallet-service.sh status|logs|stop|restart|uninstall
#
# It never starts at login: the payer moves funds, so it is always started by hand.
# `install` disables autostart if an older version enabled it (without stopping a
# running process).
# systemd restarts it when it exits with an error (e.g. a stuck wallet). Output goes
# to .data/operator/<network>/wallet.log (0600); the process redacts secrets itself.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NETWORK="${NIGHTMAIL_NETWORK:-preprod}"
case "$NETWORK" in preprod|undeployed) ;; *) echo "Unsupported network: $NETWORK" >&2; exit 1 ;; esac
UNIT="nightmail-operator-wallet-$NETWORK.service"
UNIT_FILE="$HOME/.config/systemd/user/$UNIT"
LOG="$ROOT/.data/operator/$NETWORK/wallet.log"

node_bin() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null
  command -v node
}

case "${1:-status}" in
  install)
    NODE="$(node_bin)"
    mkdir -p "$(dirname "$UNIT_FILE")" "$(dirname "$LOG")"
    chmod 700 "$ROOT/.data" "$ROOT/.data/operator" "$(dirname "$LOG")"
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=NightMail operator wallet / payer ($NETWORK)

[Service]
WorkingDirectory=$ROOT/apps/server
Environment=NIGHTMAIL_NETWORK=$NETWORK
ExecStart=$NODE --max-old-space-size=4096 src/bin/operator-wallet.ts
Restart=always
RestartSec=30
# 78 = permanent configuration error (permissions, seed, network): do not restart in a loop.
RestartPreventExitStatus=78
TimeoutStopSec=90
NoNewPrivileges=true
UMask=0077
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user disable "$UNIT" 2>/dev/null || true
    echo "Unit $UNIT installed (not started). Log: $LOG"
    echo "Start it with: $0 start   (if it was already running: $0 restart)"
    ;;
  start|stop|restart) systemctl --user "$1" "$UNIT" ;;
  status) systemctl --user status "$UNIT" --no-pager || true ;;
  logs) tail -n 50 -f "$LOG" ;;
  uninstall)
    systemctl --user disable --now "$UNIT" || true
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload
    ;;
  *) echo "Usage: $0 install|start|stop|restart|status|logs|uninstall" >&2; exit 1 ;;
esac
