# Engine (`src/engine/`)

The engine is the daemon's brain stem: it turns the core data model into a running
system. Everything in `src/engine/` depends only on `src/core`, `src/config` and the
interface files (`src/{sensors,runners,brain,hitl}/types.ts`). The concrete sibling
modules are bound in exactly one file, `wiring.ts`.

```
createApp()  ──►  wireServices()  ──►  ctx.services.{patrol,triage,planner,inbox,capture,executor,digest,contextRefresh,approvals,notifier,llm}
startDaemon() ──► recovery → notifier.start(inbound) → executor.start() → scheduler.start() → HTTP server → initial patrol
```

| File | Role |
|---|---|
| `app.ts` | `createApp({configPath, cwd, logger, overrides, dry, isolated, dbPath, sensors, logLevel})` → `AppContext` (config, data dir, logger file `data/logs/taskcenter.jsonl`, DB, repo, bus, policy, budget) + wiring + schedule registration. `shutdown()` stops scheduler/executor/notifier and closes the DB. |
| `wiring.ts` | `wireServices(ctx, {overrides, dry, isolated, sensors})`: lazy `import()` of every sibling module with per-module fallback; publishes `ctx.services`; `getWired(ctx)` returns the engine-typed services (executor with `start/stop`, scheduler, `createServer`, `createInboundHandler`, `seedDemo`, module states). `probeModules()` feeds `tc doctor`. |
| `patrol.ts` | `createPatrol(ctx, sensors, {makeSensorContext, timeoutMs=120s, parallelism=3})` → `runOnce(names?)`. Per sensor: build context, poll with timeout, upsert signals in one transaction, `sensor_poll` event, emit `signal.new`, reset/increment `meta.sensor_failures:<name>`; failures are isolated (`error` event, report entry `ok:false`). Wakes `patrol` when untriaged signals exist. |
| `triage.ts` | `createTriage(ctx, {llm, triageSignals, loadContext, availableCapabilities, recordLearned, inbox})` → `runOnce()`. Batch = `patrol.triage_batch_size` untriaged signals. Dismiss → signals triaged, `triage` event. Otherwise create an inbox item (`triaged`) or **merge** into the open item already linked to one of the signals (union of signal ids, summary/level/priority refreshed, priority = most urgent). Learned facts → `recordLearned`. Auto-promote via `policy.decideLevel(...).autoPromote`. Skipped (warn event) when the daily budget is exhausted; classifier cost → `budget.addCost`. Signals the classifier skips twice are parked. |
| `inbox.ts` | `promote(id, overrides)` → Task (`ready` for L≤2, `todo` for L≥3; context carries `inbox_item_id`, `level_reason`, `suggested_action`, signal excerpts ≤1500 chars; acceptance criteria from the suggested action; per-run budget and max attempts from config). `dismiss/snooze/done`, `capture(text, by)` (manual signal `manual:<sha1(by+text)>`, wakes `capture`). |
| `plan.ts` | `createPlanner(ctx, {llm, planTask, loadContext})` → `planTask(id)`, `planPending()`. `todo` tasks: L≤2 → `ready` directly; L≥3 → `planning` → plan stored, subtasks created (`parent_id`, `depends_on` mapped from indexes, `blocked` when they have deps, level clamped to the parent's). Parent with subtasks → `blocked` with `depends_on = subtask ids` and `context.phase = "integrate"`; the core state machine moves it to `ready` when the last child is `done`, and the executor hands the next run `context.children` + `integration_note`. Planner failures retry after 5·n minutes (`context.plan_retry_at`); after 3 failures the task runs without a plan. |
| `executor.ts` | Worker pool (`executor.concurrency`). See below. |
| `recovery.ts` | `runRecovery(ctx)`: queued/running runs → `interrupted`; their tasks → `ready` (attempts unchanged) or `failed` when `attempts ≥ max_attempts`; `planning` → `todo`; expire due approvals; remove a stale lock. |
| `scheduler.ts` | croner jobs (`protect`, `catch`, timezone from config): `patrol` (config cron), `triage` (`*/5` catch-up), `plan` (every minute), `executor_tick` (every 30 s: `retryDue` + wake), `follow_ups` (every 5 min: due follow-ups/retries → ready, snoozed inbox → new, expired approvals → waiting tasks `blocked`), `digest` (config cron, enabled flag from config), `context_refresh`, `maintenance`. Bus wake reasons `patrol`/`capture` trigger triage, `triage`/`promote` trigger planning. `repo.schedules` rows get `last_run_at/last_status/last_error/next_run_at`; a row with `enabled=0` is skipped. |
| `maintenance.ts` | WAL checkpoint + VACUUM, prune events older than 90 days except `status_change`/`approval_*`, remove workspaces of tasks finished > 7 days ago (git worktrees via `git worktree remove`). |
| `digest.ts` | `createDigestService` (`build()`, `send()` → `notifier.notify({kind:"digest"})`) and `createContextRefresh`. |
| `state-export.ts` | `exportState(ctx, dir?, {sinceDays})` → JSONL per table + `manifest.json` (lines pass through the secret redactor). `importState(ctx, dir)` → keyed upserts: newest `updated_at` wins, append-only tables insert-or-ignore, budgets merge by `max`, signals also merge on `(source, external_id)`. Idempotent. |
| `lock.ts` | `data/taskcenter.lock` (`{pid, startedAt, host}`); stale (dead pid) locks are replaced; a live pid raises `LockHeldError`. Daemon only. |
| `daemon.ts` | `startDaemon(ctx, {serve, handleSignals, initialPatrolDelayMs})`; SIGINT/SIGTERM → graceful stop; `unhandledRejection` → log and continue; `uncaughtException` → log, stop, exit 1. |
| `status.ts` | `collectStatus(ctx)` snapshot shared by `tc status`, the Telegram `/status` command and the daemon. |
| `dry.ts`, `fallbacks.ts` | Dry/in-memory implementations of every pluggable contract (runner, LLM, approval service mirroring hitl's task-side behaviour, console notifier, context loader, classifier, planner, prompt builder, memory, digest, output parsing, workspace, tool gate). Used by tests, `--dry`, and whenever a sibling module cannot be imported. |
| `demo.ts` | Fallback demo seed (used by `tc demo` when `server/seed.ts` is absent). |

## Executor

`createExecutor(ctx, deps)` returns `wake/retryTask/cancelTask/runTaskNow/pause/resume/status/start/stop/retryDue/tick/drain`.

**Loop.** `start()` subscribes to bus `wake`, ticks every 30 s and coalesces wakes
(one fill pass at a time, re-run if a wake arrived meanwhile). A fill pass:
budget check → `retryDue()` → while `running < concurrency`: pick `repo.tasks.runnable()`
filtered to `owner = ai`, not already running, `follow_up_at` not in the future,
parent not cancelled/failed; sorted by priority then creation time. Before each
checkout the executor requires `budget.canSpend(running × brain.budget_usd_per_run)`
so in-flight runs are reserved against the daily cap.

**Checkout (atomic).** One transaction: re-read the task, verify `ready` + dependencies,
create the `Run` (`attempt = attempts + 1`; reason `resume_after_approval` when
`context.pending_resume` is set, else `retry` when `attempts > 0`, else `scheduled`/`manual`),
transition the task to `running`. The partial unique index "one active run per task" makes
a concurrent checkout (e.g. CLI `tc run` vs daemon) fail safely.

**Resume.** The approval service (hitl) moves a `waiting_human` task back to `ready`
and writes `task.context.pending_resume = { resume: {approvalId, kind, decision, note,
editedPayload, decidedAt} }`. At checkout the executor consumes the marker (moved to
`context.last_resume`), sets `run.resume_of` to the parked run, copies its `session_id`
and passes `resume` to `buildExecutionPrompt`; `RunInput.resumeSessionId/resumeMessage`
are set so the runner continues the agent session. Review `request_changes` works the
same way (plus `context.review_notes[]`).

**Run.** `prepareWorkspace` (worktree branch recorded in `context.branch`) →
`loadContext` → `buildExecutionPrompt` → model = `task.model ?? (level ≥ 5 || plan.notes includes "hard" ? models.heavy : models.execute)`
→ `policy.toolsForLevel(level)` → gate = `gateFactory({policy, level, task, run, workspace, approvals, bus, waitMs, expiresHours, signal, logger})`
→ `mcpServers = {taskcenter: server}` → `runner.run(input)`. Every `RunEvent` is persisted
(`assistant_message`, `tool_call`, `tool_result`, `cost`, `error`; payloads trimmed to 8 KB).
A per-run `AbortController` enforces `brain.timeout_seconds`.

**Completion** (single transaction, notifications/approval requests afterwards):

| Result | Task |
|---|---|
| `waiting_human`, or the gate reports `pendingApprovalId` | run `waiting_human`; task `waiting_human` (`context.waiting_approval_id`) |
| succeeded + `needs_human` | as above, plus a `question` approval (options from the agent) |
| succeeded + `blocked` | task `blocked`, `last_error = summary` |
| succeeded, L5 verified | `done` |
| succeeded, L5 unverified/partial, or L3–L4 | `review` + `review` approval (accept / request_changes / reject; artifacts listed) |
| succeeded, L1–L2 | `done` (`result_summary`) |
| failed, `attempts < max_attempts` | `blocked` with `follow_up_at = now + backoff_seconds[attempt-1]`; `retryDue()` moves it to `ready` |
| failed, attempts exhausted | `failed` |
| daemon stopping / cancelled | run `interrupted` / `cancelled`; task back to `ready` / `cancelled` |

Artifacts from the structured output become `artifacts` rows (files are copied to
`data/artifacts/<task>/<run>/`); changes left on a worktree branch without a reported
artifact become a `patch` artifact. `learned[]` → `recordLearned`. Costs go to the run,
the task and the daily budget: 80 % → one `budget_warning` per day, 100 % → the
executor pauses itself (auto-resumes on the next day). When a child task finishes and
all siblings are done, a `blocked` parent becomes `ready` with `context.phase = "integrate"`.

Notifications for `task_done` / `task_failed` / `review_ready` are sent by the hitl
`Notifier` (it listens on `task.changed`); the executor only sends them itself when
the fallback console notifier is in use (`notifyTaskEvents`). `budget_warning` and
`digest` are always the engine's.

**Stop.** `stop()` stops taking tasks, waits up to 30 s, aborts the rest.

## Testing

`tests/engine-*.test.ts` build an isolated context (`tests/engine-helpers.ts`:
`createApp({isolated: true, dbPath: ":memory:", sensors})`) so only fallbacks and dry
stubs are used. The dry runner is scripted through `task.context.dry`
(`{status|fail, agentStatus|status, verified, cost, delayMs, tool, toolInput|needsApproval, summary, artifacts, learned, question, options}`;
the `runners/dry.ts` vocabulary is accepted too).

## Notes for integrators

- `createApp` accepts extra optional fields (`dry`, `isolated`, `dbPath`, `sensors`, `logLevel`, `logToStderr`) on top of the contract; `startDaemon` accepts `handleSignals` and `initialPatrolDelayMs`.
- Small additive core changes: `Budget.addCost(usd)` (non-run cost), and a bug fix in `core/logger.ts` `redact()` (single-group secret patterns were appended with `***` instead of being replaced).
- The dashboard/API process is the daemon; `tc` one-shot commands open the same SQLite file (WAL) and can decide approvals while the daemon runs. The daemon picks up resulting `ready` tasks on its next tick (≤ 30 s).
