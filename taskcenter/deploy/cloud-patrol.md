# Cloud heartbeat: patrol from a Claude Code scheduled task

> **Current setup (2026-11-07).** The heartbeat runs in one **persistent cloud session**
> ("Task Center heartbeat") that has this repository attached, so `gh api` and `git push`
> work. A scheduled task wakes that session at 07:37, 12:37 and 19:37 (Asia/Shanghai); each
> wake runs `deploy/cloud-heartbeat.sh` (import state → patrol → triage → plan → run up to 2
> ready tasks → export → push to `taskcenter-state`) and sends a push notification when
> something needs a decision. You answer by replying in that session (for example
> `approve apr_xxx` or `不要做 tsk_xxx`); the session runs the matching `tc` command.
> The first design below (fresh session per run) failed in practice: a fresh scheduled
> session has no repository attached, so GitHub returned 403 and nothing was saved.

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

Lessons from the first live run (2026-11-06): a scheduled session starts **without the
repository attached**, so the prompt must first call the `add_repo` tool with
`access: "push"` (otherwise `git push` to `taskcenter-state` returns 403), and the state
must be read with `git archive` (a `git --work-tree=... checkout` stages the state files
into the source branch index). The prompt below already includes both. The live trigger
`trig_012Q1QZvHoE7FJkwThg4EKcc` (07:37 and 19:37 Asia/Shanghai) uses this text.

```
You are the cloud heartbeat of the Agentic Inbox Task Center. Work only inside the
`taskcenter/` directory of this repository and do not start the daemon.

1. cd taskcenter && npm ci --omit=dev 2>/dev/null || npm install --omit=dev
2. If config/taskcenter.yaml is missing, copy config/taskcenter.example.yaml to it.
   Set TC_ROOT=$PWD. Run `node bin/tc.mjs doctor --json` and continue even if
   non-critical checks warn (gh login, .env, daemon not running are expected here).
3. Pull the latest state so cursors and inbox are current:
     git fetch origin taskcenter-state
     rm -rf /tmp/tcstate && mkdir -p /tmp/tcstate && git archive origin/taskcenter-state state | tar -x -C /tmp/tcstate
     latest=$(ls -d /tmp/tcstate/state/*/ 2>/dev/null | sort | tail -1); if [ -n "$latest" ]; then node bin/tc.mjs state import "$latest"; fi
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

The local daemon merges exports with `tc state import <dir>`. `deploy/import-cloud-state.sh`
does that for every export newer than the last one applied (remembered in
`data/.last-cloud-import`); `--all` re-applies everything. It reads the branch with
`git archive` from the repository root, so the current branch and index are never touched.

```bash
deploy/import-cloud-state.sh          # run after `bootstrap-mac.sh setup`, from cron, or before starting the daemon
deploy/import-cloud-state.sh --all    # idempotent re-import
```

Because imports are keyed and idempotent, it is safe to run the daemon and the
import at the same time (SQLite WAL + busy timeout). Tasks created in the cloud
arrive as `todo`/`ready` and are planned/executed locally; a task that was still
`running` in the cloud when the export was taken is re-queued by the daemon's
recovery on the next start (cancel or mark it done first if the work was already
delivered, e.g. `tc tasks done <id>`). Approvals requested in the cloud arrive as
pending Outbox items.

## 4. What to expect

- Cloud runs cost only the triage call (haiku, ≤ 20 signals per batch) and the
  optional digest; the daily budget table is merged by `max`, so the local counter
  never under-counts.
- Signals are deduplicated by `(source, external_id)`; a signal seen first in the
  cloud and later locally merges into one row.
- If the cloud session cannot push (branch protection, token scope), it must not
  retry forever: the next scheduled run re-exports everything that is still there.
