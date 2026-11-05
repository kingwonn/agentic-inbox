# Integrations reference: perception sources and HITL channels

Target: Node.js 22 / TypeScript daemon that polls personal information sources with minimal OAuth, plus push channels for human-in-the-loop (HITL) prompts.

Verified on 2026-11-05. Legend: **[verified]** = checked against the npm registry, the package's shipped `.d.ts`/README, or primary docs today; **[unverified]** = from memory or secondary sources, confirm before relying on it.

## Package versions (npm `latest`, 2026-11-05) [verified]

| Package | Version | Node engine | Notes |
|---|---|---|---|
| `imapflow` | 2.10.2 | >=20 | 2.0 (Sep 2026) is a TS rewrite; ESM+CJS; `lib/` no longer published |
| `mailparser` | 3.14.2 | >=20 | `simpleParser()` |
| `nodemailer` | 10.3.1 | >=20 | SMTP out |
| `googleapis` | 189.0.0 | >=22 | Gmail/Calendar API (OAuth) |
| `node-ical` | 0.27.3 | >=22 | has `expandRecurringEvent()` |
| `ical.js` | 2.2.1 | - | lower-level alternative |
| `@octokit/rest` | 22.0.1 | >=20 | plus `@octokit/plugin-throttling` 11.0.5, `@octokit/plugin-retry` 8.1.1 |
| `chokidar` | 6.0.0 | **>=22.22** | v5 is ESM-only (Node 20+); v6 (Oct 2026) rewrite. Pin `chokidar@5` on older 22.x |
| `pdf-parse` | 2.4.5 | >=22.3 | v2 API is a class (`PDFParse`); 1.x line still published (1.1.4) |
| `mammoth` | 1.13.0 | >=12 | docx -> text/html |
| `simple-git` | 4.0.2 | - | v4: named export only, env filtering |
| `@slack/web-api` | 8.3.0 | >=20 | |
| `grammy` | 1.46.0 | >=14 | recommended Telegram lib; `@grammyjs/runner` 2.0.3, `@grammyjs/auto-retry` 2.0.2 |
| `node-telegram-bot-api` | 2.3.0 | >=18 | **v2 (Aug 2026) is a from-scratch redesign**; old `TelegramBot` API = pin `1.1.2` |
| `croner` | 11.0.0 | >=18 | ESM+CJS |
| `node-cron` | 4.6.0 | >=20 | `noOverlap`, events |
| `better-sqlite3` | 13.0.3 | >=22 | cursors/dedupe store |
| `dotenv` 18.0.9, `yaml` 2.9.1, `zod` 4.6.7, `pino` 10.4.0 | | | config/logging |
| `pushover-notifications` 1.2.3, `ntfy` 1.15.11, `node-notifier` 12.1.0 | | | optional; plain `fetch` is enough |

## 0. Common pattern: cursor + stable ID dedupe

Every sensor exposes `poll(cursor) -> { items, nextCursor }`. Items get a `(source, external_id)` unique key; the cursor is written in the same SQLite transaction as the items, so a crash can only cause re-fetch, never loss or duplication.

```ts
import Database from 'better-sqlite3';
const db = new Database('state.db');
db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL');
db.exec(`CREATE TABLE IF NOT EXISTS cursors(source TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS items(source TEXT, external_id TEXT, seen_at INTEGER, payload TEXT,
  PRIMARY KEY(source, external_id));`);
export const commitPoll = db.transaction((source: string, items: {id: string; payload: unknown}[], cursor: string) => {
  const ins = db.prepare('INSERT OR IGNORE INTO items VALUES (?,?,?,?)');
  const fresh = items.filter(i => ins.run(source, i.id, Date.now(), JSON.stringify(i.payload)).changes === 1);
  db.prepare('INSERT OR REPLACE INTO cursors VALUES (?,?,?)').run(source, cursor, Date.now());
  return fresh; // only genuinely new items go to the agent
});
```

Node 22.13+ also ships `node:sqlite` unflagged (stability 1, [unverified] exact minor); `better-sqlite3` is the safer choice.

## 1. Email: IMAP (`imapflow`) + SMTP (`nodemailer`)

**User setup (Gmail, no OAuth):**
1. Turn on 2-Step Verification (required; app passwords are hidden otherwise, and unavailable under Advanced Protection or if a Workspace admin blocks them).
2. Create an app password at `https://myaccount.google.com/apppasswords` (16 chars; spaces can be dropped).
3. IMAP: `imap.gmail.com:993` TLS. [unverified] Google removed the IMAP on/off toggle in early 2025 (always on); if login fails, check Gmail Settings > Forwarding and POP/IMAP.
4. SMTP: `smtp.gmail.com:465` (implicit TLS) or `587` STARTTLS, same app password.

Any other IMAP provider: host/port/user/password from the provider; Fastmail and iCloud also use app-specific passwords.

**Fetch "new since cursor" (UID cursor, the right one for IMAP) [verified against `imapflow` 2.10 types]:**

```ts
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export async function pollImap(cfg: {host:string; user:string; pass:string}, cursor: {uidValidity?: number; lastUid: number}) {
  const client = new ImapFlow({ host: cfg.host, port: 993, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
  await client.connect();                      // one instance = one connection; never reuse after close (InstanceReused)
  const lock = await client.getMailboxLock('INBOX');
  try {
    const mb = client.mailbox; if (!mb) throw new Error('no mailbox');
    if (cursor.uidValidity !== undefined && mb.uidValidity !== cursor.uidValidity) cursor.lastUid = 0; // UIDs reset: full resync
    const items: {id: string; payload: unknown}[] = [];
    // UID range search; alternative queries: { seen: false }, { since: new Date(...) }
    const uids = await client.search({ uid: `${cursor.lastUid + 1}:*` }, { uid: true }) || [];
    const newUids = uids.filter(u => u > cursor.lastUid);          // "N:*" also returns the last message when N > max UID
    if (newUids.length) {
      for await (const msg of client.fetch(newUids, { uid: true, envelope: true, flags: true, internalDate: true, source: true }, { uid: true })) {
        const parsed = await simpleParser(msg.source!);           // text, html, from, to, date, messageId, inReplyTo, references, attachments
        items.push({ id: `${mb.uidValidity}:${msg.uid}`, payload: { subject: parsed.subject, from: parsed.from?.text, date: parsed.date, text: parsed.text?.slice(0, 4000), messageId: parsed.messageId, uid: msg.uid, seen: msg.flags?.has('\\Seen') } });
      }
    }
    return { items, nextCursor: { uidValidity: mb.uidValidity, lastUid: Math.max(cursor.lastUid, ...newUids) } };
  } finally { lock.release(); await client.logout(); }
}
```

Shape notes: `search(query, {uid:true})` returns `number[] | false`; `fetch(range, query, {uid:true})` is an async generator of `{ seq, uid, envelope, flags: Set<string>, internalDate, source: Buffer, emailId?, threadId?, labels? }`; `client.mailbox` has `uidNext`, `uidValidity`, `exists`, `highestModseq`. Gmail adds `gmailraw`/`labels` search keys and `X-GM-EXT-1` `emailId`/`threadId`.

**IDLE vs polling:** `await client.idle()` blocks until the server signals; events `exists`, `expunge`, `flags` fire on the client. For a daemon, polling every 1-5 min with a short-lived connection is simpler and robust; use IDLE only if latency matters (keep one dedicated connection, reconnect on `close`). Gmail allows ~15 simultaneous IMAP connections per account and has daily bandwidth caps (~2.5 GB download) [unverified numbers]; don't fetch `source` for huge mailboxes on first run — seed the cursor with `mailbox.uidNext - 1`.

**Dedupe:** `uidValidity:uid` is stable per mailbox; `Message-ID` header (`parsed.messageId`) is stable across mailboxes/providers (but can be missing or duplicated by misbehaving senders), so store both.

**Outbound / drafts via SMTP:**

```ts
import nodemailer from 'nodemailer';
const smtp = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
await smtp.sendMail({ from: user, to, subject: `Re: ${subject}`, text: body, inReplyTo: messageId, references: [messageId] });
```

Gmail rewrites `From` to the account address; consumer limit ~500 recipients/day [unverified]. To save a *draft* instead of sending over IMAP: `client.append('[Gmail]/Drafts', rfc822Buffer, ['\\Draft'])` (build the MIME with `nodemailer`'s `MailComposer`/`compile().build()`) [unverified API detail; `append` exists in types].

**Gmail API alternative (`googleapis`)**, brief: create a Google Cloud project, enable Gmail API, create an OAuth client of type *Desktop app*, run the loopback flow once (`google.auth.OAuth2` + `generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/gmail.readonly'] })`), store the refresh token. Incremental sync is `gmail.users.history.list({ userId: 'me', startHistoryId })` (cursor = `historyId`; falls back to `messages.list({ q: 'newer_than:1d' })` on 404). Caveats: `gmail.readonly` is a *restricted* scope; while the OAuth consent screen is in **Testing** status, refresh tokens expire after 7 days and only listed test users can authorize — this is the main reason to prefer app password + IMAP for a personal daemon.

## 2. Google Calendar via secret ICS URL (`node-ical`)

**User setup:** Google Calendar web > Settings > *Settings for my calendars* > pick calendar > *Integrate calendar* > copy **"Secret address in iCal format"** (`https://calendar.google.com/calendar/ical/<id>/private-<token>/basic.ics`). Treat it as a password; "Reset" there rotates it. One URL per calendar. [unverified] The feed can lag live edits by minutes.

**Fetch upcoming N days, with recurrence expansion [verified against `node-ical` 0.27 types]:**

```ts
import ical from 'node-ical';
export async function pollIcs(url: string, days = 7) {
  const data = await ical.async.fromURL(url, { signal: AbortSignal.timeout(20_000) }); // Record<uid, component>
  const from = new Date(), to = new Date(Date.now() + days * 86_400_000);
  const items = [];
  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT' || ev.status === 'CANCELLED') continue;
    // handles RRULE + EXDATE + RECURRENCE-ID overrides; non-recurring events return 0-1 instances
    for (const inst of ical.expandRecurringEvent(ev, { from, to, includeOverrides: true, excludeExdates: true })) {
      items.push({ id: `${ev.uid}@${inst.start.toISOString()}`, payload: { summary: String(inst.summary), start: inst.start, end: inst.end,
        allDay: inst.isFullDay, tz: inst.start.tz, location: ev.location, override: inst.isOverride } });
    }
  }
  return { items, nextCursor: new Date().toISOString() };
}
```

Notes: `start`/`end` are UTC `Date`s with `.tz` (IANA) and `.dateOnly` for all-day; display with `Intl.DateTimeFormat(undefined, { timeZone: inst.start.tz })`. The cursor for calendars is not "new items" but a *diff*: keep the previous snapshot of `(uid, instanceStart) -> hash(summary,start,end,location)` and emit `added/changed/removed`. `ical.js` 2.2.1 is the lower-level alternative (`ICAL.parse`, `ICAL.Component`, `RecurExpansion`) if you need VTIMEZONE fidelity. Poll every 5-15 min; the file is the whole calendar, so don't hammer it.

**Google Calendar API alternative:** same OAuth dance as Gmail with scope `calendar.readonly` (sensitive, not restricted); `calendar.events.list({ calendarId: 'primary', timeMin, timeMax, singleEvents: true, orderBy: 'startTime' })` expands recurrences server-side, and `syncToken` gives true incremental sync. Same 7-day-refresh-token caveat in Testing status.

## 3. GitHub (`@octokit/rest` or `fetch`)

**User setup:** Settings > Developer settings > Personal access tokens. Simplest: **classic PAT** with scopes `notifications` (+ `repo` for private repos; `read:org` optional). Fine-grained PAT: repository permissions *Metadata: read*, *Issues: read*, *Pull requests: read*, *Checks: read*, *Contents: read*, and user permission *Notifications: read* — current docs list fine-grained support for the notifications endpoint, but older docs said classic-only, so test `GET /notifications` once [unverified].

```ts
import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
const octokit = new (Octokit.plugin(throttling))({ auth: process.env.GITHUB_TOKEN,
  throttle: { onRateLimit: (retryAfter, _o, _ok, count) => count < 2, onSecondaryRateLimit: () => true } });

// Notifications: cursor = Last-Modified header; 304 responses cost no rate limit
export async function pollNotifications(cursor: { lastModified?: string }) {
  const res = await octokit.request('GET /notifications', { per_page: 100, all: false,
    headers: cursor.lastModified ? { 'if-modified-since': cursor.lastModified } : {} }).catch(e => { if (e.status === 304) return null; throw e; });
  if (!res) return { items: [], nextCursor: cursor };
  const pollSec = Number(res.headers['x-poll-interval'] ?? 60);   // obey it (default 60s)
  const items = res.data.map(n => ({ id: `${n.id}:${n.updated_at}`, payload: { reason: n.reason, title: n.subject.title, type: n.subject.type, url: n.subject.url, repo: n.repository.full_name, unread: n.unread } }));
  return { items, nextCursor: { lastModified: res.headers['last-modified'], pollSec } };
}
// Also: octokit.rest.activity.listNotificationsForAuthenticatedUser({ since }), markThreadAsRead({ thread_id }).

// Issues assigned / mentioned, PRs requesting my review
const q = (s: string) => octokit.rest.search.issuesAndPullRequests({ q: s, sort: 'updated', order: 'desc', per_page: 50, advanced_search: 'true' });
const assigned  = await q('is:open is:issue assignee:@me');
const mentioned = await q('is:open mentions:@me');
const reviewReq = await q('is:open is:pr review-requested:@me');   // or user-review-requested:@me

// Failing checks on my open PRs
const mine = await q('is:open is:pr author:@me');
for (const pr of mine.data.items) {
  const [owner, repo] = pr.repository_url.split('/').slice(-2);
  const { data: prFull } = await octokit.rest.pulls.get({ owner, repo, pull_number: pr.number });
  const { data: checks } = await octokit.rest.checks.listForRef({ owner, repo, ref: prFull.head.sha, filter: 'latest', per_page: 100 });
  const failing = checks.check_runs.filter(c => c.conclusion && ['failure','timed_out','cancelled','action_required'].includes(c.conclusion));
  // id: `${repo}#${pr.number}:${check.id}:${check.completed_at}`
}
// Recent commits: octokit.rest.repos.listCommits({ owner, repo, since: cursorIso, per_page: 100 }) -> id = sha
```

Caveats [verified where noted]: search API is 30 req/min authenticated and results are eventually consistent; GitHub cut legacy issue search over to *advanced search* in 2025 (changelog said Sept 4, 2025; a docs PR said Nov 4, 2025) — `advanced_search` is still accepted but now the default, and spaces between `repo:`/`org:`/`user:` qualifiers mean AND. Octokit's types say GitHub App user tokens must include `is:issue`/`is:pr`; always include one. Core REST is 5,000 req/h; notifications polling with `If-Modified-Since` is effectively free. Checks API needs `Checks: read` on fine-grained tokens; commit status (older CI) is `repos.getCombinedStatusForRef`.

**Dedupe IDs:** notification `id` + `updated_at` (a thread's id is stable, re-notifies bump `updated_at`); issues/PRs by `node_id` or `html_url` + `updated_at`; check runs by `id`; commits by `sha`.

**`gh` CLI equivalents** (uses its own stored auth; handy for prototyping):

```sh
gh api notifications --paginate -H 'If-Modified-Since: <last-modified>'
gh api -X PATCH notifications/threads/<id>                      # mark read
gh search issues --assignee=@me --state=open --json number,title,url,updatedAt
gh search issues --mentions=@me --state=open --json url,title
gh search prs --review-requested=@me --state=open --json url,title,repository
gh pr list --author @me --state open --json number,url,statusCheckRollup
gh pr checks <num> --repo owner/repo --json name,state,link
gh api 'repos/{owner}/{repo}/commits?since=2026-11-01T00:00:00Z'
```

## 4. Local documents (watch + extract)

```ts
import { watch } from 'chokidar';                       // v5/v6: ESM-only, no globs (removed in v4) - filter with `ignored`
const w = watch(['/home/me/Notes', '/home/me/Inbox'], { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 100 },
  ignored: (p) => /(^|\/)(\.git|node_modules|\.obsidian)(\/|$)/.test(p), depth: 6 });
w.on('add', onFile).on('change', onFile).on('unlink', p => mark(p, 'deleted'));
```

Extraction: `.md/.txt` -> read directly; `.docx` -> `const { value } = await mammoth.extractRawText({ path })`; `.pdf` -> `pdf-parse` v2:

```ts
import { PDFParse } from 'pdf-parse';
const parser = new PDFParse({ data: await readFile(path) });   // v2 class API; v1 was `pdf(buffer)` - pin `pdf-parse@1` for that
const { text } = await parser.getText(); await parser.destroy();
```

For everything else (pptx, xlsx, html, images with OCR) shell out to Microsoft's `markitdown` (`pipx install 'markitdown[all]'`; `markitdown file.pptx > out.md`) via `execFile`. **Dedupe:** key = absolute path; change detection = `size + mtimeMs` first, then SHA-256 of contents (store the hash, skip unchanged). Watching alone is not a cursor: on daemon start also run a reconciliation scan (`mtime > lastScan`), since events are missed while down. Use polling backend on network/FUSE mounts.

## 5. Local git repositories (`simple-git` 4)

```ts
import { simpleGit } from 'simple-git';          // v4: only named export; abbreviated long options now throw; env vars filtered
export async function pollRepo(dir: string) {
  const git = simpleGit(dir);
  await git.fetch(['--prune']).catch(() => {});                       // optional; needs network/creds
  const st = await git.status();                                      // { current, tracking, ahead, behind, modified, not_added, staged, conflicted, isClean() }
  const unpushed = st.tracking ? Number((await git.raw(['rev-list', '--count', '@{upstream}..HEAD'])).trim()) : null;
  const stale = (await git.raw(['for-each-ref', '--format=%(refname:short) %(committerdate:unix) %(upstream:track)', 'refs/heads'])).trim().split('\n')
    .map(l => { const [name, ts, track] = l.split(' '); return { name, ageDays: (Date.now() / 1000 - +ts) / 86400, track: track ?? '' }; })
    .filter(b => b.ageDays > 30 || b.track.includes('gone'));
  const head = (await git.revparse(['HEAD'])).trim();
  return { id: `${dir}@${head}:${st.files.length}:${unpushed}`, payload: { dirty: !st.isClean(), files: st.files.length, unpushed, stale, branch: st.current } };
}
```

Plain `child_process.execFile('git', [...], { cwd })` works just as well and avoids the dependency. Caveats: enumerate repos with a config list or `find ~/code -maxdepth 3 -name .git`; skip repos with `.git/index.lock`; `fetch` may hang on SSH passphrase prompts — set `GIT_TERMINAL_PROMPT=0` (simple-git 4 filters ambient env; pass it via `simpleGit({ baseDir, ... }).env({...})`). Emit an item only when the state hash changes (dirty-for-2-days nag, not every tick).

## 6. Slack (optional)

**Setup burden:** api.slack.com/apps > Create app (from scratch) > OAuth & Permissions > add **User Token Scopes** `channels:history`, `groups:history`, `im:history`, `mpim:history`, `channels:read`, `users:read`, `search:read` > Install to workspace > copy `xoxp-...`. Workspace admins may require app approval.

```ts
import { WebClient } from '@slack/web-api';
const slack = new WebClient(process.env.SLACK_USER_TOKEN);
const hist = await slack.conversations.history({ channel: 'C0123', oldest: cursorTs, limit: 100, inclusive: false }); // cursor = max message.ts
const hits = await slack.search.messages({ query: 'to:@me OR @me -from:@me', sort: 'timestamp', sort_dir: 'desc', count: 50 }); // user token only
```

Dedupe by `channel + ts` (the `ts` is the message ID). Rate limits: `search.messages` is Tier 2 (~20/min); `conversations.history` was Tier 3 (~50/min), **but** Slack's May 2025 change limits `conversations.history`/`replies` to **1 request/min and 15 messages per call** for non-Marketplace *distributed* apps (new apps immediately; existing installs reportedly from 2026-03-03). Slack states internal, customer-built apps keep existing limits — a single-workspace personal app should be unaffected, but verify on your workspace. Prefer `search.messages` for "mentions of me" over crawling channels.

## 7. Telegram Bot API (primary HITL channel)

**User setup (2 minutes):** message `@BotFather` > `/newbot` > copy token (`123456:ABC-...`). Open the bot and press *Start* (bots cannot DM first). Get your numeric `chat_id` from the first incoming update (or `@userinfobot`). Hard-code an allowlist of user IDs in config — anyone who finds the bot can otherwise send commands. Optionally `/setprivacy` is irrelevant for DMs.

**Library choice:** `grammy` 1.46 (stable API, plugins, good TS). `node-telegram-bot-api` 2.x (Aug 2026) is a complete rewrite with a grammY-like `Bot`/`ctx`/`InlineKeyboardBuilder` API; every pre-2026 tutorial for it (`new TelegramBot(token, { polling: true })`, `bot.onText`) targets 1.x/0.x — pin `node-telegram-bot-api@1.1.2` if you want that.

```ts
import { Bot, InlineKeyboard } from 'grammy';
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
const ALLOWED = new Set([Number(process.env.TELEGRAM_CHAT_ID)]);
bot.use(async (ctx, next) => { if (ctx.from && ALLOWED.has(ctx.from.id)) await next(); });

export async function askApproval(chatId: number, proposalId: string, text: string) {
  const kb = new InlineKeyboard().text('Approve', `ap:${proposalId}`).text('Reject', `rj:${proposalId}`).row().text('Edit', `ed:${proposalId}`);
  const m = await bot.api.sendMessage(chatId, text, { reply_markup: kb, parse_mode: 'HTML' }); // text <= 4096 chars
  return m.message_id; // store (proposalId -> message_id) to edit later
}
bot.callbackQuery(/^(ap|rj|ed):(.+)$/, async ctx => {
  const [, action, id] = ctx.match;                                     // callback_data is 1-64 bytes: put an ID, not payload
  await ctx.answerCallbackQuery({ text: 'Got it' });                    // must answer promptly or the client shows a spinner
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });        // disable buttons -> idempotent, no double-approve
  if (action === 'ed') { pending.set(ctx.from.id, id); await ctx.reply('Send the edited text:', { reply_markup: { force_reply: true } }); return; }
  await decide(id, action === 'ap' ? 'approved' : 'rejected', ctx.from.id);
});
bot.on('message:text', async ctx => { const id = pending.get(ctx.from.id); if (id) { pending.delete(ctx.from.id); await decide(id, 'edited', ctx.from.id, ctx.message.text); } });
bot.catch(err => log.error(err));
bot.start({ drop_pending_updates: false, onStart: () => log.info('polling') });  // long polling (getUpdates); no public URL needed
```

Long polling vs webhook: long polling is the default for a daemon behind NAT (grammY uses `getUpdates` with a 30 s timeout; `@grammyjs/runner` for concurrency). Webhook needs a public HTTPS URL (`bot.api.setWebhook({ url, secret_token })` + `webhookCallback(bot, 'express')`); use it only if you already run a server. Limits [from Telegram docs, unverified exact]: ~30 messages/s overall, 1/s per chat, 20/min per group; `editMessage*` counts too. Updates are retried until acknowledged, so **persist the decision before answering** (or make `decide` idempotent by proposal ID). Dedupe inbound by `update_id`; outbound HITL prompts by `proposalId` (never resend; edit the existing message).

## 8. Push alternatives and desktop notifications

**ntfy.sh** [verified against ntfy docs]: no account needed; topic name = password (use a long random one, or self-host with `Authorization: Bearer tk_...`/Basic). Install the ntfy app, subscribe to the topic.

```ts
await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` }, // JSON goes to the root, topic in body
  body: JSON.stringify({ topic, title: 'Approve reply to Alice?', message: draft, priority: 4, tags: ['email'], click: 'https://mail.google.com',
    actions: [ { action: 'http', label: 'Approve', url: `${api}/decide/${id}/approve`, method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, clear: true },
               { action: 'http', label: 'Reject',  url: `${api}/decide/${id}/reject`,  method: 'POST', clear: true },
               { action: 'view', label: 'Open', url: `${webUrl}/${id}` } ] }) });
```

Max **3** action buttons (`view`, `http`, `broadcast`); header form: `Actions: http, Approve, https://..., method=POST, clear=true; view, Open, https://...`. `http` actions need an endpoint reachable from the phone (so ntfy is great for *notify*, weaker for *decide* unless you expose an API — Tailscale Funnel/Cloudflare Tunnel). ntfy.sh limits: message <= 4,096 bytes, title <= 1 KB, 60-request burst refilled 1 per 5 s, **250 messages/day**, 2 MB attachments. Markdown via `markdown: true`.

**Pushover:** `POST https://api.pushover.net/1/messages.json` form fields `token` (app), `user` (user key), `message`, `title`, `url`, `url_title`, `priority` (2 = emergency, needs `retry`/`expire`), `sound`. Free quota is 10,000 messages/month — **per account** since 2026-05-01 (previously per app). One-time client purchase per platform [unverified price]. No inline action buttons (only one `url`), so it is notify-only. `pushover-notifications` 1.2.3 wraps this; plain `fetch` is fine.

**Desktop one-liners:**

```sh
osascript -e 'display notification "Draft ready for review" with title "Inbox agent" subtitle "Alice" sound name "Ping"'   # macOS
notify-send -u critical -a inbox-agent "Inbox agent" "Draft ready for review"                                                # Linux (libnotify)
```

`node-notifier` 12.1.0 wraps both but its engine field demands Node >=22.22/24.15; `execFile('osascript', [...])` avoids the dependency. macOS notifications from a launchd agent work; from an SSH session they don't.

## 9. Scheduling, daemonizing, crash recovery

**In-process scheduler:** `croner` 11 — `new Cron('*/2 * * * *', { protect: true, timezone: 'Europe/Amsterdam', catch: (e) => log.error(e), name: 'imap' }, () => pollImap())`; `protect` skips overlapping runs; `job.nextRun()`, `pause()/resume()/stop()`; 5/6/7-field patterns, Date or ISO string for one-shots. `node-cron` 4 — `cron.schedule('*/2 * * * *', fn, { noOverlap: true, timezone, name })` with `task.getStatus()/getNextRun()` and events (`execution:overlap`, `execution:failed`). Either is fine; `croner` is lighter and dependency-free. Rather than cron, a self-rescheduling loop per source (`setTimeout(run, pollSec*1000)` after each run, with jitter and backoff on error) adapts to `X-Poll-Interval` and avoids pile-ups.

**Run as a daemon.** `pm2`: `pm2 start dist/main.js --name perception --time && pm2 save && pm2 startup` (prints the OS-specific command). `systemd --user` (`~/.config/systemd/user/perception.service`, then `systemctl --user enable --now perception` and `loginctl enable-linger $USER` so it runs without a login session):

```ini
[Unit]
Description=Perception daemon
After=network-online.target
[Service]
WorkingDirectory=%h/agentic-inbox
ExecStart=/usr/bin/node --enable-source-maps dist/main.js
EnvironmentFile=%h/.config/agentic-inbox/.env
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
```

`launchd` (`~/Library/LaunchAgents/com.example.perception.plist`; `launchctl bootstrap gui/$(id -u) <plist>`; `launchctl kickstart -k gui/$(id -u)/com.example.perception` to restart):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.perception</string>
  <key>ProgramArguments</key><array><string>/opt/homebrew/bin/node</string><string>dist/main.js</string></array>
  <key>WorkingDirectory</key><string>/Users/me/agentic-inbox</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string><key>CONFIG_PATH</key><string>/Users/me/.config/agentic-inbox/config.yaml</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/me/Library/Logs/perception.log</string>
  <key>StandardErrorPath</key><string>/Users/me/Library/Logs/perception.err</string>
</dict></plist>
```

**Crash recovery patterns:**
- SQLite in WAL mode with `synchronous=NORMAL`; one write transaction per poll that inserts items *and* advances the cursor (section 0). Back up with `db.backup(path)` daily.
- Cursors are *resume points*, not *dedupe*: after a crash you re-fetch from the last cursor and `INSERT OR IGNORE` on `(source, external_id)` drops repeats. Make every downstream action idempotent by item/proposal ID (an `actions` table with `UNIQUE(proposal_id, action)`).
- HITL prompts: store `proposal -> {chat_id, message_id, status}`; on restart, don't resend; a decision arriving for a proposal already decided is a no-op.
- Process level: `process.on('unhandledRejection', ...)` -> log and exit non-zero (let the supervisor restart); handle `SIGTERM` by stopping the bot/scheduler and closing SQLite; a lock file (`proper-lockfile` or `O_EXCL` pid file) prevents two daemons polling the same mailbox.
- Each source gets its own timer and error budget (exponential backoff capped at 30 min); one failing source must not block the others.

## Day-1 minimal viable sensor set

Works with four secrets and zero OAuth: **IMAP app password** (INBOX, UID cursor, 2-min poll), **calendar ICS URL** (next 7 days, 10-min poll, snapshot diff), **GitHub PAT** (notifications with `If-Modified-Since` at `X-Poll-Interval`; assigned/review-requested searches every 5 min; failing checks on own PRs), **Telegram bot token + chat_id** (Approve/Reject/Edit inline keyboard, long polling, user-ID allowlist). Add local git + chokidar docs next (no credentials at all), then ntfy as a secondary notify-only channel; Slack and the Google APIs last.

## Config schema example

`~/.config/agentic-inbox/config.yaml` (non-secret) + `.env` (secrets), both `chmod 600`; refuse to start if `(stat.mode & 0o077) !== 0`. Validate with `zod`.

```yaml
# config.yaml
timezone: Europe/Amsterdam
state_db: ~/.local/state/agentic-inbox/state.db
sources:
  imap:     { enabled: true, host: imap.gmail.com, port: 993, user: me@gmail.com, mailbox: INBOX, poll_seconds: 120, pass_env: IMAP_APP_PASSWORD }
  smtp:     { host: smtp.gmail.com, port: 465, user: me@gmail.com, pass_env: IMAP_APP_PASSWORD }
  calendar: { enabled: true, horizon_days: 7, poll_seconds: 600, urls_env: CALENDAR_ICS_URLS }   # comma-separated secret URLs
  github:   { enabled: true, token_env: GITHUB_TOKEN, searches: ['is:open is:issue assignee:@me', 'is:open is:pr review-requested:@me'], poll_seconds: 300 }
  git:      { enabled: true, repos: [~/code/agentic-inbox, ~/code/other], stale_days: 30, poll_seconds: 900 }
  docs:     { enabled: false, paths: [~/Notes], extensions: [md, pdf, docx] }
  slack:    { enabled: false, token_env: SLACK_USER_TOKEN, channels: [] }
channels:
  telegram: { enabled: true, token_env: TELEGRAM_BOT_TOKEN, chat_id: 123456789, allowed_user_ids: [123456789] }
  ntfy:     { enabled: false, server: https://ntfy.sh, topic_env: NTFY_TOPIC, token_env: NTFY_TOKEN }
  pushover: { enabled: false, app_token_env: PUSHOVER_APP_TOKEN, user_key_env: PUSHOVER_USER_KEY }
  desktop:  { enabled: true }
```

```sh
# .env  (chmod 600)
IMAP_APP_PASSWORD=abcd efgh ijkl mnop
CALENDAR_ICS_URLS=https://calendar.google.com/calendar/ical/.../private-.../basic.ics
GITHUB_TOKEN=ghp_...
TELEGRAM_BOT_TOKEN=123456:ABC...
NTFY_TOPIC=inbox-9f3a7c1e2b
```

```ts
import { z } from 'zod';
const Src = z.object({ enabled: z.boolean().default(false), poll_seconds: z.number().int().min(30).default(300) });
export const Config = z.object({
  timezone: z.string(), state_db: z.string(),
  sources: z.object({
    imap: Src.extend({ host: z.string(), port: z.number().default(993), user: z.string(), mailbox: z.string().default('INBOX'), pass_env: z.string() }),
    calendar: Src.extend({ horizon_days: z.number().default(7), urls_env: z.string() }),
    github: Src.extend({ token_env: z.string(), searches: z.array(z.string()) }),
    git: Src.extend({ repos: z.array(z.string()), stale_days: z.number().default(30) }),
  }).partial(),
  channels: z.object({ telegram: z.object({ enabled: z.boolean(), token_env: z.string(), chat_id: z.number(), allowed_user_ids: z.array(z.number()).min(1) }) }).partial(),
});
```

Resolve every `*_env` key from `process.env` at startup (populated by `dotenv` or the service manager's `EnvironmentFile`), never store the secret in YAML, and keep the state DB out of any synced folder.
