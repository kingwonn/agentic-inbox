#!/usr/bin/env bash
# deploy/import-cloud-state.sh — merge the cloud heartbeat exports (git branch `taskcenter-state`)
# into the local Task Center database.
#
#   taskcenter/deploy/import-cloud-state.sh          # import every export newer than the last one applied
#   taskcenter/deploy/import-cloud-state.sh --all    # re-apply every export (imports are idempotent)
#
# Safe to run while the daemon is running (SQLite WAL + busy timeout) and from cron/launchd.
# The state is read with `git archive`, never `git checkout`, so the current branch and index
# are untouched (see deploy/cloud-patrol.md). Progress is remembered in data/.last-cloud-import.
set -euo pipefail

TC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$TC_DIR"
STATE_BRANCH="${TC_STATE_BRANCH:-taskcenter-state}"
ALL=0
[ "${1:-}" = "--all" ] && ALL=1

if ! git fetch -q origin "$STATE_BRANCH"; then
  echo "import-cloud-state: cannot fetch origin/$STATE_BRANCH (no network or branch missing); nothing imported" >&2
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# `git archive <ref> <path>` resolves <path> against the current directory, so run it from the repo root.
REPO_ROOT="$(git rev-parse --show-toplevel)"
if ! git -C "$REPO_ROOT" archive "origin/$STATE_BRANCH" state 2>/dev/null | tar -x -C "$tmp" 2>/dev/null; then
  echo "import-cloud-state: origin/$STATE_BRANCH has no state/ directory yet; nothing imported" >&2
  exit 0
fi

mkdir -p data
last_done="$(cat data/.last-cloud-import 2>/dev/null || true)"
applied=0
for dir in "$tmp"/state/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  # Export folders are named by UTC timestamp, so plain string order == chronological order.
  if [ "$ALL" = 0 ] && [ -n "$last_done" ] && [ ! "$name" \> "$last_done" ]; then
    continue
  fi
  echo "import-cloud-state: importing $name"
  node --no-warnings=ExperimentalWarning bin/tc.mjs state import "$dir"
  echo "$name" > data/.last-cloud-import
  applied=$((applied + 1))
done

if [ "$applied" = 0 ]; then
  echo "import-cloud-state: up to date (last import: ${last_done:-none})"
else
  echo "import-cloud-state: applied $applied export(s); tasks that were running in the cloud are re-queued by the daemon's recovery"
fi
