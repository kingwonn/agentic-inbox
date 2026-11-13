# Open-source landscape: agent task centers, managed agents, HITL inboxes

Research date: 2026-11-05. Sources: each project's GitHub README, in-repo docs and SQL migrations (github.com / raw.githubusercontent.com). Star counts are approximate GitHub captures on that date. Hosted doc sites (docs.openclaw.ai, docs.langchain.com, multica.ai) were unreachable from this session, so everything comes from the repos. **[uncertain]** marks claims not confirmed from a primary source.

Purpose: reusable designs for a local-first personal task center (signals → Inbox → L1–L5 classification → Claude Code / Agent SDK runs with subtasks and dependencies → Outbox approvals → dashboard).

---

## 1. Multica (multica-ai/multica)

- **Repo:** https://github.com/multica-ai/multica — ~55k stars, ~7.2k forks.
- **License:** "Multica License" = Apache 2.0 text **plus** conditions on hosted services, commercial embedding and branding (some blogs call it Apache 2.0; LICENSE is authoritative).
- **Stack:** Go backend (Chi, sqlc, gorilla/websocket), PostgreSQL 17, Next.js 16 web, Electron desktop, Expo mobile, local Go daemon that spawns agent CLIs (~26 supported: Claude Code, Codex, Cursor, Copilot CLI, OpenCode, Kimi, Qwen, Kiro, …). "Multica drives them; it doesn't ship them."

### Data model (from `server/migrations/`)
| Entity | Key fields / states |
|---|---|
| `member` | `role`: `owner` / `admin` / `member` |
| `agent` | `status`: `idle` / `working` / `blocked` / `error` / `offline`; `max_concurrent_tasks` (default 1); `visibility`; `runtime_id`; `runtime_config` JSONB |
| `agent_runtime` | one machine + one CLI; `status`: `online`/`offline`; `last_seen_at`; `provider`; `daemon_id` |
| `issue` | `status`: `backlog` / `todo` / `in_progress` / `in_review` / `done` / `blocked` / `cancelled`; `priority`: `urgent`/`high`/`medium`/`low`/`none`; polymorphic `assignee_type` (`member`/`agent`) + `assignee_id` (no FK); `parent_issue_id`; `acceptance_criteria` JSONB; `context_refs` JSONB; `due_date`; subscribers |
| `issue_dependency` | `type`: `blocks` / `blocked_by` / `related` |
| `agent_task_queue` (= a *run*) | `status`: `queued` / `dispatched` / `running` / `completed` / `failed` / `cancelled`; `priority`; `result` JSONB; `error`; `session_id` + `work_dir` (reused for `--resume` across runs on the same agent+issue); `runtime_id`; trigger comment; usage |
| `task_message` | append-only stream: `task_id`, `seq`, `type`, `tool`, `content`, `input` JSONB, `output`; index `(task_id, seq)` |
| `comment` | `type`: `comment` / `status_change` / `progress_update` / `system`; threaded; reactions |
| `inbox_item` | `recipient_type` (`member`/`agent`), `type` (free text), `severity`: `action_required` / `attention` / `info`, `issue_id`, `title`, `body`, `read`, `archived`, `actor_type`/`actor_id`, `details` JSONB |
| `skill` / `skill_file` / `agent_skill` | workspace-scoped skill body + files, many-to-many to agents; no versions or sources |
| `activity_log` | `actor_type`: `member`/`agent`/`system`; free-text `action`; `details` JSONB |

Lifecycle guard: partial unique index `idx_one_pending_task_per_issue ON agent_task_queue(issue_id) WHERE status IN ('queued','dispatched')` — commented "coalescing queue safety net".

### Launch and supervision (`CLI_AND_DAEMON.md`, `daemon-runtimes.mdx`)
- Daemon logs in with a 90-day PAT, detects CLIs on PATH, registers one runtime per (machine, CLI) per workspace.
- **Wake = push + poll:** WebSocket wake signal → daemon claims across all runtimes in one batch; 30s poll is the catch-up path. Liveness heartbeat every 15s; runtime offline after ~3 min; in-progress runs fail with `runtime_offline` only after a reconnect grace (default 3h); queued runs wait rather than migrate; daemon restart reclaims runs that did not end cleanly.
- **Concurrency:** 20 runs/daemon (`MULTICA_DAEMON_MAX_CONCURRENT_TASKS`), 6/agent; effective = min.
- **Isolation:** per-run dir under `~/multica_workspaces`, bare-repo cache + `git worktree` per task, private `TMPDIR`, brief written to the runtime's instruction file (`AGENTS.md`, `QWEN.md`…), bound skills materialised into the run dir. `--permission-mode` is "protocol-critical" and stripped from custom profiles.
- **Watchdogs:** `MULTICA_AGENT_TIMEOUT` (default 0), idle watchdog 2h, tool watchdog.
- **Streaming/steering:** `task_message` rows stream live; CLI `run-messages --since n`; `--steer <run-id>` injects into a running turn (Claude Code, Codex, Grok, Kiro), max 3 per run; an agent cannot steer itself.
- **Retries:** auto-retry after `runtime_offline`; otherwise "stop and tell you why". Autopilots (cron or webhook + Runbook; "create issue" vs "run only" modes; `Idempotency-Key` + GitHub delivery-id dedupe) auto-pause at ≥50 runs / 7 days with ≥90% failure.

### HITL, notifications, persistence
- Coarse-grained: review gate (`in_review`; "work lands in review, not in main"), roles, per-member access scopes over agents; `inbox_item.severity = action_required` is the decision signal. No tool-level approval loop documented; headless runs bypass permissions (Qoder `--yolo` explicit; Claude/Codex flags **[uncertain]**).
- **Squads:** "the leader routes the work"; algorithm not public **[uncertain]**.
- Channels: Slack, Feishu/Lark, DingTalk, WeCom, Telegram. All state in Postgres; code and credentials stay on the daemon host.

### Ideas to steal
1. Issue vs Run split; "a finished run does not mean the issue is done".
2. One-pending-run-per-issue partial unique index as DB-level coalescing.
3. Push wake + poll catch-up + liveness heartbeat + reconnect grace before failing.
4. `task_message(seq, type, tool, input, output)` for live logs; `session_id` + `work_dir` on the run for resume.
5. Inbox severity triple `action_required / attention / info` + `details` JSONB.

---

## 2. OpenClaw (openclaw/openclaw)

- **Repo:** https://github.com/openclaw/openclaw — ~394k stars, ~83k forks. MIT. OpenClaw Foundation (501(c)(3)).
- **Stack:** TypeScript/Node 24.22+/26, pnpm, SQLite per agent, some Rust crates, plugin SDK + ClawHub. Model providers (Claude, Codex, local) are plugins; runtimes: embedded loop, Codex app-server, `claude-cli` backend, ACP for Claude Code/Gemini CLI/OpenCode/Cursor.
- **Positioning:** personal assistant reached through chat (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Teams, "20+ more") plus native nodes (voice, camera, screen).

### Architecture (`docs/concepts/architecture.md`, `agent-loop.md`, `queue.md`, `session.md`)
- **One Gateway per host** (:18789) = control plane for sessions, tools, events, channels. Typed WebSocket API (TypeBox): `connect` → `hello-ok`; `req`/`res`/`event`; side-effecting RPCs (`send`, `agent`) need **idempotency keys**; events are **not replayed** (refresh after a gap). Device identity + pairing tokens on every connection.
- **Agent loop:** `agent` RPC returns `{runId, acceptedAt}` immediately; streams `tool` / `assistant` / `lifecycle` (`start`, `finishing`, `end`, `error`); tool args validated before execution; durable `activeWriterRunId` write-fencing so a superseded run cannot commit.
- **Queue:** one turn per session; lanes `main` (`agents.defaults.maxConcurrent`, default 1), `cron`, `cron-nested`, `subagent:<session>` (default 8). Modes `steer` (inject into running turn, default) / `followup` / `collect` (debounce 500ms) / `interrupt`; `cap` 20; `drop: summarize|old|new`. Stuck-session diagnostics `session.long_running / stalled / stuck`. Timeouts: 48h per model attempt, idle 120s.
- **Sessions:** `session.dmScope` (`main`, `per-peer`, `per-channel-peer`…); groups isolated; cron jobs get a fresh session; reset `daily`/`idle`; store `~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite`.

### Proactive loop: heartbeat → automations
- **Historical:** `HEARTBEAT.md` checklist, 30-min heartbeat turn, `HEARTBEAT_OK` when idle. **Retired in 2026**: Doctor migrates it into **automations**.
- **Current:** `openclaw automations` (`cron` alias). Setup provisions one "Proactive check" job every 30 min for the owner agent. Each job owns schedule (`at` / interval / cron), **scratch** (short checklist), session target (main / current / isolated), model, delivery (`delivery.target: "owner"`, `directPolicy`), history, retries. Conventions: reply `NO_REPLY` when nothing needs attention; `record_result` with `no_change` suppresses delivery; `activeHours`, `idleOnly`, `payload.skipIfScratchEmpty`. Other triggers: webhooks, lifecycle hooks, IMAP reader sessions, MCP events.
- **Standing orders** (`docs/automation/standing-orders.md`): `AGENTS.md` sections granting "permanent operating authority": Authority/Scope, Triggers, **Approval gates**, **Escalation rules**, "What NOT to do". Execute → verify → report; max 3 attempts then escalate; gates relax over time; "start with narrow authority".
- **Standing intents** (`docs/concepts/standing-intents.md`): event-conditioned "prospective memory" rows in SQLite; states `pending → armed → fired → armed … → done | cancelled | expired`; defaults 24h cooldown, 3 max fires, 90-day expiry; FTS keyword prefilter, no model call; cancellation only on explicit request.
- **Decision models** (`decision-models.md`): separate `decisionModel` role returns typed Choice/Score/Boolean with probabilities; thresholds belong to the consumer (example: escalate at `probabilityTrue ≥ 0.9`); abstention (`null`) is never read as "no".
- **Memory:** Markdown `AGENTS.md`, `SOUL.md`, `USER.md` (4k cap), `MEMORY.md` (curated, main session only), `memory/YYYY-MM-DD.md`; bootstrap caps 20k/file, 60k total; SQLite hybrid search; silent "memory flush" turn before compaction; "dreaming" distils daily notes.

### HITL / security
- "Trusted gateway, untrusted execution, policy enforced by code"; inbound messages untrusted; DM pairing; loopback bind; `openclaw security audit`.
- **Three layers** (`sandbox-vs-tool-policy-vs-elevated.md`): sandbox (`agents.defaults.sandbox.mode: off|non-main|all`) → tool policy (`tools.allow/deny`, groups `group:runtime`, `group:fs`…; deny wins) → elevated (exec-only escape, sender allowlist).
- **Exec approvals** (`docs/tools/exec-approvals.md`): `tools.exec.mode: deny | allowlist | ask | auto | full`; `ask: off | on-miss | always`; `askFallback: deny|allowlist|full` when no UI is reachable or the prompt times out; allowlist = glob on binary + `argPattern` regex; "allow-always" grants bound to exact argv + cwd (+ env for automations), revocable, `grantExpiryDays`; `strictInlineEval` catches `python -c`, `node -e`…. Prompts go to Control UI, macOS/iOS/Android apps, API clients declaring `approvals`, and chat reactions (✅ once / ♾️ always / ❌ deny). **Automation runs: prompts never go to chat; with no approval client connected the request is denied immediately.**
- **Session permission modes** (`permission-modes.md`): `read-only` (no exec) → `guarded` ("Ask me": human after allowlist fast path) → `workspace` ("Auto-review": LLM reviewer allows/denies/asks; three consecutive denials escalate; denial returns a reason, no card) → `full` (admin only). Tightening mid-task cancels pending approvals; completed side effects are not rolled back.
- Multi-agent: per-agent workspace + `agentDir` + SQLite; channel→agent `bindings`; `tools.agentToAgent.allow`; team preset: coordinator is the human's contact, roles "require human approval before external sends, publication, purchases, deletion, or production changes".

### Ideas to steal
1. The read-only / guarded / LLM auto-review-with-escalation / full gradient as the L1–L5 skeleton.
2. Allow-always grants bound to exact args + cwd + scope with expiry.
3. Per-signal jobs with scratch, `activeHours`, `idleOnly`, `NO_REPLY`/`no_change`.
4. Standing orders doc (Authority / Triggers / Gates / Escalation / Never-do) and standing intents with fire budgets.
5. Typed decision models with consumer-owned thresholds; write-fencing and idempotent RPCs.

---

## 3. Paperclip (paperclipai/paperclip)

- **Repo:** https://github.com/paperclipai/paperclip — ~111k stars, ~18k forks. MIT (Paperclip Labs). Telemetry on by default.
- **Stack:** Node 24.11+/pnpm, React UI on :3100, embedded PostgreSQL (own in prod), optional Rust runner, OpenTelemetry/Sentry opt-in, out-of-process plugin workers.
- **Positioning:** "If OpenClaw is an employee, Paperclip is the company." Org chart of agents (CEO/CTO…) with goals, budgets, approvals. "If it can receive a heartbeat, it's hired."

### Data model (README, `docs/guides/*`)
- **Company** → **Agents** (role, title, reporting line, permissions, monthly budget; paused / terminated / errored cannot receive work) → **Goals** → **Projects** → **Issues**.
- **Issue:** `backlog → todo → in_progress → in_review → done`; `blocked ↔ todo/in_progress`; `cancelled`; priority `critical/high/medium/low`; parent chain to the company goal; blockers, labels, attachments, work products. `in_progress` requires **atomic checkout** (single assignee, execution locks; conflict → 409).
- **Run/heartbeat:** `queued / running / succeeded / failed / timed_out / cancelled`; wakeup reasons `timer`, `assignment`, `on_demand`, `automation` (+ `missing_issue_comment` backstop).
- **Approvals:** types `hire_agent`, CEO strategy; states `pending → approved | rejected | revision_requested → resubmitted → pending`; payload = requester, reason, linked issues, proposal.
- **Execution policy** (`execution-policy.md`): `mode: normal|auto`; ordered `stages[]` of `review` | `approval` (one approval each, `commentRequired: true`); `executionState.status: idle | pending | changes_requested | completed`; decisions in `issue_execution_decisions` (`outcome: approved | changes_requested`, actor, body, `createdByRunId`). Executor's `done` is rewritten to `in_review` and reassigned to the first reviewer; the executor is excluded (no self-review); only `currentParticipant` may act; `returnAssignee` on changes requested.
- **Budgets:** per company / agent monthly cents; **80% soft alert, 100% hard stop** (auto-pause); cost event per heartbeat (provider, model, tokens, cents); UTC-month reset; in-flight work can overshoot.
- **External task protocol (draft):** normalized states `backlog / active / review / blocked / terminal`; deterministic routing pipeline (comment command → field → label → state lane → user map → default → triage); 60s wake debounce; idempotency keys; mandatory reconciliation; poison events parked after 5 retries; external comments are untrusted input with provenance.

### Launch and supervision (`agents-runtime.md`, `docs/adapters/*`)
- Per heartbeat: DB-backed wakeup queue with **coalescing** → budget check → workspace resolution (optional worktree) → secret injection (references) → skill loading → `adapter.execute(ctx)`; status + usage + logs stored; UI live.
- Adapter package: `index.ts`, `execute.ts`, `parse.ts`, `test.ts`, `ui-parser.ts`, `format-event.ts`. Adapters: `claude_local`, `codex_local`, `gemini_local`, `kimi_local`, `opencode_local`, `cursor`, `pi_local`, `hermes_*`, `openclaw_gateway`, `process`, `http`, external `droid_local`. ACP engine emits JSONL `acpx.session / status / text_delta / tool_call / result / error`.
- `claude_local`: `cwd`, `model`, `promptTemplate` (`{{agentId}}`, `{{runId}}`…), `env`, `timeoutSec` (0 = none), `graceSec` before kill, `maxTurnsPerRun` 300, `dangerouslySkipPermissions` **default true**, `--add-dir` skills symlink dir; cwd-aware resume; unknown/poisoned session → one fresh-session retry; quota errors wait for reset or 1h backoff.
- Recovery: "bounded recovery" then escalate; no generic auto-retry. Comment backstop: no issue comment → woken once (`missing_issue_comment`) → `retry_exhausted`.
- Dashboard `GET /api/companies/{id}/dashboard`: agent counts by status, task counts, stale tasks, spend vs budget + burn, recent activity. Tool-gateway connection actions: `Allowed` / `Ask first` / `Off`. Notifications: experimental Slack/Discord/Telegram/AgentMail connectors; budget alerts (channel unspecified).

### Ideas to steal
1. Wakeup-reason enum + coalescing queue + atomic checkout.
2. Execution policy as ordered stages, no self-review, decision must carry a comment in the same write.
3. 80/100 budget thresholds with per-run cost events.
4. Adapter contract (`execute`/`parse`/`ui-parser`/`format-event`).
5. "No visible output" backstop: wake once, then flag.

---

## 4. LangChain Agent Inbox and HITL interrupt patterns

- **Repo:** https://github.com/langchain-ai/agent-inbox — ~1.1k stars, MIT, Next.js/TS. **Archived Sep 20, 2026.** Connects to LangGraph deployments (graph id + URL + LangSmith key in browser local storage); "Open in Studio".
- **Original schema** (`langgraph.prebuilt.interrupt`, now deprecated → `langchain.agents.interrupt`):
  - `HumanInterrupt { action_request: {action: str, args: dict}, config: {allow_accept, allow_edit, allow_respond, allow_ignore}, description?: markdown }`
  - `HumanResponse { type: "accept" | "edit" | "response" | "ignore", args: None | str | ActionRequest }`; always a one-element list: `response = interrupt([request])[0]`.
- **LangChain v1 `HumanInTheLoopMiddleware`** (`libs/langchain_v1/.../human_in_the_loop.py`):
  - `interrupt_on: {tool_name: True | False | InterruptOnConfig{allowed_decisions, description (str | callable), when: (ToolCallRequest) -> bool}}`; missing entry = auto-approve.
  - `DecisionType = "approve" | "edit" | "reject" | "respond"`; `EditDecision.edited_action{name,args}`; `RejectDecision.message?`; `RespondDecision.message` (becomes the tool result with `status="success"`; docs warn not to use it to deny side effects).
  - Batched payload `HITLRequest { action_requests: [{name, args, description}], review_configs: [{action_name, allowed_decisions}] }`; resume `Command(resume={"decisions": [...]})`, positional, count mismatch raises. Per-call mode (future default): `{type: "tool_approval", tool_call_id, name, args, response_schema}`, resumed by interrupt id.
  - Edits recorded by `tool_call_id` and substituted at execution; reject yields `ToolMessage(status="error")`: "The tool was not executed. Do not retry this tool call unless the user explicitly requests it."
  - Rules: checkpointer required; `when` must be deterministic (re-runs on resume); place HITL before retry middleware; keep edits conservative or the model re-plans.

### Ideas to steal
1. `ActionRequest + ReviewConfig(allowed_decisions) → Decision` as the Outbox schema, markdown `description`.
2. Four decision semantics: approve / edit / reject (reason fed back as an error result) / respond (answer a question).
3. Deterministic `when` predicates as the L-level rule engine.
4. Batch all gated calls from one turn into a single card.

---

## 5. Other notable projects

- **Agent Kanban** (https://github.com/saltbo/agent-kanban) — FSL-1.1-ALv2 (Apache 2.0 after 2 years); TS, Hono on Cloudflare Workers + D1. `Todo → claim → In Progress → submit → In Review → Done | reject`; assignee may not review its own submission; dependency cycles rejected; auto idempotency keys reused across retries; behaviour in `spec/*.feature` with `[spec: …]` test markers.
- **Agent Autonomy Kit** (https://github.com/reflectt/agent-autonomy-kit) — MIT; Markdown `tasks/QUEUE.md` (Ready / In Progress / Blocked / Done Today, `[CRITICAL]…[LOW]`); heartbeat every 15 min in 06:00–23:00: urgent checks → pull top Ready task → log to `memory/YYYY-MM-DD.md` + Discord; `check-queue.js` exit-code gate; subagent watchdog; overnight jobs only for no-human-input tasks; sign-off items parked in Blocked. Entirely compliance-based.
- **Impri** (https://github.com/sekera-radim/impri) — MIT core, ~6 stars, early. Pure approval inbox: `action {kind, title, preview{format, body}, editable fields}` via MCP (`impri_push_action`, `impri_await_decision`, `impri_report_result`) or REST (`POST /v1/actions`, `GET /v1/actions/{id}`); approve / reject / edit (edited `final_preview` returned); agent polls to decision or timeout, reports `executed` / `execute_failed`; Slack/Discord/Telegram/email/ntfy/webhook notifications; "watchers" (RSS, Reddit, URL diff, GitHub releases) feed the same inbox; audit log.

---

## Design recommendations for our task center

1. **Split Signal → Inbox item → Issue → Run.** Use the shared issue states `backlog / todo / in_progress / in_review / done / blocked / cancelled` (all three boards converge); model approvals and inbox entries as separate tables, not issue states.
2. **Run = one execution with a wakeup reason.** `status: queued / dispatched / running / succeeded / failed / timed_out / cancelled`; `reason: signal / assignment / timer / on_demand / dependency_unblocked / missing_output`. Store `session_id`, `work_dir`, usage, `error`; resume cwd-aware; one fresh-session retry on unknown/poisoned session.
3. **Coalesce in the database:** partial unique index "one queued/dispatched run per issue" + merge wakeups while running + lease-style atomic checkout before `in_progress`.
4. **Append-only run event log** `run_event(run_id, seq, type, tool, input, output)` from Agent SDK stream events; UI tails by `since seq`; log steer messages (cap ~3/run).
5. **Outbox = LangChain HITL triple:** `action_request {name, args, description(md), preview}`, `review_config {allowed_decisions}`, `decision {type: approve|edit|reject|respond, edited_action?, message?}`; states `pending → approved|edited|rejected|expired → executed|execute_failed`; actor + timestamp + comment on every decision; reject text fed back verbatim as an error tool result.
6. **Map L1–L5 onto OpenClaw's layers**, per (tool, signal source, target): L1 observe = read-only tool policy; L2 draft = every side effect becomes an Outbox card ("guarded"); L3 = LLM reviewer or deterministic `when` predicate allows/denies/asks, three denials escalate, denials return a reason not a card; L4 = standing grants bound to exact tool + arg pattern + scope with expiry, audited; L5 = full for one narrow scope. Wire this through Agent SDK `canUseTool` / permission hooks, **not** `--dangerously-skip-permissions`.
7. **Proactive loop as many small jobs:** one job per sensor with schedule, scratch checklist, `activeHours`, `idleOnly`, and a `NO_REPLY`/`no_change` outcome that suppresses notification. Keep a standing-orders doc per domain (Authority / Triggers / Gates / Escalation / Never-do) and relax gates over time.
8. **Standing intents** for event-conditioned follow-ups (keyword match, `maxFires`, `cooldownSeconds`, expiry, explicit cancel only), separate from clock jobs.
9. **Typed classification, consumer-owned thresholds:** classifier returns label probabilities; abstention = "ask"; L-level cut-offs live in config and are validated on a labelled sample.
10. **All sensed content is untrusted with provenance:** deterministic command parsing (no LLM intent inference from email bodies), idempotency keys per signal (message-id, delivery-id, hash), periodic reconciliation instead of re-import.
11. **Supervision defaults:** per-run timeout + grace before kill, idle/tool watchdogs, `long_running / stalled / stuck` detection, auto-pause jobs with extreme failure rates, "no visible output" backstop.
12. **Budgets first-class:** cost event per run (provider, model, tokens, cents); per-domain and global monthly caps, 80% warn / 100% pause; burn rate on the dashboard.
13. **Isolation per run:** worktree off a bare cache, private `TMPDIR`, brief in `CLAUDE.md`, skills materialised into the run dir, secrets as references injected at launch.
14. **Dashboard = one endpoint:** runs/agents by status, issues by status, stale work, pending Outbox by severity, spend vs budget, recent activity; local WebSocket push with idempotent side-effecting RPCs and "no replay, refresh on gap".
15. **Local-first storage:** one SQLite per workspace (OpenClaw) beats Multica's Postgres + Go server for a personal tool; Markdown memory files (`MEMORY.md`, daily notes, `USER.md`) keep state inspectable; export/import without secret values.

## Pitfalls observed

- **Permission bypass is the default everywhere.** Paperclip `dangerouslySkipPermissions=true`; Multica strips `--permission-mode`; OpenClaw automations are denied outright with no approval client connected. If the Outbox is not inside the agent's permission callback, approvals degrade to post-hoc review.
- **Monolithic heartbeats age badly.** OpenClaw retired `HEARTBEAT.md`/`HEARTBEAT_OK` into per-job automations after duplicate deliveries and no-route skips; Markdown queues depend on the agent running the checker.
- **Approval schemas churn.** Agent Inbox is archived; `accept/edit/response/ignore` became `approve/edit/reject/respond`; `respond` misused as a denial reads as success to the model. Version the Outbox contract.
- **Non-deterministic gating breaks resume** (`when` re-runs on replay). Keep L-level rules pure functions of the request.
- **Budget stops lag** behind in-flight runs and delayed usage reports.
- **Polymorphic ids without FKs and schema sprawl** (Multica: 40+ migrations fast). Decide early on typed ids.
- **Lost/duplicated events:** no WS replay (OpenClaw); single execution only with a stable idempotency key (Multica); unverifiable webhooks are hints confirmed by read-back (Paperclip).
- **Licensing varies:** Multica adds conditions to Apache 2.0; Agent Kanban is FSL-1.1; OpenClaw, Paperclip, agent-inbox, Impri, Autonomy Kit are MIT.
- **Telemetry on by default** (Paperclip; Multica self-host daily snapshot).
- **Session drift:** resume must be cwd-aware; mid-task permission tightening should cancel pending approvals, never grant them; completed side effects cannot be rolled back.
