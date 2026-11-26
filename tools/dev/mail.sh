#!/usr/bin/env bash
# Sends sample mail to devnet addresses through the local SMTP server (127.0.0.1:2525).
#
#   bash tools/dev/mail.sh name@nightmail.local [other@nightmail.local ...]
#
# More options (templates, message count, size): node tools/demo-mailer/src/cli.ts --help
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ $# -gt 0 ] || { echo "Usage: $0 address@nightmail.local [another ...]"; exit 2; }
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
cd "$ROOT" || exit 1
set +u
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use >/dev/null
set -u
args=()
for to in "$@"; do args+=(--to "$to"); done
node tools/demo-mailer/src/cli.ts "${args[@]}"
