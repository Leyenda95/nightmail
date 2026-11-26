#!/usr/bin/env bash
# One command from a fresh clone to an open NightMail window, on Linux or WSL.
#
#   npm run demo                 # or: bash tools/dev/demo.sh
#   npm run demo -- --check      # only check the prerequisites
#   npm run demo -- --rebuild    # rebuild the desktop app even if it is already built
#   npm run demo -- --backend-only  # everything but the app: for the native Windows app (demo-wsl.sh)
#
# Checks every prerequisite first and stops before changing anything if one is missing.
# Then each step runs only if it is not done yet: npm ci, base stylesheet, contracts, devnet,
# contract deployment, app build, payer and mail server (tools/dev/up.sh) and the window.
# --backend-only skips the app prerequisites (Rust, C tools, Tauri libraries), its build and the window.
# The contracts are not compiled again if their output exists; --rebuild only covers the app.
# It never installs system software. The one thing it fetches on its own is the pinned Compact
# compiler, into ~/.compact, through the Compact CLI (no admin rights needed).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

CHECK_ONLY=
REBUILD=
BACKEND_ONLY=
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --rebuild) REBUILD=1 ;;
    --backend-only) BACKEND_ONLY=1 ;;
    -h|--help) sed -n '2,15s/^# \{0,1\}//p' "$0"; exit 0 ;;
    *) echo "Usage: bash tools/dev/demo.sh [--check] [--rebuild] [--backend-only] [--help]"; exit 2 ;;
  esac
done

COMPOSE=(docker compose -f infra/devnet/docker-compose.yml)
COMPOSE_WANT=2.1.1   # first Compose with up --wait
NODE_WANT="$(tr -d '[:space:]v' < .nvmrc)"
RUST_WANT="$(sed -n 's/^rust-version *= *"\(.*\)"/\1/p' apps/desktop/src-tauri/Cargo.toml)"
COMPACT_WANT="$(sed -n 's/.*"compact": *"+\([0-9.]*\)".*/\1/p' contracts/package.json)"
OPERATOR_DIR=.data/operator/undeployed
CONTRACTS_JSON=$OPERATOR_DIR/contracts.json
INDEXER_URL=http://127.0.0.1:8088/api/v4/graphql
BIN="${CARGO_TARGET_DIR:-$ROOT/apps/desktop/src-tauri/target}/debug/nightmail-desktop"

# True if version $1 >= version $2 (dotted numbers).
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]; }

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
set +u
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use >/dev/null 2>&1
set -u
# The Compact CLI installs into ~/.local/bin, added to PATH only by login shells (~/.profile).
for d in "$HOME/.local/bin" "$HOME/.compact/bin"; do
  [ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
done
export PATH
# shellcheck source=tools/dev/docker-desktop.sh
. "$ROOT/tools/dev/docker-desktop.sh"

# ---------- 1. Prerequisites ----------
echo "[1/8] Checking prerequisites"
MISSING=0
ok() { printf '  OK       %-14s %s\n' "$1" "$2"; }
miss() {
  printf '  MISSING  %-14s %s\n' "$1" "$2"
  shift 2
  for line in "$@"; do printf '           %-14s %s\n' "" "$line"; done
  MISSING=$((MISSING + 1))
}

if command -v node >/dev/null; then
  v="$(node -v | tr -d v)"
  if [ "${v%%.*}" = "${NODE_WANT%%.*}" ] && version_ge "$v" "$NODE_WANT"; then ok node "$v"
  else miss node "found $v, need $NODE_WANT or a later ${NODE_WANT%%.*}.x" "With nvm: nvm install (reads .nvmrc). Or https://nodejs.org/en/download"; fi
else
  miss node "need $NODE_WANT" "Install nvm (https://github.com/nvm-sh/nvm#installing-and-updating), then: nvm install"
fi
if command -v npm >/dev/null; then ok npm "$(npm -v)"; else miss npm "comes with Node" "Install Node (see above)"; fi
if command -v git >/dev/null; then ok git "$(git --version | awk '{print $3}')"
else miss git "" "sudo apt install git (or https://git-scm.com/downloads)"; fi

if [ -n "$BACKEND_ONLY" ]; then
  printf '  SKIP     %-14s %s
' app-tools "Rust, C tools and Tauri libraries (--backend-only)"
else
if command -v rustc >/dev/null && command -v cargo >/dev/null; then
  v="$(rustc --version | awk '{print $2}')"
  if version_ge "$v" "$RUST_WANT"; then ok rust "$v"
  else miss rust "found $v, need $RUST_WANT or later" "rustup update stable"; fi
else
  miss rust "need $RUST_WANT or later" "https://rustup.rs: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
fi

# Native build tools for the encrypted database (vendored OpenSSL and SQLCipher).
for t in cc make perl; do
  if ! command -v "$t" >/dev/null; then miss "$t" "needed to build the encrypted database" "sudo apt install build-essential perl"
  elif [ "$t" = perl ]; then ok perl "$(perl -e 'print substr($^V, 1)')"
  else ok "$t" "$("$t" --version 2>/dev/null | head -n 1 | cut -c1-60)"; fi
done

# Tauri v2 system libraries (https://v2.tauri.app/start/prerequisites/#linux).
if command -v pkg-config >/dev/null; then
  libs_missing=
  for lib in webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 gtk+-3.0; do
    pkg-config --exists "$lib" || libs_missing="$libs_missing $lib"
  done
  if [ -z "$libs_missing" ]; then ok tauri-libs "webkit2gtk-4.1 $(pkg-config --modversion webkit2gtk-4.1)"
  else miss tauri-libs "missing:$libs_missing" \
    "sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev" \
    "Other distributions: https://v2.tauri.app/start/prerequisites/#linux"; fi
else
  miss pkg-config "needed to find the Tauri libraries" "sudo apt install pkg-config"
fi
fi

# Compact CLI and the pinned compiler.
COMPACT_FETCH=
if command -v compact >/dev/null; then
  ok compact-cli "$(compact --version | awk '{print $2}')"
  if v="$(compact compile "+$COMPACT_WANT" --version 2>/dev/null)"; then
    ok compiler "${v%% *}"
  elif [ -n "$CHECK_ONLY" ]; then
    printf '  FETCH    %-14s %s\n' compiler "$COMPACT_WANT not installed, the full run fetches it (compact update $COMPACT_WANT --no-set-default)"
  else
    COMPACT_FETCH=1
    printf '  FETCH    %-14s %s\n' compiler "$COMPACT_WANT not installed, fetching it into ~/.compact (your default compiler stays as it is)"
  fi
else
  miss compact-cli "needed to compile the contracts" \
    "curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh" \
    "then open a new terminal (the compiler $COMPACT_WANT is fetched by this script)"
fi

# Docker with Compose. On WSL with Docker Desktop stopped, the full run starts it.
check_compose() {
  local v
  v="$(docker compose version --short 2>/dev/null | tr -d v)"
  if [ -z "$v" ]; then miss docker-compose "the docker compose plugin is missing" "https://docs.docker.com/compose/install/"
  elif ! version_ge "$v" "$COMPOSE_WANT"; then miss docker-compose "found $v, need $COMPOSE_WANT or later" "Update Docker Desktop, or: https://docs.docker.com/compose/install/"
  else ok docker "$(docker version --format '{{.Server.Version}}' 2>/dev/null), compose $v"; fi
}
if docker_desktop_stopped; then
  if [ -n "$CHECK_ONLY" ] || [ "$MISSING" -gt 0 ]; then
    printf '  START    %-14s %s\n' docker "Docker Desktop is stopped, the full run starts it"
  else
    echo "  START    docker         Docker Desktop is stopped, starting it (up to 3 min)"
    start_docker_desktop
    if docker info >/dev/null 2>&1; then check_compose
    else miss docker "Docker Desktop did not start in 3 min" "Start Docker Desktop on Windows and try again"; fi
  fi
else
  DOCKER_PATH="$(command -v docker)"
  if [ -z "$DOCKER_PATH" ] || [ "${DOCKER_PATH#/mnt/}" != "$DOCKER_PATH" ]; then
    if grep -qi microsoft /proc/version 2>/dev/null; then
      miss docker "not available inside this WSL distribution" \
        "Install Docker Desktop on Windows and turn on WSL integration for this distribution:" \
        "https://docs.docker.com/desktop/features/wsl/"
    else
      miss docker "" "https://docs.docker.com/engine/install/ (Docker Engine with the compose plugin)"
    fi
  elif docker info >/dev/null 2>&1; then
    check_compose
  else
    miss docker "installed but not responding" "Start it (Docker Desktop, or: sudo systemctl start docker) and try again"
  fi
fi

if [ "$MISSING" -gt 0 ]; then
  echo "$MISSING prerequisite(s) missing. Install them and run this again. Nothing was changed."
  exit 1
fi
echo "      All prerequisites present."
[ -n "$CHECK_ONLY" ] && exit 0

if [ -n "$COMPACT_FETCH" ]; then
  compact update "$COMPACT_WANT" --no-set-default || { echo "ERROR: could not fetch the Compact compiler $COMPACT_WANT."; exit 1; }
fi

# ---------- 2. Dependencies ----------
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "[2/8] Installing dependencies (npm ci)"
  npm ci || exit 1
else
  echo "[2/8] Dependencies already installed"
fi

# ---------- 3. Base stylesheet ----------
if [ -d vendor/base-styles/packages/styles ] && [ -d vendor/base-styles/packages/atoms ]; then
  echo "[3/8] Base stylesheet already present"
else
  echo "[3/8] Fetching the base stylesheet"
  bash tools/vendor-base-styles.sh || exit 1
fi

# ---------- 4. Contracts ----------
if [ -f contracts/managed/registry/contract/index.js ] && [ -f contracts/managed/token/contract/index.js ] \
   && [ -d contracts/managed/registry/keys ] && [ -d contracts/managed/token/keys ]; then
  echo "[4/8] Contracts already compiled"
else
  echo "[4/8] Compiling the contracts with ZK keys (takes a few minutes)"
  npm run compile -w contracts || exit 1
fi
if [ -f contracts/managed/registry-sim/contract/index.js ] && [ -f contracts/managed/token-sim/contract/index.js ]; then
  echo "      Simulator version already compiled"
else
  echo "      Compiling the simulator version"
  npm run compile:sim -w contracts || exit 1
fi

# ---------- 5. Local network ----------
echo "[5/8] Starting the local network and waiting until it is healthy"
"${COMPOSE[@]}" up -d --wait || { echo "ERROR: the local network did not become healthy. See: npm run devnet:status"; exit 1; }

# ---------- 6. Contract deployment ----------
# Exit 0 if the registry in contracts.json exists on the local indexer, 3 if not, 4 if it could not tell.
registry_on_chain() {
  node -e '
    const [file, url] = process.argv.slice(1);
    const a = JSON.parse(require("fs").readFileSync(file, "utf8")).registry?.address;
    if (!/^[0-9a-f]+$/.test(a ?? "")) process.exit(4);
    fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `{ contractAction(address: "${a}") { __typename } }` }) })
      .then((r) => r.json())
      .then((j) => process.exit(j.errors ? 4 : j.data?.contractAction ? 0 : 3))
      .catch(() => process.exit(4));
  ' "$CONTRACTS_JSON" "$INDEXER_URL"
}
if [ -f "$CONTRACTS_JSON" ]; then
  registry_on_chain
  case $? in
    0) echo "[6/8] Contracts already deployed ($CONTRACTS_JSON)" ;;
    3) echo "ERROR: $CONTRACTS_JSON names contracts that are not on the local network."
       echo "       The local chain was reset (its containers were removed, for example with docker compose down)."
       echo "       Nothing was changed. To deploy again on the new chain, move the old operator folder aside and rerun:"
       echo "         mv $OPERATOR_DIR $OPERATOR_DIR.old-$(date +%Y%m%d-%H%M%S) && npm run demo"
       exit 1 ;;
    *) echo "[6/8] WARNING: could not ask the local indexer whether the contracts in $CONTRACTS_JSON exist. Continuing." ;;
  esac
else
  echo "[6/8] Deploying the contracts to the local network"
  NIGHTMAIL_NETWORK=undeployed npm run deploy-contracts -w apps/server -- --price 100 || exit 1
fi

# ---------- 7. Desktop app ----------
if [ -n "$BACKEND_ONLY" ]; then
  echo "[7/8] Desktop app skipped (--backend-only)"
elif [ -x "$BIN" ] && [ -z "$REBUILD" ]; then
  echo "[7/8] Desktop app already built (use --rebuild to build it again)"
else
  echo "[7/8] Building the desktop app (the first build takes several minutes)"
  bash tools/dev/build.sh || exit 1
fi

# ---------- 8. Payer, mail server and window ----------
payer_up() { pgrep -f '^node .*src/bin/operator-wallet[.]ts' >/dev/null; }
server_up() { ss -ltn 'sport = :8789' 2>/dev/null | grep -q LISTEN; }
if payer_up && server_up && [ -f .data/dev/run.env ]; then
  echo "[8/8] Payer and mail server already running"
elif payer_up || server_up; then
  echo "ERROR: the payer or the mail server is running, but not both. Stop them with tools/dev/down.sh and run this again."
  exit 1
else
  echo "[8/8] Starting the payer and the mail server"
  bash tools/dev/up.sh || exit 1
fi
if [ -n "$BACKEND_ONLY" ]; then
  echo "Backend ready: local network, payer and mail server are running in $ROOT."
  echo "Keep this Ubuntu terminal open while you use the app: closing it can shut WSL down and stop them."
  echo "To stop them: bash $ROOT/tools/dev/down.sh (add --devnet to stop the local network too)."
  exit 0
fi
# window.sh does not open a second window on a profile that is already open.
bash tools/dev/window.sh
