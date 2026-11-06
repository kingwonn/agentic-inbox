# Sensors module (`src/sensors/`)

Sensors turn external information sources into `signals` rows. They never create inbox items or tasks: the engine's patrol polls each enabled sensor, upserts the returned `NewSignal[]` through `repo.signals.upsert()` (which de-duplicates by `(source, external_id)` and detects changes by fingerprint), records a `sensor_poll` event and hands new/changed signals to triage.

## Contract (unchanged from `docs/CONTRACTS.md`)

```ts
// src/sensors/registry.ts
export interface SensorEntry { sensor: Sensor; config: Record<string, unknown>; enabled: boolean }
export function createSensors(config: Config): SensorEntry[]
export function makeSensorContext(entry: SensorEntry, deps: { repo: Repo; logger: Logger; loaded: LoadedConfig; now?: () => Date }): SensorContext
export const ALL_SENSORS: readonly Sensor[]          // manual, localgit, github, imap, ics, fsdocs (patrol order)
export function getSensor(name: string): Sensor | undefined
```

No changes were made to `src/core/*`, `src/config/*` or `src/sensors/types.ts`. `makeSensorContext` accepts an optional `now` (used by tests for deterministic calendars); the contract signature is a subset of it.

`createSensors` returns one entry per built-in sensor. `enabled = config.sensors.<name>.enabled && sensor.configured(cfg)`, so a sensor that is switched on but lacks credentials shows up as disabled instead of failing every poll. The entry's `config` is the sensor's own YAML section plus a few global keys it needs: `locale`, `timezone`, `capture_dir` (manual, derived from `data_dir`) and `repo_root` (localgit).

`makeSensorContext` builds the `SensorContext`: cursors backed by `repo.cursors` scoped by sensor name (`makeCursorStore` from `types.ts`), a child logger `tc:sensor:<name>`, `rootDir`/`resolvePath` from `LoadedConfig`.

## Rules every sensor follows

- **Idempotent**: stable `external_id`; re-emitting an unchanged item is harmless (fingerprint dedupe), but sensors avoid re-fetching expensive detail endpoints through cursor snapshots.
- **Resilient**: transient network/IO problems become `warnings` in the poll result (and `ctx.logger.warn`); the poll still returns whatever it collected. Only misconfiguration (missing credentials, auth failure, no token *and* no `gh`) throws `SensorConfigError` (`src/sensors/util.ts`).
- **Bounded**: every network request has a 20 s timeout (`safeFetch`, `withTimeout`, `runCommand`), retries are bounded (2), and each poll has a work budget (GitHub 160 API calls, fsdocs 200 changed files, IMAP `max_messages`).
- **Localised**: text the sensors compose themselves (titles of git/doc/branch signals, key-fact labels) honours `config.locale` (`zh-CN` default, `en`) through `src/sensors/i18n.ts`. The source's own text (PR title, email subject, event summary) is passed through as-is.
- **Prompt-injection aware**: signal bodies are data. The sensors only add structured facts; nothing from a body is interpreted.

## Shared helpers (`src/sensors/util.ts`)

`safeFetch` (timeout + bounded retries on network errors/429/5xx; honours an outer `AbortSignal`; proxy-friendly because it uses Node's global `fetch`, so `--use-env-proxy` / `NODE_USE_ENV_PROXY=1` apply), `fetchJson`, `runCommand` (execFile that never throws, with timeout/kill), `commandExists`, `excerpt`, `stripHtml`, `firstLine`, `sha1`/`sha256`/`hashOf`, `timeoutSignal`, `withTimeout`, `Warnings` (deduplicated, bounded), `SensorConfigError`, `isTransientError`.

## Sensors

| name | kinds | external_id | cursor keys |
|---|---|---|---|
| `github` | `pull_request`, `issue`, `check_failure`, `commits`, `branch`, `notification`, `assigned_issue`, `review_request` | `pr:<owner/repo>#<n>`, `issue:<repo>#<n>`, `checks:<repo>#<n>`, `commits:<repo>:<branch>:<sha12>`, `branch:<repo>:<name>`, `notif:<id>`, `search:assigned|review:<repo>#<n>` | `updated_since:<repo>`, `snapshot:<repo>`, `notifications_since`, `cap:notifications`, `cap:search` |
| `imap` | `email` | `<uidvalidity>:<uid>` | `uidvalidity`, `last_uid`, `account`, `mailbox` |
| `ics` | `calendar_event`, `calendar_event_removed` | `<uid>@<startIso>` | `snapshot:<sha1(url)[0:12]>` |
| `localgit` | `uncommitted_changes`, `unpushed_commits`, `stale_branches`, `merge_conflicts`, `detached_head` | `<repo-basename>:<uncommitted|unpushed|stale|conflicts|detached>` | `state:<repo-basename>` |
| `fsdocs` | `document` | absolute file path | `files:<sha1(root)[0:12]>` |
| `manual` | `manual` (or caller-chosen) | file name (drop folder) / `capture:<ts>-<hash>` | – |

### github (`github.ts`)

- **Auth**: `token` → `fetch` with `Authorization: Bearer`; else `use_gh_cli` and `gh` on PATH → `gh api --method GET <path>` (JSON stdout; `(HTTP nnn)` parsed from stderr). Neither → `SensorConfigError`. The API layer is injectable (`createGithubSensor({ api })`) and both implementations are exported (`createTokenApi`, `createGhCliApi`).
- **Per repo** (`config.sensors.github.repos`, `owner/name`):
  - open PRs (`pulls?state=open`, up to 3 pages) emitted every poll; PRs closed/merged since the cursor emitted once. `pulls/{n}` (mergeable_state), `pulls/{n}/reviews` (review decision: `approved` / `changes_requested` / `review_required`) and `commits/{sha}/check-runs` are fetched only when `updated_at`, `state` or head sha changed vs the snapshot (404/empty check-runs tolerated). Metadata: `{number, state, draft, mergeable_state, head{ref,sha,repo}, base{ref,sha}, review_decision, checks{total,success,pending,failing[]}, updated_at, author, labels, assignees, requested_reviewers, assigned_to_me, review_requested}`. Body = key facts + PR body excerpt (≤ 2000 chars).
  - failing check runs on open PR heads → `check_failure` (`checks:<repo>#<n>`); when the checks turn green the same signal is updated once with `metadata.active=false`.
  - open issues (PRs filtered out) every poll, closed ones changed since the cursor once. `metadata.comments_delta` = comments gained since the last change, kept stable until the next change so the fingerprint does not flap.
  - commits on the default branch since the cursor (first run: last 7 days): one `commits` signal per batch, body lists `sha message (author)`.
  - branches: `branches` list; last-commit date fetched only when the sha changed, `compare/<default>...<branch>` only when the branch or default moved; branches with no commits for > 14 days and `ahead_by > 0` (or unknown) → `branch` signal (`open_pr` in metadata when the branch heads an open PR). Max 30 detail calls per poll.
- **Searches** (`include_searches`): `search/issues?q=is:issue is:open assignee:<user|@me>` and `is:pr is:open review-requested:<user|@me>`. Hits inside configured repos become flags on the repo signals (`assigned_to_me`, `review_requested`); hits elsewhere become `assigned_issue` / `review_request` signals.
- **Notifications** (`include_notifications`): `notifications?all=false&since=<cursor>` → `notification` signals.
- **Capability failures**: a repo-scoped token (what Claude Code sessions get: only `repos/{owner}/{repo}/...` works) makes `/notifications` return 403. That is logged as a warning, `cap:<feature>` is set and the endpoint is retried after 6 h. Searches do work with the session token (GitHub requires `is:issue`/`is:pr` in the query).
- `updated_since:<repo>` only advances when every list call for that repo succeeded, so a network blip re-fetches instead of losing items.

### imap (`imap.ts`)

imapflow 2 + mailparser. One short-lived connection per poll: `connect` → `getMailboxLock(mailbox)` → UID search → `fetch(uids, {envelope, flags, internalDate, source, threadId, labels, size}, {uid:true})` → `simpleParser` → `logout`.

- **Cursor**: `uidvalidity` + `last_uid`; if UIDVALIDITY, account (`host:port:user` hash) or mailbox changes the cursor resets. First run (or after a reset) seeds with `SEARCH SINCE <now - since_days>`, newest `max_messages` only; later runs search `last_uid+1:*` (the "N:* returns the last message" quirk is filtered) and process the oldest `max_messages` (the rest are reported as pending and picked up next poll).
- **Signal**: `kind: email`, `title` = subject, `actor` = from address, `url` = Gmail thread link when the server exposes a numeric X-GM-THRID, `occurred_at` = Date header. Body = `From/To/Date/Attachments` header block + text excerpt (≤ 4000 chars; HTML-only mail is converted to text). Metadata: `messageId, inReplyTo, references[], threadId, emailId, labels[], from, to, cc, date, hasAttachments, attachments[{filename,contentType,size}], size, seen, flagged, answered, flags{bulk, noreply, auto, list_id, seen, flagged, answered}`.
- **Bulk detection**: `flags.bulk` is set from `List-Unsubscribe`, `List-Id`, `Precedence: bulk|list|junk`, `Auto-Submitted` ≠ no, `X-Auto-Response-Suppress`; `flags.noreply` from the sender local part (`noreply`, `notifications`, `mailer-daemon`, …). Everything is still emitted; the classifier uses the flags to deprioritise.
- Connection errors → warning; authentication failures (`authenticationFailed`, `AUTHENTICATIONFAILED`, "Invalid credentials") → `SensorConfigError`.
- Testing: `createImapSensor({ createClient, parse })` injects the client factory (`ImapClientLike`, a structural subset of `ImapFlow`) — see `tests/sensors-imap.test.ts` for the in-memory server.

**Gmail setup (app password, no OAuth)**

1. Google Account → Security → turn on **2-Step Verification** (required; app passwords are hidden otherwise and unavailable under Advanced Protection or when a Workspace admin blocks them).
2. Open <https://myaccount.google.com/apppasswords>, create an app password named e.g. `taskcenter`, copy the 16 characters (spaces can be dropped).
3. In `taskcenter/.env` (chmod 600): `IMAP_USER=you@gmail.com`, `IMAP_PASSWORD=<app password>`; in `config/taskcenter.yaml`: `sensors.imap.enabled: true`, host `imap.gmail.com`, port `993`, mailbox `INBOX` (or `[Gmail]/All Mail`).
4. If login fails, check Gmail → Settings → Forwarding and POP/IMAP (IMAP is always on for most accounts since 2025) and that the password was not rotated ("Reset" in the app-passwords page invalidates it).
5. Other providers (Fastmail, iCloud, Outlook with basic auth disabled → use an app password / different host) only need host/port/user/password.

### ics (`ics.ts`)

node-ical. Each `urls[]` entry is a `https://` feed (Google Calendar → Settings → *Integrate calendar* → **Secret address in iCal format**; treat it as a password) or a local `.ics` path (resolved against the taskcenter root; used by tests). Events in `[now, now + horizon_days]` are expanded with `expandRecurringEvent` (RRULE + EXDATE + RECURRENCE-ID overrides, ongoing events included). The snapshot `{ "<uid>@<startIso>": { hash, start, end, summary, status } }` drives the diff:

- new instance → `calendar_event` with `metadata.changed = "new"`, title = summary;
- hash changed (summary, times, location, description, status, attendee partstats, url) → `changed = "updated"`, title "日程变更：…" / "Event changed: …";
- status became `CANCELLED` → `changed = "cancelled"` (instances that were already cancelled when first seen are ignored);
- instance disappeared while still in the future and inside the horizon → `calendar_event_removed` on the same `external_id` (kind changes, so the signal is re-triaged).

Metadata: `{uid, start, end, allDay, tz, location, attendees[{email,name,status,role}], organizer, description, status, changed, recurring, override, sequence, last_modified, calendar}`; `occurred_at` = event start, `actor` = organizer email. Fetch problems are warnings and the previous snapshot is kept (secret URL tokens are masked in warnings). No daily agenda is produced here (the digest does that).

### localgit (`localgit.ts`)

Plain `git` via `execFile` (`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, no network). Each `repos[]` entry is resolved against the taskcenter root (`..` = the agentic-inbox checkout; `~/` is honoured). Per repo it collects `status --porcelain`, `for-each-ref` (upstream, `[ahead N, behind M]`/`[gone]`, committer date), `rev-list --count <branch> --not --remotes` for branches without upstream, in-progress operations (`MERGE_HEAD`, `rebase-merge/apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`) and `symbolic-ref HEAD`. Conditions:

| condition | kind | active when |
|---|---|---|
| `uncommitted` | `uncommitted_changes` | any staged/unstaged/untracked entry (counts + top 10 files in body, 25 in metadata) |
| `unpushed` | `unpushed_commits` | a branch is ahead of its upstream, its upstream is gone, or it has no upstream and commits not on any remote |
| `stale` | `stale_branches` | a non-default branch has no commits for > `stale_days` |
| `conflicts` | `merge_conflicts` | conflict entries in status or an in-progress merge/rebase/cherry-pick/revert |
| `detached` | `detached_head` | HEAD is not a branch |

A signal is emitted only when the condition's state hash changes (cursor `state:<repo>` holds one hash per condition; hashes exclude volatile data such as ages, so a tree that stays dirty is not re-emitted every poll). When a condition clears, the same `external_id` is emitted once more with `metadata.active = false` and a "resolved" title so triage can close the item. Repos with `.git/index.lock` are skipped for that poll; missing paths are warnings.

### fsdocs (`fsdocs.ts`)

Recursive scan of `paths[]` (skips `node_modules`, `.git`, `dist`, `build`, hidden dirs; depth ≤ 12; files > `max_file_kb` skipped) for the configured `extensions`. Change detection per root: `(mtime, size)` compared with the cursor map, then sha256 of the content (so a `touch` does not re-emit). New/changed files emit `document` signals: `external_id` = absolute path, title "新文档：name — first heading" / "Document updated: …", body = first ~3000 chars + extracted open items, metadata `{path, root, rel, name, ext, size, mtime, hash, changed: new|updated, todos[] (≤ 20 lines matching TODO/FIXME/XXX/HACK or "- [ ]"), todo_count, chars}`. Text-like extensions are read directly; everything else (`docx`, `pdf`, `pptx`, …) goes through `markitdown <file>` (`pipx install 'markitdown[all]'`) when installed; otherwise those files are skipped with one warning and retried once an extractor exists. At most 200 changed files are processed per poll; the rest are deferred.

### manual (`manual.ts`)

- **Drop folder**: `<data_dir>/capture/*.md|*.txt|*.markdown` → `manual` signals (`external_id` = file name, title = first heading/line, body = content ≤ 16 k chars, `actor: user`, `metadata.via: drop_folder`) and the file is moved to `<data_dir>/capture/processed/` (timestamp suffix on name clashes). Empty files are moved without a signal.
- **`captureSignal(repo, text, by, opts?)`** upserts a manual signal directly and returns the stored `Signal` (used by CLI `tc capture`, the HTTP API and Telegram free-text messages). `opts`: `title`, `url`, `kind`, `metadata`, `externalId` (default `capture:<time36>-<sha1(text)[0:8]>`, i.e. every capture is a new signal), `occurredAt`. `buildCaptureSignal()` is exported for callers that batch upserts themselves.

## Configuration

See `config/taskcenter.example.yaml` → `sensors:`. Secrets come from `.env` through `${VAR:-}` substitution (`GITHUB_TOKEN`, `IMAP_USER`, `IMAP_PASSWORD`, `CALENDAR_ICS_URL`). Notes:

- `github.use_gh_cli: true` is the zero-config path on a machine where `gh auth login` was done; set `token` for a PAT (classic: `repo`, `notifications`; fine-grained: Metadata/Issues/Pull requests/Checks/Contents read + Notifications read).
- `localgit.repos: [..]` watches the agentic-inbox checkout itself; add more paths (absolute or `~/…`).
- `ics.urls` accepts several calendars; each gets its own snapshot.
- `fsdocs.extensions` without dots; `max_file_kb` guards against huge exports.

## Running one sensor by hand

```sh
cd taskcenter
node --no-warnings=ExperimentalWarning --import tsx scripts/poll-sensor.ts github      # uses config + data/taskcenter.db
node --no-warnings=ExperimentalWarning --import tsx scripts/poll-sensor.ts localgit --json
GITHUB_TOKEN= node --import tsx scripts/poll-sensor.ts github   # force the gh-cli path when a token is in the environment
```

The script loads the config, opens the real database, polls one sensor, upserts the signals and prints `new / changed / unchanged` per signal plus warnings and cursors (`--force` runs a sensor the config marks disabled).

## Tests

`npx vitest run tests/sensors*.test.ts`

- `tests/sensors.test.ts` — util, i18n, registry, manual (temp drop folder + `captureSignal`), fsdocs (temp tree with node_modules/large/docx cases, mtime-only vs content change, injected extractor), localgit (porcelain/track parsing, condition evaluation, a scripted temp repo: dirty → clean → detached → back, and a live poll of the agentic-inbox checkout).
- `tests/sensors-github.test.ts` — helpers, `gh` error parsing with a fake runner, Bearer auth with injected fetch, a full mocked-API poll (PR/checks/issue/commits/stale branches/search, notifications 403 → warning, snapshot prevents detail re-fetch, stable fingerprints on the second poll, comment deltas, closed items, network failures, misconfiguration) and a **live** poll of `kingwonn/agentic-inbox` through `gh api` (skipped when `gh` is missing, `TC_SKIP_LIVE` is set, or the repo probe fails).
- `tests/sensors-imap.test.ts` — in-memory IMAP client: seeding, caps, UID-range quirk, new mail, UIDVALIDITY reset, bulk/noreply flags, HTML → text, attachments, Gmail thread URL, connect vs auth errors.
- `tests/sensors-ics.test.ts` — `tests/fixtures/calendar.ics` (weekly RRULE with EXDATE, timed, all-day, past, far-future and cancelled events): expansion, new → unchanged → updated/removed/cancelled (RECURRENCE-ID override) → stable.

## Known limitations / follow-ups

- GitHub `notifications` need a user-scoped token (`notifications` scope); with the session's repo-scoped token they are skipped with a warning (retry every 6 h).
- IMAP polls fetch full message sources (`source: true`); very large attachments are downloaded. Consider `source: { maxLength }` + BODYSTRUCTURE if that matters.
- fsdocs is scan-based (no chokidar watcher); the patrol interval bounds the latency.
- `webhook` sensor from the architecture is not part of this module (it belongs to the server, which can call `captureSignal`).
