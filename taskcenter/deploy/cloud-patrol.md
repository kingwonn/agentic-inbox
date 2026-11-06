# Cloud heartbeat: patrol from a Claude Code scheduled task

Goal: while the laptop is closed, a cloud Claude Code session polls the sensors,
triages what it finds, and ships the resulting state to git so the local daemon can
merge it later. Nothing is executed in the cloud (no runner); only sensing, triage
and the daily digest.

## 1. One-time setup

1. Create an orphan branch that only ever holds exports:
   ```bash
   git checkout --orphan taskcenter-state
   git rm -rf . && mkdir -p state && echo "# task center state" > state/README.md
   git add state && git commit -m "init taskcenter-state" && git push -u origin taskcenter-state
   git checkout main
   ```
2. In the cloud environment, make sure the session can reach GitHub (the repo is
   attached) and, if the IMAP/ICS sensors are enabled, their hosts. Put the sensor
   secrets in the environment (`GITHUB_TOKEN`, `IMAP_USER`, `IMAP_PASSWORD`,
   `CALENDAR_ICS_URL`, `TELEGRAM_*`), never in the repo.
3. Create the scheduled task (Claude Code → scheduled tasks, "new session each
   run", cron e.g. `*/30 * * * *` or hourly). Use the prompt below verbatim.

## 2. Scheduled-task prompt (copy exactly)

```
You are the cloud heartbeat of the Agentic Inbox Task Center. Work only inside the
`taskcenter/` directory of this repository and do not start the daemon.

1. cd taskcenter && npm ci --omit=dev 2>/dev/null || npm install --omit=dev
2. If config/taskcenter.yaml is missing, copy config/taskcenter.example.yaml to it.
   Set TC_ROOT=$PWD. Run `node bin/tc.mjs doctor --json` and continue even if
   non-critical checks warn (gh login, .env, daemon not running are expected here).
3. Pull the latest state so cursors and inbox are current:
     git fetch origin taskcenter-state
     git --work-tree=/tmp/tcstate checkout origin/taskcenter-state -- state 2>/dev/null || true
     ls /tmp/tcstate/state/*/manifest.json 2>/dev/null | sort | tail -1 | xargs -r -I{} sh -c 'node bin/tc.mjs state import "$(dirname {})"'
4. Run the heartbeat, in this order, and stop at the first hard failure:
     node bin/tc.mjs patrol --once --json
     node bin/tc.mjs triage --json
     node bin/tc.mjs digest --send --json     # only if the current UTC hour matches notifications.digest.cron, otherwise skip
     node bin/tc.mjs state export --since 2 --json
5. Publish the export:
     EXPORT=$(ls -d data/exports/*/ | sort | tail -1)
     git fetch origin taskcenter-state
     git worktree add /tmp/tcpub origin/taskcenter-state
     mkdir -p /tmp/tcpub/state && cp -r "$EXPORT" /tmp/tcpub/state/
     (cd /tmp/tcpub && git add state && git -c user.name=tc-heartbeat -c user.email=tc@localhost commit -m "heartbeat: $(basename "$EXPORT")" && git push origin HEAD:taskcenter-state)
     git worktree remove --force /tmp/tcpub
   Keep at most the 48 newest export folders in state/ (delete older ones in the same commit).
6. Reply with one line: new signals, inbox items created, tasks created, cost, and
   the export folder name. Do not edit any source file, do not open pull requests,
   do not run `tc daemon`, `tc run` or `tc plan`.
```

Why `--since 2`: the cloud only needs to ship recent append-only rows (events,
notifications, artifacts); the stateful tables (signals, inbox, tasks, cursors…)
are always exported in full and merged by primary/unique key with "newest
`updated_at` wins", so repeated imports are idempotent.

## 3. Local side: importing the cloud state

The local daemon merges exports with `tc state import <dir>`. Automate it with a
small script run before/after the daemon starts, or from cron every 15 minutes:

```bash
#!/usr/bin/env bash
# deploy/import-cloud-state.sh — merge the newest cloud export into the local DB
set -euo pipefail
cd "$(dirname "$0")/.."
git fetch -q origin taskcenter-state
tmp=$(mktemp -d)
git --work-tree="$tmp" checkout -q origin/taskcenter-state -- state
latest=$(ls -d "$tmp"/state/*/ | sort | tail -1)
last_done=$(cat data/.last-cloud-import 2>/dev/null || true)
if [ "$latest" != "" ] && [ "$(basename "$latest")" != "$last_done" ]; then
  node bin/tc.mjs state import "$latest"
  basename "$latest" > data/.last-cloud-import
fi
rm -rf "$tmp"
```

Because imports are keyed and idempotent, it is safe to run the daemon and the
import at the same time (SQLite WAL + busy timeout). Tasks created in the cloud
arrive as `todo`/`ready` and are planned/executed locally; approvals requested in
the cloud (none, since nothing runs there) would arrive as pending Outbox items.

## 4. What to expect

- Cloud runs cost only the triage call (haiku, ≤ 20 signals per batch) and the
  optional digest; the daily budget table is merged by `max`, so the local counter
  never under-counts.
- Signals are deduplicated by `(source, external_id)`; a signal seen first in the
  cloud and later locally merges into one row.
- If the cloud session cannot push (branch protection, token scope), it must not
  retry forever: the next scheduled run re-exports everything that is still there.
