#!/bin/sh
# One-shot service of the Docker backend. It deploys the contracts to the local devnet the first time,
# resumes a deployment that did not finish, and on later runs only checks that the recorded contracts
# are still on the chain and that they are the ones compiled in this image.
set -u
umask 077
DIR=/app/.data/operator/undeployed
CONTRACTS="$DIR/contracts.json"
# Fingerprint of the compiled contracts (their verifier keys) the deployment was made with.
KEYS_FILE="$DIR/contracts-keys.sha256"
KEYS="$(cat /app/contracts/managed/*/keys/*.verifier | sha256sum | cut -d ' ' -f 1)"
HOST="$(cat /etc/hostname)"

# Locks recorded by this service (its host name) belong to an earlier run of it: no other container uses that
# host name, and this one runs alone. A run that was killed (docker compose stop, Ctrl+C) leaves them behind, and
# the payer would honor them forever since they come from another host.
clear_own_locks() {
  for lock in "$DIR/lock" "$DIR/deploy-lock/lock"; do
    if [ -f "$lock" ] && grep -q "\"host\":\"$HOST\"" "$lock"; then rm -f "$lock"; fi
  done
}
clear_own_locks

start_over() {
  echo "[deploy] To start over, delete the backend data and run the demo again:"
  echo "[deploy]   docker compose -f infra/backend/docker-compose.yml down -v"
  exit 1
}

# Exit 0 if contracts.json records a finished deployment whose registry exists on the indexer, 3 if the
# registry is not there, 4 if the indexer could not tell, 5 if the deployment is missing or unfinished
# (deploy-contracts saves it as it goes, so a crash or a timeout leaves it half written).
node -e '
  const [file, url] = process.argv.slice(1);
  let d;
  try { d = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch { process.exit(5); }
  const a = d.registry?.address;
  const pending = d.pending && Object.keys(d.pending).length > 0;
  if (!/^[0-9a-f]{64}$/.test(a ?? "") || !d.token?.color || !d.deployedAt || pending) process.exit(5);
  fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: `{ contractAction(address: "${a}") { __typename } }` }) })
    .then((r) => r.json())
    .then((j) => process.exit(j.errors ? 4 : j.data?.contractAction ? 0 : 3))
    .catch(() => process.exit(4));
' "$CONTRACTS" "$NIGHTMAIL_DEVNET_INDEXER_URL"
state=$?

if [ "$state" = 5 ]; then
  # The wallet has one holder. The payer's lock comes from another container, so it is checked here.
  # Exit 0: the payer answers (running). 1: nothing listens (stopped). 2: no answer in time (cannot tell).
  node -e '
    require("http").get({ socketPath: process.argv[1], path: "/health", timeout: 3000 }, () => process.exit(0))
      .on("error", (e) => process.exit(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? 1 : 2))
      .on("timeout", () => process.exit(2));
  ' "$DIR/payer.sock"
  case $? in
    1) ;;
    0) echo "[deploy] ERROR: the deployment is not finished and the payer is running. Stop the payer first:"
       echo "[deploy]   docker compose -f infra/backend/docker-compose.yml stop payer server"
       exit 1 ;;
    *) echo "[deploy] ERROR: the deployment is not finished and the payer socket does not answer in time."
       echo "[deploy] It may still be running. Stop it, then run the demo again:"
       echo "[deploy]   docker compose -f infra/backend/docker-compose.yml stop payer server"
       exit 1 ;;
  esac
  if [ -f "$DIR/lock" ]; then
    echo "[deploy] the wallet lock left by another container (the payer, which is not running) is set aside"
    mv "$DIR/lock" "$DIR/lock.stale-$HOST-$(date +%s)"
  fi
  if [ -f "$CONTRACTS" ]; then echo "[deploy] resuming the unfinished deployment"
  else echo "[deploy] first run: deploying the contracts to the local network"; fi
  # deploy-contracts adopts what already landed and only sends what is missing (apps/server/src/chain/deploy.ts).
  # It runs as a child, with SIGTERM and SIGINT passed on to it (this shell is pid 1 and ignores them).
  node --max-old-space-size=4096 apps/server/src/bin/deploy-contracts.ts --price 100 &
  child=$!
  trap 'kill -TERM "$child" 2>/dev/null' TERM INT
  wait "$child"
  code=$?
  while kill -0 "$child" 2>/dev/null; do wait "$child"; code=$?; done
  trap - TERM INT
  clear_own_locks
  [ "$code" = 0 ] || exit 1
  echo "$KEYS" > "$KEYS_FILE"
  exit 0
fi

case $state in
  0) echo "[deploy] contracts already deployed" ;;
  3) echo "[deploy] ERROR: the contracts recorded in the backend volume are not on the local network."
     echo "[deploy] The local chain was reset (its containers were removed). Nothing was changed."
     start_over ;;
  *) echo "[deploy] WARNING: could not ask the indexer whether the recorded contracts exist. Continuing." ;;
esac

if [ ! -f "$KEYS_FILE" ]; then
  # A volume deployed before this check existed: record the fingerprint once the chain confirmed it.
  [ "$state" = 0 ] && echo "$KEYS" > "$KEYS_FILE"
elif [ "$(cat "$KEYS_FILE")" != "$KEYS" ]; then
  echo "[deploy] ERROR: the contracts in this image were compiled from other sources than the deployed ones."
  echo "[deploy] The app would make proofs the deployed contracts reject. Nothing was changed."
  start_over
fi
exit 0
