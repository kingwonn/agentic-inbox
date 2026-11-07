# server — HTTP API + dashboard host (`src/server/`)

Owner: agent D. Contract: `server/app.ts: createServer(ctx: AppContext): { app: Hono; start(): Promise<{host, port}>; stop(): Promise<void> }` (unchanged from `docs/CONTRACTS.md`).

## Files

| File | Purpose |
|---|---|
| `app.ts` | `createServer(ctx, opts?)`: Hono app, middleware, route mounting, static dashboard, lifecycle. `opts.heartbeatMs` (SSE heartbeat, default 20 s) and `opts.distDir` exist for tests. |
| `util.ts` | `HttpError` (+ `notFound/badRequest/unavailable`), query helpers (`intParam`, `strParam`, `listParam`, `oneOf`), `pageOf`, `parseBody(c, zodSchema)`, `countsByStatus(repo, table)`, `LevelSchema`. |
| `seed.ts` | `seedDemo(repo, bus)` demo data; `createMemoryContext(opts)` builds an `AppContext` on `openDb(":memory:")` with stub services; `createStubServices({repo, bus, calls})`; `taskcenterRoot()`. Used by tests, `scripts/screenshot-dashboard.ts`, and reusable for `tc demo`. |
| `routes/status.ts` | `/status`, `/budget`, `/schedules`, `/notifications` + `configSummary(config)` (no secrets). |
| `routes/inbox.ts` | `/inbox` list/detail, `promote`, `dismiss`, `snooze`, `done`. |
| `routes/tasks.ts` | `/tasks` list/create/detail/patch, `retry|cancel|run|plan`, `/tasks/:id/events` (GET + POST note). |
| `routes/runs.ts` | `/runs`, `/runs/:id` (run + chronological events + approvals + artifacts). |
| `routes/approvals.ts` | `/approvals`, `/approvals/:id`, `decide`. |
| `routes/events.ts` | `/events` (filters) and `/events/stream` (SSE); exports the open-stream registry so `stop()` can close them. |
| `routes/artifacts.ts` | `/artifacts`, `/artifacts/:id` (+ `?download=1`), `isInside()` traversal guard. |
| `routes/signals.ts` | `/signals`, `/signals/:id`, `POST /capture`. |
| `routes/memories.ts` | `/memories` (GET/POST/DELETE), `/context` (profile YAML + active memories), `readProfile(ctx)`. |
| `routes/ops.ts` | `POST /sensors/poll`, `POST /triage/run`, `POST /executor/pause|resume|wake`, `GET /executor`. |

## Middleware (in order)

1. **Errors → JSON**: `HttpError` → its status; zod issues → `400 {error:"invalid body", details:[...]}`; `InvalidTransition` → 409; anything else → 500 (logged at error). API 404s are JSON `{error:"not found"}`.
2. **Request log** via `ctx.logger.child("http")`: debug for 2xx/3xx, warn for 4xx, error for 5xx (API paths only).
3. **CORS** on `/api/*` for `localhost` / `127.0.0.1` / `[::1]` origins on any port (Vite dev server), credentials allowed.
4. **Auth**: when `config.server.token` is set, every non-GET/HEAD/OPTIONS request and `GET /api/events/stream` require `Authorization: Bearer <token>` or `?token=`; constant-time compare; 401 carries `WWW-Authenticate`. GET endpoints stay open (the server binds to `127.0.0.1` by default). With no token everything is open.
5. **API** under `/api`.
6. **Static**: `GET /*` serves `<rootDir>/web/dist` (assets under `/assets/` immutable-cached, `index.html` `no-cache`), SPA fallback to `index.html` for extension-less paths, 404 for missing asset-like paths, path-traversal guarded. If `web/dist/index.html` is missing, an inline zh-CN page explains `npm run build:web`.

`start()` binds `config.server.host:port` (`port: 0` picks a free port and is reported back). `stop()` closes all SSE streams, then the listener (`closeAllConnections` for idle keep-alives).

## Routes

All JSON. Lists return `{items, limit, offset, more}` (`more` = page full). Services that are `undefined` on `ctx.services` yield `503 {error:"service unavailable"}`.

| Method & path | Notes |
|---|---|
| `GET /api/status` | `{startedAt, now, version, config (summary), counts{inbox,tasks,runs,approvals (by status), signals, untriaged, failures24h}, budget, executor, schedules, sensors (per-sensor cursor summary), cursors, dataDir, services}` |
| `GET /api/budget` | `{status: Budget.status(), history: budgets.recent(30)}` |
| `GET /api/schedules` · `GET /api/notifications?limit=` | |
| `GET /api/inbox?status=a,b&limit=&offset=` · `GET /api/inbox/:id` | detail = `{item, signals, task}` |
| `POST /api/inbox/:id/promote {overrides?:{title,description,level,priority,category,status:"todo"\|"ready"}}` | → `services.inbox.promote` |
| `POST /api/inbox/:id/dismiss {reason?}` · `/snooze {until}` · `/done` | |
| `GET /api/tasks?status=&parent_id=(null)&limit=&offset=` | |
| `POST /api/tasks {title, description?, kind?, level?, category?, priority?, parent_id?, depends_on?, status?, deadline?, labels?, acceptance_criteria?, owner?, budget_usd?}` | repo create + `system` event (`by:"human"`) + `task.changed`; `status:"ready"` wakes the executor. 201. |
| `GET /api/tasks/:id` | `{task, parent, children, dependencies, runs, approvals, artifacts, events (last 50, newest first), inbox_item}` |
| `PATCH /api/tasks/:id {title?, description?, level?, priority?, category?, status?, follow_up_at?, deadline?, owner?, labels?, reason?}` | field edits are logged as a `system` event; `status` goes through `transitionTask(..., {force:true})` (human intervention). |
| `POST /api/tasks/:id/retry` · `/cancel {reason?}` · `/run` | `services.executor.retryTask / cancelTask / runTaskNow` |
| `POST /api/tasks/:id/plan` | `services.planner.planTask` |
| `POST /api/tasks/:id/events {message}` | **beyond the brief**: human note → `system` event with `payload {by:"human", source:"dashboard", note:true}`. 201. |
| `GET /api/tasks/:id/events?type=&run_id=&limit=&after_id=` | **beyond the brief**: full event list for a task (detail only carries the last 50). |
| `GET /api/runs?status=&task_id=&limit=` · `GET /api/runs/:id` | list rows carry `task_title`; detail = `{run, task, events (chronological), approvals, artifacts}` |
| `GET /api/approvals?status=&task_id=` · `GET /api/approvals/:id` | list rows carry `task_title` |
| `POST /api/approvals/:id/decide {decision, note?, editedPayload?}` | `decision` ∈ approve/edit/reject/respond or any `options[].value`; `edit` requires `editedPayload`; non-pending → 409; calls `services.approvals.decide({..., decidedBy:"dashboard"})`. Custom option values are passed through typed as `Decision` (the `InboundDecision.decision` type is narrower than what the HITL contract accepts in practice). |
| `GET /api/events?task_id=&run_id=&type=a,b&level=&since=&limit=&after_id=&offset=` | newest first |
| `GET /api/events/stream` | SSE. `hello` (with `heartbeatMs`), `event` (every persisted event, `id` = event id), `heartbeat` every 20 s, and named bus events `task.changed`, `run.changed`, `approval.requested`, `approval.decided`, `inbox.changed`, `signal.new`. |
| `GET /api/artifacts?limit=&task_id=` · `GET /api/artifacts/:id` | detail = `{artifact, task, downloadable}` |
| `GET /api/artifacts/:id?download=1` | inline `content` when there is no `path`; otherwise streams the file. Relative paths resolve against `dataDir`; the real path must be inside `dataDir` or `executor.workspace_root` (symlinks resolved) → else 403. Missing file with inline content falls back to the content; otherwise 404. |
| `GET /api/signals?source=&q=&limit=` · `GET /api/signals/:id` | `q` uses the FTS index |
| `POST /api/capture {text, title?, url?}` | `services.capture(text, "dashboard", {title,url})`. 201. |
| `GET /api/memories?kind=&all=1` · `POST /api/memories {kind, content, tags?, confidence?}` · `DELETE /api/memories/:id` | POST uses `upsertByContent` (201 new / 200 existing); DELETE retires. |
| `GET /api/context` | `{profilePath, profileExists, profileText, profile, memories, locale, timezone}` from `config.profile_path` + active memories. |
| `POST /api/sensors/poll {sensors?}` · `POST /api/triage/run` | `services.patrol.runOnce` / `services.triage.runOnce` |
| `POST /api/executor/pause {reason?}` · `/resume` · `/wake` · `GET /api/executor` | pause/resume are also logged as `system` events. |

## Tests

`tests/server.test.ts` (18 tests) builds the context with `createMemoryContext()` + `seedDemo()` and uses `app.request()`: status/config summary without secrets, inbox list/detail/promote/dismiss/snooze/done (stub call args verified), approvals decide (dashboard, 409 on re-decide, custom values, edit needs payload), task create/patch-force/notes, executor + planner actions, ops routes, 503 without services, SSE (headers, hello, forwarded event, named event, heartbeat), bearer auth for writes and the stream, artifact download guard (inline, inside dataDir, relative path, traversal → 403, `/etc/passwd` → 403, missing → 404), static fallback page / SPA fallback / asset caching / traversal, and `start()`/`stop()` on a free port.

## Notes for integrators

- `createMemoryContext({ rootDir, config, services, stubServices })` is the quickest way to get an `AppContext` without the engine; pass real services via `services` to override the stubs.
- Events written in the same millisecond share `ts`; `EventRepo.list` tiebreaks on the random-tailed id, so bursts can come back out of order. The dashboard re-sorts by `(ts, payload.seq)`; runners that emit bursts should include a monotonic `seq` in `payload` (the seed does). A `rowid` tiebreak in `EventRepo.list` would be the proper core fix.
- Demo: `node --import tsx scripts/screenshot-dashboard.ts --keep` starts a seeded server on a free port for manual poking.
