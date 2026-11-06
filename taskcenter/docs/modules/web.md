# web — dashboard SPA (`web/`)

Owner: agent D. Vite 7 + React 19 + TypeScript, no UI framework, plain CSS with variables (light/dark via `prefers-color-scheme`). Deps: `react`, `react-dom`; dev: `vite`, `@vitejs/plugin-react`, `typescript`, `@types/react*`.

```
cd taskcenter
npm run build:web            # = npm --prefix web run build → web/dist (served by src/server at /)
npm --prefix web run dev     # Vite on :4801, proxies /api → http://127.0.0.1:4800 (override with TC_API)
```

`npm run build` runs `tsc --noEmit` first, then `vite build`. Output: `web/dist/index.html` + hashed `assets/*`.

## Layout

- Desktop: left nav (总览 / 收件箱 / 待确认 / 任务 / 运行 / 事件日志 / 交付物 / 记忆与上下文 / 状态) with live counts (inbox new, pending approvals, running+ready tasks, running runs); header with page title, today's budget bar (spend/limit), executor state (running n/concurrency or 已暂停) and the SSE live dot.
- ≤ 900 px (iOS): nav collapses into a horizontally scrolling top bar, header keeps only the budget meter and the two dots, grids become single column, `hide-mobile` columns drop out of tables, drawers go full width.

## Source map (`web/src/`)

| File | Role |
|---|---|
| `main.tsx` | mounts `<ToastProvider><LiveProvider><App/></LiveProvider></ToastProvider>` |
| `App.tsx` | shell (nav, header) + hash-route switch |
| `router.ts` | hash router: `useRoute()` → `{path, parts, query}`, `navigate()`, `href()` |
| `api.ts` | `api/get/post/patch/del` fetch wrapper (`Authorization: Bearer` from `localStorage.tc_token`), `ApiError`, `qs()`, `useApi(fn, deps)` hook (`data/error/loading/reload`), `artifactDownloadUrl()` |
| `sse.tsx` | `LiveProvider` (single `EventSource` on `/api/events/stream`, exponential reconnect), `useLive(kinds|"all", cb, debounceMs)` for debounced refreshes, `useLiveEvents(cb)` for raw events, `useLiveStatus()` |
| `toast.tsx` | `useToast()` → `success/error/info/run(fn, {ok, fail})` optimistic feedback |
| `labels.ts` | zh-CN maps: task/run/inbox/approval statuses, kinds, levels (L1–L5 with descriptions), categories, event types, artifact types, memory kinds, sources, decisions |
| `format.ts` | `relTime` (Intl.RelativeTimeFormat zh-CN), `fmtDate/DateTime/Time`, `money`, `duration`, `tokens`, `bytes`, `pct`, `shortId`, `pretty` |
| `types.ts` | hand-mirrored domain types from `src/core/types.ts` + API response shapes |
| `components/ui.tsx` | badges (`TaskStatusBadge`, `RunStatusBadge`, `InboxStatusBadge`, `KindBadge`, `ApprovalStatusBadge`, `PriorityBadge`, `RiskBadge`, `LevelBadge` with level_reason tooltip), `Button` (async-aware spinner), `PageHeader`, `Card`, `Empty`, `Loading`, `KV`, `Tabs`, `Select`, `Link`, `Drawer`, `Modal`, `JsonView`, `TextBlock` (tiny markdown-ish renderer: headings, bullets, code fences, inline code/bold, auto-links), `Meter`, `Dot` |
| `components/Timeline.tsx` | event timeline: day dividers, per-type icons, expandable tool_call input / tool_result output, assistant messages, status changes (from → to), human notes highlighted, errors in red; `sortChrono()` keeps same-millisecond events in `payload.seq` order |
| `components/ApprovalCard.tsx` | full and compact approval cards; `PayloadView` renders Bash commands as a shell block, email payloads as to/cc/subject/body, else JSON; option buttons (approve/edit/reject/custom/respond), note field, JSON editor for `edit` |
| `pages/Overview.tsx` | count tiles, pending approvals with 批准/拒绝, active tasks, recent events |
| `pages/Inbox.tsx` | filter by status/kind, table (kind, priority, L-badge, title/summary, source, suggested action, status, row actions), detail drawer with source signals, promote modal (level/priority/title/ready), snooze 1/3/7 d, dismiss, done, 快速记录 (capture) |
| `pages/Outbox.tsx` | 待处理 / 历史 tabs of `ApprovalCard`s |
| `pages/Tasks.tsx` | board (columns by status) / list toggle (remembered in localStorage), 新建任务 modal (`NewTaskModal`, also used for subtasks) |
| `pages/TaskDetail.tsx` | metadata, plan steps, subtasks with dependencies, runs table, timeline with 人工备注 (POST `/tasks/:id/events`), approvals, artifacts (open/download), result summary; actions: 立即运行 / 重试 / 规划 / 编辑·人工干预 (title, description, level, priority, owner, forced status, follow-up, reason) / 取消 |
| `pages/Runs.tsx` | `Runs` list with status filter; `RunDetail`: tool-call log, structured `AgentOutput`, cost/tokens/turns/duration/session id/error |
| `pages/Events.tsx` | filter by type/level/time, search box, auto-follow toggle fed by SSE |
| `pages/Artifacts.tsx` | list with type icons + preview drawer (markdown/text rendered, JSON pretty, links, download) |
| `pages/Memory.tsx` | memories (filter by kind, 归档 = retire, add form) + profile YAML from `/api/context` |
| `pages/Status.tsx` | executor/budget (30-day bars), config summary, schedules, sensor cursors, buttons 立即巡检 / 立即分诊 / 暂停·恢复执行器 / 唤醒, API token box |
| `styles.css` | tokens, shell, tables, badges, timeline, board, outbox cards, responsive rules |

## Live updates

Every page subscribes with `useLive([...kinds], reload)`; the callback is debounced (400 ms default) so bursts of events trigger one refetch. The Events page additionally appends raw `event` messages when auto-follow is on. The header counts refresh on any message.

## Auth

If the server has `server.token`, paste it in 状态 → API Token; it is stored as `localStorage.tc_token`, sent as `Authorization: Bearer` on every call and as `?token=` on the SSE stream and artifact downloads.

## Screenshots

`node --no-warnings=ExperimentalWarning --import tsx scripts/screenshot-dashboard.ts` builds an in-memory seeded context (`src/server/seed.ts`), serves `web/dist` on a free port and writes `docs/screenshots/<view>-{1280x800,390x844}.png` (+ `overview-dark-1280x800.png`) with Playwright. `--keep` leaves the server up.
