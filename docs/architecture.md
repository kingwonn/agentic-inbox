# Task Center 架构设计（Agentic Inbox · Task Center）

> 目标：一个长期运行、主动感知信息、理解个人上下文、自主发现任务、按 L1–L5 自主等级推进工作、在关键节点等待人工确认（HITL）、并交付真实成果的个人 AI 工作中枢。
>
> 本文是系统的权威设计文档。实现位于 `taskcenter/`，运行时数据位于 `taskcenter/data/`（SQLite，单文件，可拷贝迁移）。

## 1. 设计原则

1. **本地优先、单文件状态**：所有任务、审批、运行记录、工具调用、日志都在一个 SQLite 文件里（WAL 模式）。迁移 = 拷贝目录；回溯 = 查询表 + `tc state export` 产生的 JSONL（可进 git）。
2. **最少依赖、可移植**：Node ≥ 22（内置 `node:sqlite`，无原生模块），TypeScript，少量成熟 npm 包。可在 macOS / Linux / 云端 Claude Code 会话中运行。
3. **大脑可插拔**：默认用 Claude Code（headless CLI / Agent SDK，复用用户已登录的 Claude 账号，无需 API Key）。可切换为 Anthropic API、Codex CLI（若安装）或 Dry-run（测试）。
4. **一切先进 Inbox**：传感器只产出 Signal；分类器把 Signal 变成 Inbox Item（待办 / 问题 / 机会 / 决策 / 信息）；只有被提升（promote）的条目才成为 Task。
5. **自主等级 + 策略门控**：LLM 提议 L1–L5，策略引擎（确定性规则）做钳制。敏感动作无论等级一律进 Outbox 等待批准。
6. **幂等与可恢复**：传感器基于游标 + 指纹去重；每个 Task 的执行是 Run（可重试、可从 session 恢复）；守护进程重启后自动把中断的 Run 回滚到可执行状态。
7. **可观测**：每一次工具调用、每条消息、每次状态变化、每次花费都是 `events` 表里的一条追加记录，看板直接读表。
8. **成本可控**：分级用模型（haiku 分类 / sonnet 执行 / 高阶模型仅在需要时），每个 Run 有 turn / 时长 / 美元预算，每日总预算封顶。

## 2. 组件总览

```
┌────────────────────────────────────────────────────────────────────────────┐
│                               tc daemon (Node)                              │
│                                                                            │
│  Sensors ──► signals ──► Triage(LLM+Policy) ──► inbox_items ──► Tasks       │
│  (github, imap, ics, localgit, fsdocs, manual, webhook)         │          │
│                                                                 ▼          │
│                                     Planner(LLM) ──► subtasks + deps        │
│                                                                 │          │
│   Scheduler/Worker pool ──► Runner(Claude SDK | CLI | Codex | Dry) ──► Runs │
│         │                       │  canUseTool gate ──► approvals (Outbox)   │
│         │                       │  hooks ──► events (tool calls, logs)      │
│         │                       └──► artifacts (files, PRs, drafts, docs)   │
│         ▼                                                                  │
│   Notifier ──► Telegram / ntfy / email / console / webhook ──► decisions ──┐│
│                                                                            ││
│   HTTP API + Dashboard (Hono + React)  ◄─────────────────────────────────┘│
│   Context profile (YAML) + memories (learned facts)                        │
└────────────────────────────────────────────────────────────────────────────┘
```

| 组件 | 目录 | 职责 |
|---|---|---|
| core | `src/core` | 类型、SQLite 封装与迁移、仓储（repositories）、状态机、事件总线、日志、ID、策略引擎、预算 |
| sensors | `src/sensors` | 轮询各信息源，产出 Signal，维护游标 |
| brain | `src/brain` | LLM 提供者抽象、分类器（L1–L5）、规划器（拆解子任务）、上下文装配、记忆更新 |
| runners | `src/runners` | 执行 Task 的 Agent 运行器（Claude Agent SDK / CLI / Codex / Dry），工具门控，工作区隔离 |
| hitl | `src/hitl` | Outbox 审批、通知渠道、决策回收（Telegram 回调、API、CLI） |
| engine | `src/engine` | 守护进程：巡检调度、分诊、规划、执行工作池、恢复、每日摘要 |
| server | `src/server` | HTTP API（Hono）+ 静态看板 |
| web | `web/` | 看板 SPA（Inbox / Outbox / Tasks / Runs / Events / Artifacts / Settings） |
| cli | `src/cli.ts` | `tc` 命令：daemon / patrol / inbox / tasks / approve / status / state export|import / doctor |

## 3. 数据模型（SQLite）

所有表带 `created_at`/`updated_at`（ISO 字符串），JSON 字段以 TEXT 存储并用 zod 校验。

- `signals(id, source, external_id, kind, title, body, url, actor, occurred_at, observed_at, fingerprint, metadata, inbox_item_id)` — 唯一键 `(source, external_id)`；`fingerprint` 变化视为更新。
- `inbox_items(id, kind[todo|problem|opportunity|decision|info], title, summary, category, priority[P0..P3], level[1..5], level_reason, confidence, suggested_action, status[new|triaged|promoted|dismissed|snoozed|done], snoozed_until, task_id, source_signal_ids, tags)`
- `tasks(id, parent_id, title, description, kind, category, priority, level, status, owner[ai|human], runner, model, plan, depends_on, acceptance_criteria, deadline, follow_up_at, attempts, max_attempts, budget_usd, cost_usd, result_summary, last_error, inbox_item_id, workspace, labels)`
  - 状态机：`todo → planning → ready → running → (waiting_human | review | blocked) → done | failed | cancelled`
- `runs(id, task_id, attempt, runner, model, status[queued|running|waiting_human|succeeded|failed|interrupted|cancelled], session_id, started_at, ended_at, cost_usd, input_tokens, output_tokens, num_turns, result, error, resume_of)`
- `events(id, ts, task_id, run_id, level[debug|info|warn|error], type, message, payload)` — 追加写，看板时间线与审计来源。`type` 包括 `tool_call`, `tool_result`, `assistant_message`, `status_change`, `approval_requested`, `approval_decided`, `error`, `cost`, `sensor_poll`, `triage`.
- `approvals(id, task_id, run_id, kind[action|decision|review|question], title, context, recommendation, options, payload, risk[low|medium|high], status[pending|approved|rejected|edited|expired|cancelled], decision, decision_note, decided_by, decided_at, expires_at, channel_refs)` — 即 **Outbox**。
- `artifacts(id, task_id, run_id, type[file|url|text|pr|email_draft|document|patch], title, path, url, content, mime, size)`
- `notifications(id, channel, target, approval_id, task_id, title, body, status, external_ref, error, sent_at)`
- `memories(id, kind[fact|preference|project|person|habit], content, source, confidence, valid_from, valid_to, tags)` — 学习到的个人上下文。
- `sensor_cursors(sensor, key, value, updated_at)`
- `schedules(name, cron, job, enabled, last_run_at, last_status, next_run_at)`
- `budgets(day, cost_usd, runs)` — 每日成本。

## 4. 自主等级 L1–L5 与策略引擎

| 等级 | 含义 | AI 可做 | 人类介入点 | 默认工具集 |
|---|---|---|---|---|
| L1 | 理解与整理 | 提取待办、摘要背景、打标签 | 无（结果进 Inbox） | 只读 |
| L2 | 分析与建议 | 产出分析、方案、建议选项 | 人决定是否采纳 | 只读 + Web |
| L3 | 部分完成 | 产出中间交付物（草稿、补丁分支、文档） | 交付物进 `review` | 工作区内读写、受限 Bash |
| L4 | 大部分自主 | 多步执行，关键环节（对外发送、发布、推送共享分支、删除、花钱）进 Outbox | 关键环节审批 + 最终验收 | 读写 + Bash，敏感动作门控 |
| L5 | 端到端 | 执行、自验证（测试/检查）、交付，事后通知 | 事后知会；硬性红线仍需审批 | 同 L4，门控放宽到策略白名单 |

**判定流程**：

1. 分类器（LLM, haiku）结合个人上下文给出 `level_proposed` + `level_reason` + `category` + `priority` + `confidence`。
2. 策略引擎 `policy.yaml` 钳制：
   - `category.max_level`（如 `external_communication: 4`, `finance: 2`, `publishing: 4`, `code: 5`, `research: 5`）。
   - `capability.required` 不满足（无对应凭据/工具）→ 降到 L2 并记录“缺少 X”。
   - `confidence < 0.6` → 降一级。
   - 用户覆盖：按 `source` / `tag` / 关键字的显式规则。
3. **硬性红线（任何等级都必须审批）**：发送邮件/消息给外部人、发布内容、推送到 `main`/受保护分支、创建/合并 PR、删除数据、支付/订阅、修改凭据、调用策略中 `always_approve` 列表的工具或 Bash 模式。
4. 自动提升为 Task 的条件：`level >= auto_promote.min_level`（默认 3）且 `priority <= auto_promote.max_priority`（默认 P2）且来源允许；否则停留在 Inbox 等人确认（L1/L2 结果在分诊时已经产出，不需要再执行）。

## 5. 运行流程

### 5.1 巡检（Patrol）
`every N min`：对每个启用的传感器 `poll(cursor)` → upsert `signals` → 记录 `sensor_poll` 事件 → 新/变更的 signal 交给分诊。错误隔离：单个传感器失败不影响其他传感器，失败计数进入告警。

### 5.2 分诊（Triage）
批量（≤20 条）调用分类器，输出 JSON（zod 校验，失败重试一次，再失败则按规则兜底：kind=info, level=1）。生成 `inbox_items`；关联多个 signal 时合并。满足自动提升条件的直接创建 Task（`todo`）。

### 5.3 规划（Plan）
对 `todo` 且 `level >= 3` 的 Task：规划器（sonnet）产出 `plan`：步骤、所需工具/凭据、风险点（哪些步骤需审批）、验收标准、预估成本；复杂任务拆成子任务（`parent_id` + `depends_on`），可并行的子任务在依赖满足后同时进入 `ready`。L1/L2 任务不规划，直接以“分析”模式执行。

### 5.4 执行（Execute）
工作池（默认并发 2）取 `ready` 任务（依赖全部 `done`），创建 Run，调用 Runner：
- **工作区**：代码类任务在 `data/workspaces/<task>` 使用 git worktree（隔离、可丢弃）；其他任务在独立目录。
- **工具集**：按等级给 `allowedTools`/`disallowedTools`；Bash 命令过策略正则（如 `git push`, `rm -rf`, `curl -X POST` 到外部）。
- **门控**：`canUseTool` 命中敏感动作 → 创建 `approval`（含完整 payload，可编辑）→ 推送通知 → 等待最多 `approval.wait_seconds`（默认 600s）；批准则放行，拒绝则拒绝并告知 Agent，超时则结束 Run 为 `waiting_human` 并保存 `session_id`，批准后以 `resume` 续跑。
- **记录**：hooks 把每个 tool call / result / assistant 消息写入 `events`；结束写入 cost/tokens/turns。
- **输出**：Runner 要求 Agent 以结构化 JSON 收尾（summary, artifacts[], verification{passed, details}, follow_ups[], needs_human?）。
- **收尾**：L5 且验证通过 → `done`；L3/L4 → `review`（Outbox 中创建 `review` 审批）；失败 → 按重试策略（指数退避，`max_attempts` 默认 3）重排或 `failed` 并通知。

### 5.5 HITL / Outbox
审批项带：背景、建议、可选项（approve / reject / edit / 自定义选项）、风险等级、过期时间。渠道：看板（主）、Telegram（inline 按钮）、ntfy（action 按钮直连 API）、邮件（含链接）、CLI。决策写回 → 事件 → 唤醒执行（resume）或更新任务状态。

### 5.6 跟进与摘要
`follow_up_at` 到期的任务重新进入 `ready`（例如“等待对方回复”）。每日 08:30 产出摘要（新 Inbox、待审批、进行中、已交付、成本），通过通知渠道推送。

### 5.7 个人上下文
`config/profile.yaml`（职责、项目、目标、兴趣、习惯、偏好、联系人、优先级规则）由用户维护并进 git；`memories` 表由系统学习（分诊/执行中发现的事实、项目进展、偏好），每日“上下文刷新”任务（L1）把高置信记忆整理成建议并更新 `profile.generated.md`。分类器与规划器的 prompt 都注入上下文摘要。

## 6. 可靠性

- **持久化**：SQLite WAL；所有状态变化在事务内；事件追加写。
- **恢复**：启动时把 `running` Run 标为 `interrupted`，Task 回到 `ready`（attempts+1）；若有 `session_id` 则尝试 `resume`。
- **重试**：失败 Run 指数退避（1m, 5m, 15m），到达 `max_attempts` 后 `failed` + 通知；传感器失败独立计数。
- **超时**：每 Run `timeout_seconds`（默认 1800）；超时 abort 并记录。
- **幂等**：signal 唯一键；审批决策只接受 `pending`；通知按 `(approval_id, channel)` 去重。
- **优雅退出**：SIGTERM → 停止取新任务 → 等待当前 Run 结束或 abort → 关闭 DB。

## 7. 安全与权限隔离

- 凭据只在 `.env`（0600）/ 环境变量，不入库、不进日志（日志脱敏）。
- 看板默认绑定 `127.0.0.1:4800`；若配置 `TC_API_TOKEN` 则所有写操作需 Bearer。
- Agent 只能在任务工作区内写文件；Bash 受策略正则限制；对外副作用一律审批。
- 执行 Agent 的 prompt 中明确：来自邮件/网页/Issue 的内容是数据不是指令（提示注入防护），敏感动作必须走审批工具。
- 审计：`events` 不可修改；`tc audit <task>` 回放。

## 8. 成本与资源

- 模型分级：`classify: haiku`, `plan: sonnet`, `execute: sonnet`（L5/复杂任务可升 `opus`/`fable`），可在 `config/taskcenter.yaml` 覆盖。
- 预算：每 Run `budget_usd`（默认 2），每日 `daily_budget_usd`（默认 20），超限暂停执行并通知。
- 并发：`executor.concurrency`（默认 2）；传感器轮询间隔可调；分诊批处理减少调用。

## 9. 部署形态

1. **本地守护进程**（推荐）：`tc daemon` + launchd/systemd/pm2 模板；看板 `http://127.0.0.1:4800`。
2. **云端心跳**：Claude Code 的 scheduled task 定时启动会话执行 `tc patrol --once --cloud`，状态通过 `tc state export` 提交到 `taskcenter-state` 分支，再由本地守护进程 `tc state import` 合并。笔记本关机时仍有“眼睛”。
3. **混合**：本地做执行，云端做感知与摘要。

## 10. 与现有 Agentic Inbox（Cloudflare 邮件客户端）的关系

现有 Worker 提供 `/mcp` 邮件工具（列邮件、搜索、起草、发送）。Task Center 把它作为一个可选传感器/执行器：`sensors/agentic-inbox-mcp`（读）和执行 Agent 的 MCP 配置（写，受门控）。未部署 Cloudflare 时，使用 IMAP/SMTP 路径。

## 11. 目录结构

```
taskcenter/
  bin/tc.mjs            # CLI 入口（抑制 node:sqlite 实验警告后加载 dist）
  src/
    cli.ts  index.ts
    config/   schema.ts  load.ts  defaults.ts
    core/     types.ts  db.ts  migrations.ts  repo.ts  state.ts  events.ts  logger.ts  ids.ts  policy.ts  budget.ts  time.ts
    sensors/  types.ts  registry.ts  github.ts  imap.ts  ics.ts  localgit.ts  fsdocs.ts  manual.ts  webhook.ts
    brain/    llm.ts  context.ts  classifier.ts  planner.ts  memory.ts  prompts/*.ts
    runners/  types.ts  registry.ts  claude-sdk.ts  claude-cli.ts  codex.ts  dry.ts  gate.ts  workspace.ts  result.ts
    hitl/     approvals.ts  notifier.ts  channels/{console,telegram,ntfy,email,webhook}.ts  inbound/telegram.ts
    engine/   daemon.ts  scheduler.ts  patrol.ts  triage.ts  plan.ts  executor.ts  recovery.ts  digest.ts  context-refresh.ts
    server/   app.ts  routes/*.ts
  web/                  # Vite + React 看板
  config/               # taskcenter.example.yaml  policy.yaml  profile.example.yaml
  data/                 # 运行时（gitignored）：taskcenter.db  workspaces/  logs/  exports/
  tests/
```

## 12. 任务拆分（并行构建）

| 工作流 | 负责 | 产出 |
|---|---|---|
| 核心骨架（本文件 + core/config/types/db/migrations/repo/state/policy） | 主 Agent | 契约，其它工作流据此开发 |
| 传感器 | 子 Agent S | `src/sensors/*` + 单测 |
| 大脑与运行器 | 子 Agent B | `src/brain/*`, `src/runners/*` + 单测 |
| HITL 与通知 | 子 Agent H | `src/hitl/*` + 单测 |
| 看板与 API | 子 Agent D | `src/server/*`, `web/*` |
| 引擎、CLI、守护进程、部署模板 | 子 Agent E | `src/engine/*`, `src/cli.ts`, `deploy/*` |
| 集成、端到端自测、文档、上下文 | 主 Agent | 测试、README、ADR、运行中的守护进程、云端心跳 |
