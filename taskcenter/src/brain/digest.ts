/**
 * Daily digest: template-based (zh-CN / en) with optional LLM polish.
 */
import type { Config } from "../config/schema.js";
import type { Logger } from "../core/logger.js";
import type { Repo } from "../core/repo.js";
import { DAY, dayKey } from "../core/time.js";
import type { InboxItem, Task } from "../core/types.js";
import type { ContextSnapshot } from "./context.js";
import { pickLang } from "./context.js";
import type { LlmProvider } from "./llm.js";
import { truncateChars } from "./providers/util.js";

export interface DigestDeps {
  repo: Repo;
  config: Config;
  context: ContextSnapshot;
  llm?: LlmProvider;
  logger: Logger;
  now?: Date;
}

const T = {
  "zh-CN": {
    title: (d: string) => `📋 每日摘要 · ${d}`,
    inbox: "新收件箱条目",
    none: "无",
    byKind: { todo: "待办", problem: "问题", opportunity: "机会", decision: "决策", info: "信息" } as Record<string, string>,
    approvals: "待审批",
    tasks: "任务（最近 24h）",
    running: "进行中",
    review: "待验收",
    done: "已完成",
    failed: "失败",
    waiting: "等待人工",
    spend: "今日花费",
    budget: "预算",
    calendar: "未来 24h 日程",
    risk: "风险",
    expires: "过期",
    nothing: "过去一天很安静，没有新动态。",
  },
  en: {
    title: (d: string) => `📋 Daily digest · ${d}`,
    inbox: "New inbox items",
    none: "none",
    byKind: { todo: "todo", problem: "problem", opportunity: "opportunity", decision: "decision", info: "info" } as Record<string, string>,
    approvals: "Pending approvals",
    tasks: "Tasks (last 24h)",
    running: "running",
    review: "in review",
    done: "done",
    failed: "failed",
    waiting: "waiting for you",
    spend: "Spend today",
    budget: "budget",
    calendar: "Next 24h on the calendar",
    risk: "risk",
    expires: "expires",
    nothing: "A quiet day: nothing new.",
  },
};

function fmtTime(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", month: "short", day: "2-digit" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function renderDigestTemplate(deps: DigestDeps): string {
  const { repo, config } = deps;
  const now = deps.now ?? new Date();
  const lang = pickLang(config.locale);
  const t = T[lang];
  const tz = config.timezone;
  const since = new Date(now.getTime() - DAY).toISOString();
  const until = new Date(now.getTime() + DAY).toISOString();
  const lines: string[] = [t.title(dayKey(now, tz)), ""];
  let anything = false;

  // Inbox
  const inbox = repo.inbox.list({ status: ["new", "triaged"], limit: 500 }).filter((i) => i.created_at >= since);
  const inboxByKind = new Map<string, InboxItem[]>();
  for (const i of inbox) inboxByKind.set(i.kind, [...(inboxByKind.get(i.kind) ?? []), i]);
  lines.push(`## ${t.inbox} (${inbox.length})`);
  if (inbox.length) {
    anything = true;
    for (const [kind, items] of inboxByKind) {
      lines.push(`- ${t.byKind[kind] ?? kind}: ${items.length}`);
      for (const i of items.sort((a, b) => a.priority.localeCompare(b.priority)).slice(0, 5)) lines.push(`  - [${i.priority}/L${i.level}] ${truncateChars(i.title, 80)}`);
      if (items.length > 5) lines.push(`  - … +${items.length - 5}`);
    }
  } else lines.push(`- ${t.none}`);

  // Approvals
  const pending = repo.approvals.pending();
  lines.push("", `## ${t.approvals} (${pending.length})`);
  if (pending.length) {
    anything = true;
    for (const a of pending.slice(0, 10)) lines.push(`- [${a.kind}/${t.risk}:${a.risk}] ${truncateChars(a.title, 80)}${a.expires_at ? ` (${t.expires} ${fmtTime(a.expires_at, tz)})` : ""}`);
  } else lines.push(`- ${t.none}`);

  // Tasks
  const recent = (status: Task["status"][]) => repo.tasks.list({ status, limit: 500 }).filter((x) => x.updated_at >= since);
  const groups: Array<[string, Task[]]> = [
    [t.running, repo.tasks.list({ status: ["running"], limit: 100 })],
    [t.waiting, repo.tasks.list({ status: ["waiting_human"], limit: 100 })],
    [t.review, repo.tasks.list({ status: ["review"], limit: 100 })],
    [t.done, recent(["done"])],
    [t.failed, recent(["failed"])],
  ];
  lines.push("", `## ${t.tasks}`);
  let anyTask = false;
  for (const [label, tasks] of groups) {
    if (!tasks.length) continue;
    anyTask = true;
    anything = true;
    lines.push(`- ${label}: ${tasks.length}`);
    for (const x of tasks.slice(0, 5)) lines.push(`  - ${truncateChars(x.title, 70)}${x.result_summary ? ` — ${truncateChars(x.result_summary, 90)}` : ""}`);
  }
  if (!anyTask) lines.push(`- ${t.none}`);

  // Spend
  const b = repo.budgets.get(dayKey(now, tz));
  const limit = config.brain.daily_budget_usd;
  lines.push("", `## ${t.spend}`, `- $${b.cost_usd.toFixed(2)} / ${t.budget} $${limit.toFixed(2)} (${limit > 0 ? Math.round((b.cost_usd / limit) * 100) : 0}%), ${b.runs} runs`);

  // Calendar
  const events = repo.signals.list({ source: "ics", limit: 200 }).filter((s) => s.occurred_at >= now.toISOString() && s.occurred_at <= until).sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  if (events.length) {
    anything = true;
    lines.push("", `## ${t.calendar}`);
    for (const e of events.slice(0, 10)) lines.push(`- ${fmtTime(e.occurred_at, tz)} ${truncateChars(e.title, 70)}`);
  }

  if (!anything) lines.push("", t.nothing);
  return lines.join("\n");
}

export async function buildDigest(deps: DigestDeps): Promise<string> {
  const template = renderDigestTemplate(deps);
  const { llm, config, logger } = deps;
  if (!llm || process.env.TC_DIGEST_LLM === "off") return template;
  const lang = pickLang(config.locale);
  try {
    const res = await llm.complete({
      model: config.brain.models.classify,
      system: `You polish a daily digest for a busy person. Keep every fact, number and item; improve flow, add a one-line headline with the 1-3 things that matter most. Output markdown only, in ${lang === "zh-CN" ? "Simplified Chinese" : "English"}. Do not add information that is not in the input.`,
      prompt: template,
      effort: "low",
      purpose: "digest",
      logger,
      timeoutMs: 90_000,
    });
    const text = res.text.trim();
    return text.length > 40 ? text : template;
  } catch (e) {
    logger.warn(`digest polish failed, using template: ${(e as Error).message}`);
    return template;
  }
}
