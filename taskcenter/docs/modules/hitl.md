# hitl — Outbox approvals, notifier, channels, inbound decisions

`src/hitl/` is the human-in-the-loop layer: it turns gated agent actions into **Outbox approvals**, pushes them to the user over **channels** (console, Telegram, ntfy, email, webhook), collects **decisions** (Telegram buttons/commands, dashboard/API, CLI) and applies them to tasks so the executor can resume.

Decision semantics follow the LangChain HITL vocabulary: `approve` / `edit` / `reject` / `respond`, plus custom option values for `decision` and `review` kinds.

## Files

| File | Exports |
|---|---|
| `approvals.ts` | `createApprovalService(deps)` → `ApprovalService` + `expireDue()`; `createInboundHandler()`; `expireDueApprovals()`; `defaultOptions`, `resolveDecision`, `mergeEditedPayload`, `ApprovalNotPendingError`, `ApprovalNotFoundError` |
| `notifier.ts` | `class Notifier implements NotifierLike`, `createNotifier(deps)`, quiet-hours helpers |
| `render.ts` | `renderApproval(a, task, locale, publicUrl?)`, `renderTaskEvent(kind, task, locale, extra?)`, `describeAction`, `outboxUrl`, `taskUrl`, `setRenderTimeZone` |
| `channels/index.ts` | `createChannels(config, deps)` (console always; telegram / ntfy / email / webhook when `enabled` **and** configured) |
| `channels/console.ts` | boxed stderr output + `data/logs/notifications.log` (JSONL) |
| `channels/telegram.ts` | Bot API via `fetch` (sendMessage HTML + inline keyboard, editMessageReplyMarkup), `TelegramApi` |
| `inbound/telegram.ts` | long polling (`getUpdates`), allowlist, callbacks, text commands, `parseCommand`, `classifyReply` |
| `channels/ntfy.ts` | JSON publish with `view` + `http` approve/reject actions |
| `channels/email.ts` | nodemailer SMTP, text + HTML |
| `channels/webhook.ts` | POST JSON envelope |
| `index.ts` | re-exports |

## Approval service

```ts
const approvals = createApprovalService({ repo, bus, notifier, config, logger, publicUrl, pollIntervalMs? });
```

### `request(input: NewApproval)`
1. Options default by kind — `action`: approve / edit / reject · `decision`: the given options + reject · `review`: accept / request_changes / reject · `question`: respond.
2. `expires_at` defaults to now + `config.approval.expire_hours`.
3. Creates the row, records event `approval_requested` (payload `{approval_id, kind, risk, title}`), emits bus `approval.requested`.
4. If the task is `running` or `ready` it moves to `waiting_human` (the run itself stays `running`; the tool gate decides whether to park the run).
5. Renders the message and calls `notifier.notify({kind:'approval_requested', approval, task, title, body, url, priority})`. Notifier failures are logged, never thrown.

### `waitForDecision(id, timeoutMs, signal?)`
Resolves immediately when the approval is not pending. Otherwise it listens on bus `approval.decided` **and** polls the DB every 2 s (decisions may come from the CLI / another process), until decided, timeout or abort. Always returns the current approval (possibly still `pending`).

### `decide({approvalId, decision, note?, editedPayload?, decidedBy})`

| decision | status | notes |
|---|---|---|
| `approve` | `approved` (`decision=approve`; on a `review` → `accept`) | |
| `edit` | `edited` | `editedPayload` must be a JSON object; it is shallow-merged over `payload` (`input` merged one level deeper) and stored in `edited_payload` |
| `reject` | `rejected` | `note` = reason |
| `respond` | `approved` (`decision=respond`) | `note` = the answer (required) |
| custom value (`decision`/`review` kinds) | `approved` with `decision=<value>` | must be one of the approval's options |

`repo.approvals.decide` is atomic; a non-pending or expired approval throws `ApprovalNotPendingError` (with `.approval`), an unknown id throws `ApprovalNotFoundError`. Expired-on-arrival approvals are marked `expired` first. The service then records `approval_decided`, emits bus `approval.decided` and applies the result to the task:

- **task `waiting_human` and no other pending approvals** → task `ready` with reason `approval <id> <decision>`, `task.context.pending_resume = { resume: { approvalId, kind, decision, note, editedPayload, decidedAt } }`, and `bus.wake('approval_decided')`. The executor should pass `context.pending_resume.resume` to `buildExecutionPrompt(..., { resume })` / `RunInput.resumeSessionId`, then clear it.
- task still `running` (the gate is waiting inline) → nothing; the gate's `waitForDecision` resolves.
- kind `review`: `accept` → `done`; `request_changes` → `ready` (note appended to `task.context.review_notes[]`, `pending_resume` set); `reject` → `cancelled`.

Transitions use `transitionTask`; an invalid transition is retried with `force: true` and logged.

### `pending()` / `expireDue(now?)`
`expireDue` marks overdue pending approvals `expired`, records `approval_decided` events (`status: "expired"`) and emits `approval.decided` with `decision: "expired"` so waiting gates wake up and channels retract buttons. `expireDueApprovals({repo, bus, logger})` is the standalone helper for the maintenance job.

### `createInboundHandler({approvals, repo, locale?, capture?, status?})`
Builds the `InboundHandler` channels call. Errors become friendly replies; repeating the same decision on an already-decided approval returns `ok: true` ("already approved") so Telegram retries are idempotent.

## Notifier

```ts
const notifier = createNotifier({ config, repo, bus, logger, rootDir?, dataDir?, publicUrl?, channels?, quietHours?, now?, reviewDelayMs? });
await notifier.start(handler);   // starts Telegram polling
await notifier.stop();
```

`notify(msg)` pipeline (never throws):
1. **Filter** — `msg.kind` must be in `config.notifications.notify_on`; `info` always passes (it is only produced by explicit calls such as a test command).
2. **Priority** — `msg.priority`, else `high` for approvals with `risk: high` and for `budget_warning`, else `normal`.
3. **Quiet hours** — `habits.quiet_hours` from `config.profile_path` (e.g. `23:00-08:00`, evaluated in `config.timezone`). Only `high` passes; everything else is deferred in memory and flushed once quiet hours end (approvals decided meanwhile are dropped). `flushDeferred()` / `pendingDeferred()` are exposed.
4. **Dedupe** — approval messages are skipped per channel when `repo.notifications.existsFor(approval_id, channel)` already has a `sent` row.
5. **Fan-out** — every channel in parallel, each in its own try/catch; a `notifications` row per channel (`sent` / `failed`), `approval.channel_refs[channel] = externalRef` (Telegram: `chat_id:message_id`), and one `notification` event.

Bus subscriptions:
- `task.changed` → `task_done` / `task_failed` / `review_ready` for **top-level tasks or parents** (children are silent). `review_ready` waits `reviewDelayMs` (1.5 s) and is skipped when a pending `review` approval exists for the task (its `approval_requested` message already covers it).
- `approval.decided` → `channel.onDecided(approval)` (Telegram removes the inline keyboard and shows the final status).

## Rendering

`renderApproval` produces a compact message: risk emoji + kind + title; task line; *what the agent wants* (`payload.tool` + the key input: Bash command, email to/subject, PR title/branches, file path, else compact JSON); *why* (`context`); recommendation; options with the matching Telegram command (`/approve apr_x`, `/edit apr_x {json}`, `/respond apr_x …`, `/decide apr_x <option>`); dashboard link `<publicUrl>/#/outbox/<id>`; expiry (`YYYY-MM-DD HH:mm` in `config.timezone`). Bodies are capped at 3 500 chars.

`renderTaskEvent(kind, task, locale, extra)` — `extra` keys: `publicUrl`, `summary`, `artifacts[]`, `follow_ups[]`, `error`, `spentUsd`/`limitUsd`/`message` (budget), `text`/`title` (digest), `body`/`title` (info).

## Channels

| Channel | `configured()` | Notes |
|---|---|---|
| console | always | stderr box (silent when `console.enabled: false`) + `data/logs/notifications.log` |
| telegram | `bot_token` + `chat_id` | HTML parse mode (escaped), buttons `d:<approvalId>:<option>` (≤ 64 bytes, falls back to `#<index>`), plain-text retry on parse errors, `disable_notification` for `low` priority |
| ntfy | `topic` + `server` | JSON to server root: `topic, title, message, markdown:true, priority (low 2 / normal 3 / high 4), tags, click, actions`. Actions (max 3): `view` dashboard + `http` POST `${publicUrl}/api/approvals/<id>/decide` with `{"decision":"approve"|"accept"}` / `{"decision":"reject"}` and `Authorization: Bearer <server.token>` — only when `server.public_url` is set |
| email | `smtp_host` + `from` + `to` | subject = title; text + simple HTML with a dashboard button; port 465 → implicit TLS |
| webhook | `url` is http(s) | `POST {kind, title, body, url, priority, approval, task, sent_at}` |

## Telegram inbound

Long polling `getUpdates` (timeout 25 s, `allowed_updates: message, callback_query`), offset persisted in `repo.meta["telegram_update_offset"]`, network errors back off 2 s → 60 s (honours `retry_after`), `stop()` aborts the in-flight request. Allowlist: `chat.id == chat_id` **or** `from.id ∈ allowed_user_ids`; everything else is ignored (buttons get an "unauthorized" toast).

Commands: `/approve <id> [note]`, `/reject <id> [reason]`, `/edit <id> {json}`, `/respond <id> <text>`, `/decide <id> <option> [note]`, `/pending`, `/status`, `/capture <text>` (→ `handler.capture`), `/help`. Replying to an approval message with free text: first word *yes/ok/approve/同意/批准…* → approve (rest = note); *no/reject/拒绝…* → reject; any other text answers a `question` approval, otherwise the bot asks for clarification. Non-command text that is not a reply gets a `/capture` suggestion. Buttons: approve/reject/custom options decide immediately; *edit* / *respond* buttons reply with instructions (the user then replies to that message).

## Setup

### Telegram (recommended)
1. Talk to `@BotFather` → `/newbot` → copy the token into `.env` as `TELEGRAM_BOT_TOKEN`.
2. Open your bot and press **Start** (bots cannot message you first).
3. Find your numeric chat id: send any message to the bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `message.chat.id` (or ask `@userinfobot`). Put it in `.env` as `TELEGRAM_CHAT_ID`.
4. In `config/taskcenter.yaml`: `notifications.channels.telegram: { enabled: true, poll: true }`; optionally list extra `allowed_user_ids`.
5. Run `tc daemon`; send `/help` to the bot. Buttons appear on approval messages; `/pending` lists open items.

Only one process may poll a bot token at a time (Telegram answers 409 otherwise); the daemon is the poller.

### ntfy
1. Install the ntfy app (iOS/Android/desktop) and subscribe to a long random topic, e.g. `tc-7f3a9b…`.
2. `.env`: `NTFY_TOPIC=<topic>` (and `NTFY_TOKEN` + `server:` for a self-hosted/auth'd server).
3. `notifications.channels.ntfy.enabled: true`.
4. For Approve/Reject buttons in the push itself, set `server.public_url` to a URL your phone can reach (Tailscale / Cloudflare Tunnel) and `TC_API_TOKEN`; the buttons POST to `/api/approvals/<id>/decide`.

### Email
1. `.env`: `SMTP_HOST`, `SMTP_PORT` (587 STARTTLS or 465 TLS), `SMTP_USER`, `SMTP_PASSWORD` (Gmail: an App Password), `NOTIFY_EMAIL_TO`.
2. `notifications.channels.email.enabled: true`; `from` defaults to `SMTP_USER`.
3. Mails contain the dashboard link; decisions are made in the dashboard (or Telegram/CLI).

### Quiet hours
`config/profile.yaml` → `habits.quiet_hours: "23:00-08:00"` (in `config.timezone`). High-risk approvals and budget warnings still get through; everything else is delivered when the window ends.

## Contract changes (additive)
- `src/hitl/types.ts`: `InboundDecision.decision` widened to `Decision | (string & {})` so custom option values (`accept`, `request_changes`, decision options) can be submitted; `Channel.onDecided?(approval)` optional hook added.
- No changes to `src/core/*` or `src/config/*`.

## Tests
`npx vitest run tests/hitl*.test.ts` — approvals flow (request → waiting_human → decide → ready/done/cancelled, waitForDecision via bus / poll / timeout / abort, expiry), render snapshots (zh-CN/en), Telegram parsing + mocked-fetch polling loop, notifier filters / quiet hours / dedupe / bus auto-notify, channel payload shapes.
