# CLI (`tc`)

Entry: `bin/tc.mjs` → `src/cli.ts` (parser in `src/cli/args.ts`, tables in
`src/cli/format.ts`, zh-CN/en strings in `src/cli/i18n.ts`, checks in `src/cli/doctor.ts`).
No argument-parsing dependency. `TC_ROOT` is set to the package root automatically, so
`tc` works from any directory.

Global flags: `--config <path>` (else `TC_CONFIG`, `config/taskcenter.yaml`, example),
`--json` (machine output on stdout; human text otherwise), `--dry` (LLM provider and
runner replaced by dry stubs; sensors and channels stay real), `--help`, `--version`.
Headers and short messages follow `config.locale` (`zh-CN` default, `en`).
`TC_LOG_LEVEL` controls the stderr log (one-shot commands default to `warn`,
`daemon` to `info`).

| Command | What it does |
|---|---|
| `daemon [--no-serve]` | Full daemon: recovery, inbound channels, executor, scheduler, API + dashboard, initial patrol after 5 s. Single instance per data dir. |
| `serve` | API + dashboard only (no loops). |
| `status` | Daemon/lock state, executor, budget, inbox/task/approval counts, last patrol, sensors, channels, schedule table. |
| `doctor [--probe]` | Node version, config/policy/profile, `.env` mode, data dir + DB, daemon lock, Claude CLI (`claude --version`; `--probe` makes one haiku call), git, gh auth, channels, sensors, module imports, runner availability. Exit 1 on any `fail`. |
| `init` | Copies `config/taskcenter.example.yaml` → `config/taskcenter.yaml`, `profile.example.yaml` → `profile.yaml`, `.env.example` → `.env` (0600) when missing; creates `data/`. |
| `patrol [--once] [--sensor a,b]` | One patrol. Without `--once` it also runs triage afterwards. Exit 2 if a sensor failed. |
| `triage` | Classify untriaged signals. |
| `plan [taskId]` | Plan pending L3+ `todo` tasks (or one task; re-plans from ready/blocked/failed). |
| `run <taskId>` | Run the task now (bypasses the queue) and stream its events to stderr; prints the final state. |
| `capture "<text>"` | Manual signal into the inbox (`source = manual`). |
| `inbox list [--status s,s] [--all]` / `show <id>` / `promote <id> [--level n --priority P1]` / `dismiss <id> [reason]` / `snooze <id> <1d\|3d\|7d\|2h\|ISO>` / `done <id>` | Inbox operations. |
| `tasks list [--status s,s] [--all]` / `show <id>` / `create "<title>" [--level n --category c --priority p --kind k --description "..."]` / `retry <id>` / `cancel <id> [reason]` / `done <id>` | Task operations (`show` includes plan, subtasks, runs, artifacts, approvals). |
| `approvals list [--status s] [--all]` / `show <id>` / `approve <id> [note]` / `reject <id> [note]` / `respond <id> "<text>"` | Outbox decisions (`approve` on a review = accept). Decisions made from the CLI are applied to the task immediately; a running daemon picks the task up on its next tick. |
| `events [--task id] [--run id] [--type t,t] [--level l] [--limit n] [--follow]` | Event log (chronological; `--follow` polls every second). |
| `digest [--send]` | Build (and send through the notifier) the daily digest. |
| `context refresh` | Consolidate learned memories into the generated profile. |
| `state export [dir] [--since days]` | JSONL per table + `manifest.json` into `data/exports/<timestamp>/` (or `dir`). |
| `state import <dir>` | Idempotent keyed upsert from an export. |
| `demo` | Seed demo data (`server/seed.ts`, or the engine fallback). |

Exit codes: 0 ok · 1 error / failed doctor · 2 partial failure (sensor error, failed run, triage errors).

Examples:

```bash
tc init && tc doctor --probe
tc daemon                                   # or: see deploy/README.md
tc capture "Reply to Alice about the Q4 plan"
tc inbox list; tc inbox promote inb_… --level 3
tc approvals list; tc approvals approve apr_… "ship it"
tc events --follow --task tsk_…
tc state export && tc state import data/exports/2026-11-06T08-00-00-000Z
tc tasks list --status review,waiting_human --json | jq '.[].id'
```
