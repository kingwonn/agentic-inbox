/**
 * Demo data + in-memory AppContext builder.
 *
 * `seedDemo(repo, bus)` fills a database with a realistic slice of task-center
 * state (signals, inbox, tasks with runs/events/tool calls, approvals, artifacts,
 * memories, schedules, budget) so the dashboard can be demoed and screenshotted
 * without any sensor or LLM. `createMemoryContext()` builds an AppContext around
 * an in-memory SQLite db with stub services; tests and `scripts/screenshot-dashboard.ts`
 * use it, and the CLI can reuse it for `tc demo`.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema, type Config } from "../config/schema.js";
import type { LoadedConfig } from "../config/load.js";
import type { AppContext, AppServices, ExecutorStatus } from "../core/app.js";
import { Budget } from "../core/budget.js";
import { openDb } from "../core/db.js";
import { Bus } from "../core/events.js";
import { silentLogger, type Logger } from "../core/logger.js";
import { Policy } from "../core/policy.js";
import { Repo } from "../core/repo.js";
import { transitionTask } from "../core/state.js";
import { dayKey, isoPlus } from "../core/time.js";
import type { Approval, Artifact, InboxItem, Memory, Run, Task } from "../core/types.js";
import type { InboundDecision } from "../hitl/types.js";

export interface SeedResult {
  inbox: InboxItem[];
  tasks: Task[];
  runs: Run[];
  approvals: Approval[];
  artifacts: Artifact[];
  memories: Memory[];
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Populate `repo` with demo data. Idempotent enough for demos (ids are fresh each call). */
export function seedDemo(repo: Repo, bus: Bus): SeedResult {
  return repo.transaction(() => seedInner(repo, bus));
}

function seedInner(repo: Repo, bus: Bus): SeedResult {
  // ── Signals ───────────────────────────────────────────────────────
  const sigPr = repo.signals.upsert({
    source: "github",
    external_id: "kingwonn/agentic-inbox#42",
    kind: "pull_request",
    title: "feat(mail): add IMAP IDLE support for the inbox sensor",
    body: "Adds a long-lived IMAP IDLE connection so new mail is picked up within seconds instead of on the 15 minute patrol.\n\nCloses #37. Review requested from @kingwonn.",
    url: "https://github.com/kingwonn/agentic-inbox/pull/42",
    actor: "octocat",
    occurred_at: ago(3 * HOUR),
    metadata: { repo: "kingwonn/agentic-inbox", number: 42, state: "open", review_requested: true },
  }).signal;
  const sigMail = repo.signals.upsert({
    source: "imap",
    external_id: "<a1b2c3@mail.example.com>",
    kind: "email",
    title: "Re: SparkAI 邮件渠道联调时间",
    body: "Kun 你好，\n\n下周二下午 3 点方便联调 SparkAI 的邮件渠道吗？需要你这边先把 MCP 的 send_email 工具权限打开。\n\n谢谢，\n李雷",
    actor: "lilei@example.com",
    occurred_at: ago(5 * HOUR),
    metadata: { from: "lilei@example.com", to: ["wkunwking@gmail.com"], has_question: true },
  }).signal;
  const sigCal = repo.signals.upsert({
    source: "ics",
    external_id: "evt-20261106-standup",
    kind: "event",
    title: "SparkAI weekly sync",
    body: "Agenda: email channel status, Q4 roadmap, hiring.\nLocation: Zoom",
    url: "https://zoom.us/j/123456",
    occurred_at: isoPlus(20 * HOUR),
    metadata: { starts_at: isoPlus(20 * HOUR), duration_minutes: 45 },
  }).signal;
  const sigGit = repo.signals.upsert({
    source: "localgit",
    external_id: "/home/user/agentic-inbox:uncommitted",
    kind: "uncommitted_changes",
    title: "agentic-inbox 有 7 个未提交的文件改动",
    body: "M src/mcp/tools.ts\nM src/worker.ts\n?? taskcenter/docs/\n…(4 more)",
    occurred_at: ago(50 * MIN),
    metadata: { repo: "/home/user/agentic-inbox", files: 7 },
  }).signal;
  const sigIssue = repo.signals.upsert({
    source: "github",
    external_id: "kingwonn/agentic-inbox#45",
    kind: "issue",
    title: "bug: MCP list_messages returns 500 when mailbox name contains a slash",
    body: "Steps: call list_messages with mailbox 'Clients/Acme'. Expected: messages. Actual: 500 Internal Error from the Worker.\n\nLikely the path segment is not encoded.",
    url: "https://github.com/kingwonn/agentic-inbox/issues/45",
    actor: "hanmeimei",
    occurred_at: ago(90 * MIN),
    metadata: { repo: "kingwonn/agentic-inbox", number: 45, labels: ["bug"] },
  }).signal;
  const sigHn = repo.signals.upsert({
    source: "manual",
    external_id: "manual:hn-mcp-mail",
    kind: "note",
    title: "HN 讨论：有人在找支持 MCP 的开源邮件客户端",
    body: "https://news.ycombinator.com/item?id=000000 — 楼主问有没有能接 Claude Code 的邮件工具，评论区没有好答案。可以介绍 agentic-inbox。",
    url: "https://news.ycombinator.com/item?id=000000",
    actor: "kingwonn",
    occurred_at: ago(2 * HOUR),
    metadata: {},
  }).signal;
  const sigNews = repo.signals.upsert({
    source: "imap",
    external_id: "<newsletter-9981@news.example.com>",
    kind: "email",
    title: "Cloudflare Workers changelog: Node.js compat v2, D1 read replicas",
    body: "This week in Workers: nodejs_compat_v2 is GA, D1 read replication public beta …",
    actor: "news@cloudflare.com",
    occurred_at: ago(26 * HOUR),
    metadata: { newsletter: true },
  }).signal;

  // ── Inbox ─────────────────────────────────────────────────────────
  const inbox: InboxItem[] = [];
  inbox.push(
    repo.inbox.create({
      kind: "todo",
      title: "审查 PR #42：IMAP IDLE 支持",
      summary: "octocat 请求你审查 agentic-inbox 的 PR #42（IMAP IDLE，关闭 #37）。改动集中在传感器层，含测试。建议先跑测试再做代码审查。",
      category: "code",
      priority: "P1",
      level: 3,
      level_proposed: 4,
      level_reason: "类别 code 允许 L4，但置信度 0.72 低于自动提升阈值，降为 L3",
      confidence: 0.72,
      suggested_action: "在工作区拉取 PR、运行测试、输出审查意见草稿",
      source_signal_ids: [sigPr.id],
      tags: ["github", "review"],
    }),
  );
  inbox.push(
    repo.inbox.create({
      kind: "decision",
      title: "李雷询问：下周二 15:00 联调 SparkAI 邮件渠道？",
      summary: "需要你确认时间，并提前打开 MCP send_email 工具权限。属于对外沟通，回复前需审批。",
      category: "external_communication",
      priority: "P1",
      level: 2,
      level_proposed: 3,
      level_reason: "对外沟通类别上限 L2",
      confidence: 0.88,
      suggested_action: "起草确认回复（含日历邀请），由你确认后发送",
      source_signal_ids: [sigMail.id, sigCal.id],
      tags: ["email", "sparkai"],
    }),
  );
  inbox.push(
    repo.inbox.create({
      kind: "info",
      title: "Cloudflare Workers 周报：nodejs_compat_v2 GA、D1 读副本",
      summary: "新闻简报，与 SparkAI 的 Worker 部署相关但不紧急。",
      category: "learning",
      priority: "P3",
      level: 1,
      level_proposed: 1,
      level_reason: "newsletter → P3，仅记录",
      confidence: 0.95,
      suggested_action: "收录到学习清单",
      source_signal_ids: [sigNews.id],
      tags: ["newsletter"],
    }),
  );
  inbox.push(
    repo.inbox.create({
      kind: "problem",
      title: "Issue #45：邮箱名含斜杠时 list_messages 返回 500",
      summary: "hanmeimei 报告 MCP 工具 list_messages 在邮箱名为 'Clients/Acme' 时返回 500，疑似路径段未编码。影响 SparkAI 邮件渠道。",
      category: "code",
      priority: "P1",
      level: 4,
      level_proposed: 4,
      level_reason: "code 类别允许 L4；修复范围小、可用测试验证",
      confidence: 0.86,
      suggested_action: "在 worktree 中复现、修复并开 PR（分支 tc/fix-45）",
      source_signal_ids: [sigIssue.id],
      tags: ["github", "bug", "sparkai"],
    }),
  );
  inbox.push(
    repo.inbox.create({
      kind: "opportunity",
      title: "HN 有人在找支持 MCP 的开源邮件客户端",
      summary: "你手动记录的线索：HN 帖子询问可接 Claude Code 的邮件工具，评论区无好答案。可以写一条简短介绍 agentic-inbox 的回复。",
      category: "publishing",
      priority: "P2",
      level: 2,
      level_proposed: 3,
      level_reason: "publishing 类别上限 L2：对外发布需审批",
      confidence: 0.7,
      suggested_action: "起草 HN 回复，由你确认后发布",
      source_signal_ids: [sigHn.id],
      tags: ["community"],
    }),
  );
  inbox.push(
    repo.inbox.create({
      kind: "problem",
      title: "agentic-inbox 有 7 个未提交改动已超过 24 小时",
      summary: "本地仓库存在未提交改动（src/mcp/tools.ts、src/worker.ts …），有丢失风险。",
      category: "ops",
      priority: "P2",
      level: 2,
      level_proposed: 2,
      level_reason: "默认级别",
      confidence: 0.8,
      suggested_action: "提醒提交或创建 WIP 分支",
      source_signal_ids: [sigGit.id],
      tags: ["git"],
      status: "snoozed",
      snoozed_until: isoPlus(24 * HOUR),
    }),
  );
  for (const it of inbox) for (const sid of it.source_signal_ids) repo.signals.update(sid, { inbox_item_id: it.id, triaged: 1 });

  // ── Tasks ─────────────────────────────────────────────────────────
  const tasks: Task[] = [];
  const runs: Run[] = [];

  // Task 1: done (research + writing)
  const tDone = repo.tasks.create({
    title: "整理 Claude Agent SDK 的 hooks 与 MCP 权限模型",
    description: "调研 Agent SDK 的 PreToolUse/PostToolUse hooks 与 canUseTool 回调，写一份面向本项目的接入笔记。",
    kind: "todo",
    category: "research",
    priority: "P2",
    level: 4,
    status: "done",
    plan: {
      goal: "产出一份 2 页的接入笔记，覆盖 hooks、权限回调与 MCP 工具注册",
      steps: [
        { id: "s1", title: "阅读官方文档与示例", done: true, tools: ["WebFetch"] },
        { id: "s2", title: "在 runners/claude-sdk.ts 中验证 hook 触发顺序", done: true, tools: ["Read", "Bash"] },
        { id: "s3", title: "写笔记并附代码片段", done: true, tools: ["Write"] },
      ],
      required_capabilities: ["web_fetch"],
      risks: ["文档版本与已安装 SDK 不一致"],
      acceptance_criteria: ["笔记包含可运行的最小示例", "覆盖 canUseTool 与 hooks 的差异"],
      estimated_cost_usd: 0.6,
    },
    acceptance_criteria: ["笔记包含可运行的最小示例"],
    attempts: 1,
    cost_usd: 0.42,
    result_summary: "已写入 docs/research/agent-sdk-hooks.md：hooks 用于审计/记录，canUseTool 用于门控；MCP 工具通过 mcpServers 注册并受 allowedTools 过滤。",
    started_at: ago(6 * HOUR),
    finished_at: ago(5 * HOUR),
    labels: ["sdk"],
  });
  tasks.push(tDone);
  const rDone = repo.runs.create({ task_id: tDone.id, runner: "claude-sdk", model: "sonnet", status: "succeeded", reason: "scheduled", session_id: "sess_7f3a9c" });
  repo.runs.update(rDone.id, {
    started_at: ago(6 * HOUR),
    ended_at: ago(5 * HOUR + 12 * MIN),
    cost_usd: 0.42,
    input_tokens: 48_210,
    output_tokens: 6_930,
    num_turns: 14,
    result_text: "完成。笔记已写入 docs/research/agent-sdk-hooks.md。",
    result: {
      summary: "完成接入笔记，覆盖 hooks / canUseTool / MCP 注册。",
      status: "done",
      artifacts: [{ type: "document", title: "agent-sdk-hooks.md", path: "docs/research/agent-sdk-hooks.md" }],
      verification: { passed: true, details: "示例代码在 node 22 下运行通过" },
      follow_ups: ["把 canUseTool 门控接到 runners/gate.ts"],
      learned: ["用户偏好先看代码示例再看说明"],
    },
  });
  runs.push(repo.runs.get(rDone.id)!);
  recordRunTimeline(bus, tDone, rDone.id, [
    { type: "run_started", message: "run started (claude-sdk / sonnet)" },
    { type: "assistant_message", message: "我先查阅 Agent SDK 文档中 hooks 与权限的章节。" },
    { type: "tool_call", message: "WebFetch", payload: { tool: "WebFetch", input: { url: "https://docs.anthropic.com/en/api/agent-sdk/overview" } } },
    { type: "tool_result", message: "WebFetch ok", payload: { tool: "WebFetch", ok: true, duration_ms: 1820, output: "…Agent SDK overview (12 KB)…" } },
    { type: "tool_call", message: "Read", payload: { tool: "Read", input: { file_path: "src/runners/types.ts" } } },
    { type: "tool_result", message: "Read ok", payload: { tool: "Read", ok: true, duration_ms: 12, output: "export interface Runner { … }" } },
    { type: "tool_call", message: "Write", payload: { tool: "Write", input: { file_path: "docs/research/agent-sdk-hooks.md", content: "# Agent SDK hooks\n…" } } },
    { type: "tool_result", message: "Write ok", payload: { tool: "Write", ok: true, duration_ms: 5 } },
    { type: "assistant_message", message: "笔记已完成，包含最小示例与差异对比表。" },
    { type: "cost", message: "cost $0.42 (48.2k in / 6.9k out, 14 turns)", payload: { cost_usd: 0.42, input_tokens: 48_210, output_tokens: 6_930, num_turns: 14 } },
    { type: "run_finished", message: "run succeeded" },
  ]);
  repo.budgets.add(dayKey(new Date(Date.now() - 6 * HOUR)), 0.42, 1);

  // Task 2: running (code) with a subtask tree
  const tRun = repo.tasks.create({
    title: "审查 PR #42 并运行测试：IMAP IDLE 支持",
    description: "拉取 kingwonn/agentic-inbox#42 到工作区，运行测试，给出审查意见草稿（不直接提交评论）。",
    kind: "todo",
    category: "code",
    priority: "P1",
    level: 3,
    status: "running",
    inbox_item_id: inbox[0].id,
    plan: {
      goal: "完成 PR #42 的技术审查并产出评论草稿",
      steps: [
        { id: "s1", title: "检出 PR 分支到 worktree", done: true, tools: ["Bash"] },
        { id: "s2", title: "运行单元测试", done: true, tools: ["Bash"], needs_approval: false },
        { id: "s3", title: "阅读 diff，列出风险点", done: false, tools: ["Read", "Grep"] },
        { id: "s4", title: "撰写审查意见草稿", done: false, tools: ["Write"] },
      ],
      required_capabilities: ["github_token"],
      risks: ["IDLE 连接在网络抖动时可能泄漏"],
      acceptance_criteria: ["测试通过", "审查草稿含 3 条以上具体建议"],
      estimated_cost_usd: 0.9,
    },
    attempts: 1,
    cost_usd: 0.31,
    workspace: "data/workspaces/tsk-pr42",
    started_at: ago(25 * MIN),
    labels: ["github", "review"],
    context: { pr: "kingwonn/agentic-inbox#42", author: "octocat" },
  });
  tasks.push(tRun);
  repo.inbox.update(inbox[0].id, { status: "promoted", task_id: tRun.id });
  const rRun = repo.runs.create({ task_id: tRun.id, runner: "claude-sdk", model: "sonnet", status: "running", reason: "scheduled", session_id: "sess_b81e22" });
  repo.runs.update(rRun.id, { started_at: ago(25 * MIN), cost_usd: 0.31, input_tokens: 31_400, output_tokens: 2_210, num_turns: 9 });
  runs.push(repo.runs.get(rRun.id)!);
  recordRunTimeline(bus, tRun, rRun.id, [
    { type: "run_started", message: "run started (claude-sdk / sonnet)" },
    { type: "tool_call", message: "Bash", payload: { tool: "Bash", input: { command: "gh pr checkout 42" } } },
    { type: "tool_result", message: "Bash ok", payload: { tool: "Bash", ok: true, duration_ms: 4300, output: "Switched to branch 'feat/imap-idle'" } },
    { type: "tool_call", message: "Bash", payload: { tool: "Bash", input: { command: "npx vitest run tests/sensors*.test.ts" } } },
    { type: "tool_result", message: "Bash ok", payload: { tool: "Bash", ok: true, duration_ms: 12_800, output: " ✓ tests/sensors.test.ts (18 tests) 1.9s\n Test Files  1 passed (1)\n      Tests  18 passed (18)" } },
    { type: "assistant_message", message: "测试通过。接下来阅读 imap.ts 的 diff，关注 IDLE 重连与超时处理。" },
    { type: "tool_call", message: "Read", payload: { tool: "Read", input: { file_path: "src/sensors/imap.ts" } } },
    { type: "tool_result", message: "Read ok", payload: { tool: "Read", ok: true, duration_ms: 8, output: "(412 lines)" } },
  ]);
  const tSub1 = repo.tasks.create({
    title: "子任务：验证 IDLE 断线重连",
    description: "模拟网络中断，确认 IDLE 连接会在 30s 内重连且不重复投递。",
    parent_id: tRun.id,
    category: "code",
    priority: "P1",
    level: 3,
    status: "ready",
  });
  const tSub2 = repo.tasks.create({
    title: "子任务：撰写审查意见草稿",
    description: "综合测试与 diff 阅读结果，写出评论草稿。",
    parent_id: tRun.id,
    category: "writing",
    priority: "P1",
    level: 3,
    status: "blocked",
    depends_on: [tSub1.id],
  });
  tasks.push(tSub1, tSub2);

  // Task 3: waiting_human (external communication → approval)
  const tWait = repo.tasks.create({
    title: "回复李雷：确认下周二 15:00 联调并开通 send_email 权限",
    description: "起草确认邮件（中文），附日历邀请；发送前需要审批。",
    kind: "decision",
    category: "external_communication",
    priority: "P1",
    level: 2,
    status: "waiting_human",
    inbox_item_id: inbox[1].id,
    attempts: 1,
    cost_usd: 0.09,
    started_at: ago(40 * MIN),
    plan: {
      goal: "发出确认回复",
      steps: [
        { id: "s1", title: "起草回复", done: true, tools: ["Write"] },
        { id: "s2", title: "请求审批后发送", done: false, needs_approval: true, tools: ["mcp__taskcenter__request_approval"] },
      ],
      required_capabilities: ["smtp"],
      risks: ["对外沟通"],
      acceptance_criteria: ["邮件已发送"],
    },
  });
  tasks.push(tWait);
  repo.inbox.update(inbox[1].id, { status: "promoted", task_id: tWait.id });
  const rWait = repo.runs.create({ task_id: tWait.id, runner: "claude-sdk", model: "sonnet", status: "waiting_human", reason: "manual", session_id: "sess_c0ffee" });
  repo.runs.update(rWait.id, { started_at: ago(40 * MIN), ended_at: ago(36 * MIN), cost_usd: 0.09, input_tokens: 9_800, output_tokens: 1_100, num_turns: 4 });
  runs.push(repo.runs.get(rWait.id)!);
  recordRunTimeline(bus, tWait, rWait.id, [
    { type: "run_started", message: "run started (claude-sdk / sonnet)" },
    { type: "assistant_message", message: "已起草确认邮件，发送属于对外沟通，需要你的审批。" },
    { type: "approval_requested", message: "approval requested: 发送邮件给 lilei@example.com" },
    { type: "run_finished", message: "run parked: waiting_human" },
  ]);

  // Task 4: failed (ops)
  const tFail = repo.tasks.create({
    title: "为 agentic-inbox Worker 启用 nodejs_compat_v2 并部署预览",
    description: "修改 wrangler.toml 的 compatibility_flags，运行 wrangler deploy --env preview。",
    category: "ops",
    priority: "P2",
    level: 3,
    status: "failed",
    attempts: 3,
    max_attempts: 3,
    cost_usd: 0.27,
    last_error: "wrangler deploy failed: Authentication error [code: 10000] — CLOUDFLARE_API_TOKEN missing",
    started_at: ago(3 * HOUR),
    finished_at: ago(2 * HOUR),
  });
  tasks.push(tFail);
  const rFail = repo.runs.create({ task_id: tFail.id, runner: "claude-cli", model: "sonnet", status: "failed", reason: "retry", attempt: 3 });
  repo.runs.update(rFail.id, {
    started_at: ago(2 * HOUR + 10 * MIN),
    ended_at: ago(2 * HOUR),
    cost_usd: 0.11,
    input_tokens: 12_000,
    output_tokens: 900,
    num_turns: 5,
    error: "wrangler deploy failed: Authentication error [code: 10000] — CLOUDFLARE_API_TOKEN missing",
  });
  runs.push(repo.runs.get(rFail.id)!);
  recordRunTimeline(bus, tFail, rFail.id, [
    { type: "run_started", message: "run started (claude-cli / sonnet, attempt 3)" },
    { type: "tool_call", message: "Edit", payload: { tool: "Edit", input: { file_path: "wrangler.toml", old_string: 'compatibility_flags = ["nodejs_compat"]', new_string: 'compatibility_flags = ["nodejs_compat_v2"]' } } },
    { type: "tool_result", message: "Edit ok", payload: { tool: "Edit", ok: true, duration_ms: 3 } },
    { type: "tool_call", message: "Bash", payload: { tool: "Bash", input: { command: "npx wrangler deploy --env preview" } } },
    { type: "tool_result", message: "Bash failed", level: "warn", payload: { tool: "Bash", ok: false, duration_ms: 6100, output: "✘ [ERROR] A request to the Cloudflare API failed. Authentication error [code: 10000]" } },
    { type: "error", message: "wrangler deploy failed: Authentication error [code: 10000] — CLOUDFLARE_API_TOKEN missing", level: "error" },
    { type: "run_finished", message: "run failed (attempt 3/3)", level: "error" },
  ]);
  repo.budgets.add(dayKey(), 0.27 + 0.31 + 0.09, 3);
  for (let i = 1; i <= 6; i++) repo.budgets.add(dayKey(new Date(Date.now() - i * 24 * HOUR)), Math.round((0.8 + Math.sin(i) * 0.6 + 1) * 100) / 100, 2 + (i % 3));

  // Task 5: todo (manual)
  const tTodo = repo.tasks.create({
    title: "准备 SparkAI 周会材料：邮件渠道进展",
    description: "汇总本周邮件渠道的进展、阻塞与下一步，产出 1 页纪要草稿。",
    category: "writing",
    priority: "P2",
    level: 3,
    status: "todo",
    follow_up_at: isoPlus(12 * HOUR),
    labels: ["sparkai"],
  });
  tasks.push(tTodo);

  // ── Approvals ────────────────────────────────────────────────────
  const approvals: Approval[] = [];
  approvals.push(
    repo.approvals.create({
      task_id: tWait.id,
      run_id: rWait.id,
      kind: "action",
      title: "发送邮件给 lilei@example.com：确认联调时间",
      context: "李雷在 5 小时前来信询问下周二 15:00 是否方便联调 SparkAI 邮件渠道，并提到需要先开通 MCP send_email 权限。日历显示该时段空闲。",
      recommendation: "建议批准：时段空闲，内容仅确认时间与权限，无承诺。",
      options: [
        { value: "approve", label: "批准发送" },
        { value: "edit", label: "修改后发送" },
        { value: "reject", label: "拒绝" },
      ],
      payload: {
        tool: "mcp__email__send_email",
        input: {
          to: "lilei@example.com",
          subject: "Re: SparkAI 邮件渠道联调时间",
          body: "李雷你好，\n\n下周二（11/11）15:00 可以，我会提前把 MCP 的 send_email 工具权限打开，并把联调清单发给你。\n\n王坤",
        },
      },
      risk: "medium",
      expires_at: isoPlus(70 * HOUR),
    }),
  );
  approvals.push(
    repo.approvals.create({
      task_id: tRun.id,
      run_id: rRun.id,
      kind: "action",
      title: "执行 Bash：删除 worktree 中的 node_modules 并重装",
      context: "测试依赖版本与 lockfile 不一致，agent 想删除 node_modules 后重新 npm ci。该命令匹配策略中的 rm -rf 模式，需要审批。",
      recommendation: "建议批准：仅影响任务工作区（data/workspaces/tsk-pr42）。",
      payload: { tool: "Bash", input: { command: "rm -rf node_modules && npm ci" } },
      risk: "high",
      expires_at: isoPlus(71 * HOUR),
    }),
  );
  const aDecided = repo.approvals.create({
    task_id: tDone.id,
    run_id: rDone.id,
    kind: "question",
    title: "笔记用中文还是英文撰写？",
    context: "调研资料是英文，用户偏好语言是 zh-CN。",
    recommendation: "建议中文，代码片段保持英文。",
    options: [
      { value: "zh", label: "中文" },
      { value: "en", label: "English" },
    ],
    risk: "low",
  });
  repo.approvals.decide(aDecided.id, { status: "approved", decision: "zh", decision_note: "中文，术语保留英文", decided_by: "dashboard" });
  approvals.push(repo.approvals.get(aDecided.id)!);
  for (const a of approvals.slice(0, 2)) bus.emit("approval.requested", { approval_id: a.id, task_id: a.task_id });

  // ── Artifacts ────────────────────────────────────────────────────
  const artifacts: Artifact[] = [];
  artifacts.push(
    repo.artifacts.create({
      task_id: tDone.id,
      run_id: rDone.id,
      type: "document",
      title: "agent-sdk-hooks.md",
      path: "docs/research/agent-sdk-hooks.md",
      mime: "text/markdown",
      content:
        "# Agent SDK hooks 与权限模型\n\n## 结论\n\n- **hooks**（PreToolUse/PostToolUse）用于审计与记录，不能改变工具输入。\n- **canUseTool** 回调用于门控：可 `allow` / `deny` / 修改输入。\n- MCP 工具通过 `mcpServers` 注册，再受 `allowedTools` 过滤。\n\n```ts\nquery({ prompt, options: { canUseTool: async (name, input) => ({ behavior: 'allow', updatedInput: input }) } })\n```\n\n参考：https://docs.anthropic.com/en/api/agent-sdk/overview\n",
    }),
  );
  artifacts.push(
    repo.artifacts.create({
      task_id: tWait.id,
      run_id: rWait.id,
      type: "email_draft",
      title: "回复草稿：Re: SparkAI 邮件渠道联调时间",
      mime: "text/plain",
      content: "To: lilei@example.com\nSubject: Re: SparkAI 邮件渠道联调时间\n\n李雷你好，\n\n下周二（11/11）15:00 可以，我会提前把 MCP 的 send_email 工具权限打开，并把联调清单发给你。\n\n王坤",
    }),
  );
  artifacts.push(
    repo.artifacts.create({
      task_id: tRun.id,
      run_id: rRun.id,
      type: "url",
      title: "PR #42 on GitHub",
      url: "https://github.com/kingwonn/agentic-inbox/pull/42",
    }),
  );
  for (const a of artifacts) bus.record({ type: "artifact", task_id: a.task_id, run_id: a.run_id, message: `artifact: ${a.title}`, payload: { artifact_id: a.id, type: a.type } });

  // ── Memories ─────────────────────────────────────────────────────
  const memories: Memory[] = [
    repo.memories.create({ kind: "preference", content: "用户偏好先看代码示例再看说明文字；总结用中文，术语保留英文。", source: tDone.id, confidence: 0.85, tags: ["style"] }),
    repo.memories.create({ kind: "project", content: "SparkAI 的邮件渠道基于 agentic-inbox fork，MCP 工具 send_email 默认关闭，需要手动开通。", source: sigMail.id, confidence: 0.8, tags: ["sparkai"] }),
    repo.memories.create({ kind: "person", content: "李雷（lilei@example.com）是 SparkAI 的协作者，负责邮件渠道联调。", source: sigMail.id, confidence: 0.75, tags: ["sparkai"] }),
    repo.memories.create({ kind: "habit", content: "用户通常在 09:00–12:00 专注编码，不希望收到非紧急通知。", source: "user", confidence: 0.9, tags: ["schedule"] }),
  ];
  for (const m of memories) bus.record({ type: "memory", message: `memory: ${m.content.slice(0, 40)}`, payload: { memory_id: m.id, kind: m.kind } });

  // ── Schedules / cursors / notifications / misc events ────────────
  repo.schedules.upsert({ name: "patrol", cron: "*/15 * * * *", job: "patrol", last_run_at: ago(7 * MIN), last_status: "ok", next_run_at: isoPlus(8 * MIN) });
  repo.schedules.upsert({ name: "digest", cron: "30 8 * * *", job: "digest", last_run_at: ago(9 * HOUR), last_status: "ok", next_run_at: isoPlus(15 * HOUR) });
  repo.schedules.upsert({ name: "context_refresh", cron: "15 7 * * *", job: "context_refresh", last_run_at: ago(10 * HOUR), last_status: "ok", next_run_at: isoPlus(14 * HOUR) });
  repo.schedules.upsert({ name: "maintenance", cron: "45 3 * * *", job: "maintenance", last_run_at: ago(14 * HOUR), last_status: "error", last_error: "vacuum skipped: db busy", next_run_at: isoPlus(10 * HOUR) });
  repo.cursors.set("github", "notifications.since", ago(7 * MIN));
  repo.cursors.set("github", "search.updated", ago(7 * MIN));
  repo.cursors.set("imap", "uidnext", "10233");
  repo.cursors.set("localgit", "/home/user/agentic-inbox", ago(7 * MIN));
  repo.notifications.create({ channel: "telegram", target: "chat:123", approval_id: approvals[0].id, task_id: tWait.id, title: approvals[0].title, body: "需要审批", status: "sent", external_ref: "msg_991", error: null });
  repo.notifications.create({ channel: "console", target: null, approval_id: approvals[1].id, task_id: tRun.id, title: approvals[1].title, body: "需要审批", status: "sent", external_ref: null, error: null });
  bus.record({ type: "sensor_poll", message: "patrol: github 2 new, imap 1 new, localgit 1 changed", payload: { totalNew: 3, totalChanged: 1 } });
  bus.record({ type: "triage", message: "triage: 5 signals -> 4 inbox items (haiku, $0.01)", payload: { signalsTriaged: 5, inboxCreated: 4, costUsd: 0.01 } });
  bus.record({ type: "system", task_id: tTodo.id, message: "任务由人工创建", payload: { by: "human" } });

  // Make sure status_change events exist for the board (go through the state machine once).
  transitionTask(repo, bus, tTodo.id, "todo", { force: true });

  return { inbox: inbox.map((i) => repo.inbox.get(i.id)!), tasks: tasks.map((t) => repo.tasks.get(t.id)!), runs, approvals, artifacts, memories };
}

function recordRunTimeline(
  bus: Bus,
  task: Task,
  runId: string,
  items: Array<{ type: Parameters<Bus["record"]>[0]["type"]; message: string; payload?: Record<string, unknown>; level?: "debug" | "info" | "warn" | "error" }>,
) {
  let seq = 0;
  for (const it of items) {
    seq++;
    bus.record({ type: it.type, task_id: task.id, run_id: runId, message: it.message, level: it.level ?? "info", payload: { seq, ...(it.payload ?? {}) } });
  }
}

// ── In-memory AppContext ──────────────────────────────────────────

export interface MemoryContextOptions {
  config?: Partial<Config> & Record<string, unknown>;
  /** Directory that holds web/dist and config/ (defaults to the taskcenter root). */
  rootDir?: string;
  logger?: Logger;
  services?: Partial<AppServices>;
  dataDir?: string;
  /** Build the default stub services (default true). Set false to test 503 paths. */
  stubServices?: boolean;
}

export function taskcenterRoot(): string {
  return resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
}

/**
 * AppContext backed by an in-memory SQLite database with stub services that act
 * directly on the repo (no LLM, no runner). Suitable for tests, demos and screenshots.
 */
export function createMemoryContext(opts: MemoryContextOptions = {}): AppContext & { calls: Array<{ service: string; args: unknown[] }> } {
  const rootDir = opts.rootDir ?? taskcenterRoot();
  const config = ConfigSchema.parse({ timezone: "Asia/Shanghai", locale: "zh-CN", ...(opts.config ?? {}) });
  const loaded: LoadedConfig = {
    config,
    configPath: null,
    rootDir,
    resolve: (p: string) => (p.startsWith("/") ? p : resolve(rootDir, p)),
  };
  const db = openDb(":memory:");
  const repo = new Repo(db);
  const bus = new Bus(repo);
  const logger = opts.logger ?? silentLogger;
  const budget = new Budget(repo, config.brain.daily_budget_usd, config.timezone);
  const dataDir = opts.dataDir ?? loaded.resolve(config.data_dir);
  const calls: Array<{ service: string; args: unknown[] }> = [];
  const services: AppServices = opts.stubServices === false ? {} : createStubServices({ repo, bus, calls });
  Object.assign(services, opts.services ?? {});
  return {
    config,
    loaded,
    repo,
    bus,
    policy: Policy.default(),
    logger,
    budget,
    services,
    dataDir,
    startedAt: new Date().toISOString(),
    calls,
    async shutdown() {
      db.close();
    },
  };
}

/** Stub services that mutate the repo directly and log every call. */
export function createStubServices(deps: { repo: Repo; bus: Bus; calls?: Array<{ service: string; args: unknown[] }> }): AppServices {
  const { repo, bus } = deps;
  const calls = deps.calls ?? [];
  const log = (service: string, ...args: unknown[]) => calls.push({ service, args });
  let paused = false;
  let pauseReason: string | undefined;

  const executorStatus = (): ExecutorStatus => ({
    running: repo.runs
      .active()
      .filter((r) => r.status === "running")
      .map((r) => ({ task_id: r.task_id, run_id: r.id, started_at: r.started_at, title: repo.tasks.get(r.task_id)?.title ?? r.task_id })),
    concurrency: 2,
    paused,
    pauseReason,
  });

  return {
    approvals: {
      async request(input) {
        log("approvals.request", input);
        const a = repo.approvals.create(input);
        bus.emit("approval.requested", { approval_id: a.id, task_id: a.task_id });
        return a;
      },
      async waitForDecision(id) {
        return repo.approvals.get(id)!;
      },
      async decide(d: InboundDecision) {
        log("approvals.decide", d);
        const status = d.decision === "approve" ? "approved" : d.decision === "reject" ? "rejected" : d.decision === "edit" ? "edited" : "approved";
        const ok = repo.approvals.decide(d.approvalId, { status, decision: d.decision, decision_note: d.note, edited_payload: d.editedPayload, decided_by: d.decidedBy });
        const a = repo.approvals.get(d.approvalId);
        if (!a) throw new Error(`approval not found: ${d.approvalId}`);
        if (!ok) throw Object.assign(new Error("approval is not pending"), { status: 409 });
        bus.record({ type: "approval_decided", task_id: a.task_id, run_id: a.run_id, message: `approval ${d.decision} by ${d.decidedBy}`, payload: { approval_id: a.id, decision: d.decision } });
        bus.emit("approval.decided", { approval_id: a.id, task_id: a.task_id, decision: d.decision });
        return a;
      },
      pending: () => repo.approvals.pending(),
    },
    executor: {
      wake: (reason) => {
        log("executor.wake", reason);
        bus.wake(reason);
      },
      async retryTask(id) {
        log("executor.retryTask", id);
        return transitionTask(repo, bus, id, "ready", { reason: "retry requested", force: true });
      },
      async cancelTask(id, reason) {
        log("executor.cancelTask", id, reason);
        return transitionTask(repo, bus, id, "cancelled", { reason: reason ?? "cancelled from dashboard", force: true });
      },
      async runTaskNow(id) {
        log("executor.runTaskNow", id);
        return transitionTask(repo, bus, id, "ready", { reason: "run now", force: true });
      },
      pause(reason) {
        log("executor.pause", reason);
        paused = true;
        pauseReason = reason;
      },
      resume() {
        log("executor.resume");
        paused = false;
        pauseReason = undefined;
      },
      status: executorStatus,
    },
    patrol: {
      async runOnce(sensors) {
        log("patrol.runOnce", sensors);
        const now = new Date().toISOString();
        return { startedAt: now, finishedAt: now, sensors: (sensors ?? ["manual"]).map((name) => ({ name, ok: true, newSignals: 0, changedSignals: 0, durationMs: 1 })), totalNew: 0, totalChanged: 0 };
      },
    },
    triage: {
      async runOnce() {
        log("triage.runOnce");
        return { signalsTriaged: 0, inboxCreated: 0, tasksCreated: 0, dismissed: 0, costUsd: 0, errors: [] };
      },
    },
    planner: {
      async planTask(id) {
        log("planner.planTask", id);
        const t = repo.tasks.get(id);
        if (!t) throw new Error(`task not found: ${id}`);
        return repo.tasks.update(id, { plan: t.plan ?? { goal: t.title, steps: [], required_capabilities: [], risks: [], acceptance_criteria: [] } })!;
      },
    },
    inbox: {
      promote(id, overrides) {
        log("inbox.promote", id, overrides);
        const item = repo.inbox.get(id);
        if (!item) throw new Error(`inbox item not found: ${id}`);
        const task = repo.tasks.create({
          title: item.title,
          description: item.summary,
          kind: item.kind,
          category: item.category,
          priority: item.priority,
          level: item.level,
          inbox_item_id: item.id,
          labels: item.tags,
          ...(overrides ?? {}),
        });
        repo.inbox.update(id, { status: "promoted", task_id: task.id });
        bus.emit("inbox.changed", { inbox_item_id: id, status: "promoted" });
        return task;
      },
      dismiss(id, reason) {
        log("inbox.dismiss", id, reason);
        const it = repo.inbox.update(id, { status: "dismissed" });
        if (!it) throw new Error(`inbox item not found: ${id}`);
        bus.emit("inbox.changed", { inbox_item_id: id, status: "dismissed" });
        return it;
      },
      snooze(id, until) {
        log("inbox.snooze", id, until);
        const it = repo.inbox.update(id, { status: "snoozed", snoozed_until: until });
        if (!it) throw new Error(`inbox item not found: ${id}`);
        bus.emit("inbox.changed", { inbox_item_id: id, status: "snoozed" });
        return it;
      },
      done(id) {
        log("inbox.done", id);
        const it = repo.inbox.update(id, { status: "done" });
        if (!it) throw new Error(`inbox item not found: ${id}`);
        bus.emit("inbox.changed", { inbox_item_id: id, status: "done" });
        return it;
      },
    },
    capture: async (text, by, o) => {
      log("capture", text, by, o);
      const { signal } = repo.signals.upsert({ source: "manual", external_id: `manual:${Date.now()}`, kind: "note", title: o?.title ?? text.slice(0, 80), body: text, url: o?.url ?? null, actor: by });
      bus.emit("signal.new", { signal_id: signal.id, source: "manual" });
      return signal;
    },
  };
}
