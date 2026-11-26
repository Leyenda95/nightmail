#!/usr/bin/env bash
# Starts the NightMail backend in WSL for the native Windows app, from a copy of the project on Windows.
#
#   bash /mnt/c/<windows copy>/tools/dev/demo-wsl.sh [--dir <linux folder>] [--check]
#
# Run it in a WSL (Ubuntu) terminal. It keeps a Linux copy of the project (default ~/nightmail-wsl,
# or --dir, or NIGHTMAIL_WSL_DIR) and runs tools/dev/demo.sh --backend-only there: local network,
# contracts, payer and mail server. Then open the app on Windows with: npm run demo:windows
#
# The Linux copy is a git clone of the Windows copy, updated (fast-forward) on every run, so it gets
# the committed content only. Without git on the Windows side (a downloaded ZIP) the files are copied.
# --check only updates the Linux copy and checks the prerequisites; it starts nothing.
set -uo pipefail

SRC="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="${NIGHTMAIL_WSL_DIR:-$HOME/nightmail-wsl}"
ARGS=(--backend-only)
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:?--dir needs a folder}"; shift ;;
    --check) ARGS+=(--check) ;;
    -h|--help) sed -n '2,12s/^# \{0,1\}//p' "$0"; exit 0 ;;
    *) echo "Usage: bash tools/dev/demo-wsl.sh [--dir <linux folder>] [--check] [--help]"; exit 2 ;;
  esac
  shift
done
DIR="$(realpath -m "$DIR")"

case "$DIR" in /mnt/*) echo "ERROR: $DIR is on a Windows disk. Choose a folder inside Linux, e.g. ~/nightmail-wsl."; exit 1 ;; esac
command -v git >/dev/null || { echo "ERROR: git not found. Install it: sudo apt install git"; exit 1; }
# The Windows copy belongs to another owner as git sees it ("dubious ownership"): trust it for these commands only.
GIT=(git -c "safe.directory=$SRC")

if [ -d "$SRC/.git" ]; then
  # --no-optional-locks: do not write the Windows copy's index while looking.
  if [ -n "$("${GIT[@]}" --no-optional-locks -C "$SRC" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    echo "WARNING: $SRC has uncommitted changes. Only committed content is copied to $DIR."
  fi
  if [ ! -e "$DIR" ]; then
    echo "Cloning $SRC into $DIR"
    "${GIT[@]}" clone --quiet "$SRC" "$DIR" || exit 1
  elif [ "$(git -C "$DIR" remote get-url origin 2>/dev/null)" = "$SRC" ]; then
    echo "Updating $DIR from $SRC"
    "${GIT[@]}" -C "$DIR" fetch --quiet origin HEAD || exit 1
    git -C "$DIR" merge --quiet --ff-only FETCH_HEAD || {
      echo "ERROR: $DIR cannot be fast-forwarded to $SRC (it has its own changes). Move it aside and run this again."
      exit 1
    }
  else
    echo "ERROR: $DIR exists and is not a copy of $SRC. Choose another folder with --dir, or move it aside."
    exit 1
  fi
else
  if [ -e "$DIR" ] && [ ! -f "$DIR/.nightmail-copied" ]; then
    echo "ERROR: $DIR exists and was not made by this script. Choose another folder with --dir, or move it aside."
    exit 1
  fi
  echo "Copying $SRC into $DIR (no git on the Windows side, files are copied as they are)"
  mkdir -p "$DIR" || exit 1
  tar -C "$SRC" --exclude=./.data --exclude=node_modules --exclude=target --exclude=./contracts/managed \
      --exclude=./vendor/base-styles -cf - . | tar -C "$DIR" -xf - || exit 1
  touch "$DIR/.nightmail-copied"
fi

# Which commit the backend runs, so that demo.ps1 can warn if the Windows copy is on another one.
mkdir -p "$DIR/.data/dev" && chmod 700 "$DIR/.data" "$DIR/.data/dev"
if [ -d "$SRC/.git" ]; then git -C "$DIR" rev-parse HEAD; else echo copy; fi > "$DIR/.data/dev/source-commit"

bash "$DIR/tools/dev/demo.sh" "${ARGS[@]}" || exit 1
[[ " ${ARGS[*]} " == *" --check "* ]] && exit 0

WIN_SRC="$(wslpath -w "$SRC" 2>/dev/null || echo "$SRC")"
echo
echo "Next, on Windows, in $WIN_SRC:"
if [ "$DIR" = "$HOME/nightmail-wsl" ]; then
  echo "  npm run demo:windows"
else
  echo "  npm run demo:windows -- -WslDir \"$DIR\""
fi
echo "Keep this Ubuntu terminal open while you use the app."
