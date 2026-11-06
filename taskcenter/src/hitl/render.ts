/**
 * Human-facing rendering of approvals and task events (zh-CN + en).
 * Output is plain text / markdown-lite; channels adapt it (Telegram HTML, email HTML, ntfy markdown).
 * Bodies stay under MAX_BODY chars (Telegram limit is 4096).
 */
import type { Approval, ApprovalOption, Task } from "../core/types.js";
import type { NotifyMessage } from "./types.js";

export const MAX_BODY = 3500;

let renderTimeZone: string | undefined = process.env.TZ || undefined;
/** Time zone used for dates in rendered messages (the Notifier sets it from config.timezone). */
export function setRenderTimeZone(tz: string | undefined): void {
  renderTimeZone = tz || undefined;
}

export type Locale = "zh-CN" | "en";
export function normalizeLocale(locale: string | undefined): Locale {
  return (locale ?? "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

const RISK_EMOJI: Record<string, string> = { high: "🔴", medium: "🟠", low: "🟢" };

const T = {
  "zh-CN": {
    kind: { action: "需要批准", decision: "需要决策", review: "需要复核", question: "需要回答" },
    risk: { high: "高风险", medium: "中风险", low: "低风险" },
    task: "任务",
    wants: "Agent 想要",
    why: "背景",
    recommendation: "建议",
    options: "选项",
    howTo: "回复方式",
    link: "链接",
    expires: "过期",
    noExpiry: "不过期",
    optionLabel: { approve: "批准", edit: "修改后批准", reject: "拒绝", respond: "回答", accept: "接受", request_changes: "要求修改" },
    how: {
      approve: (id: string) => `/approve ${id} [备注]`,
      reject: (id: string) => `/reject ${id} [理由]`,
      edit: (id: string) => `/edit ${id} {"input":{...}}`,
      respond: (id: string) => `/respond ${id} <回答>`,
      custom: (id: string, v: string) => `/decide ${id} ${v}`,
    },
    hint: "也可以直接点按钮，或在看板的 Outbox 中处理。",
    events: {
      task_done: "✅ 任务完成",
      task_failed: "❌ 任务失败",
      review_ready: "👀 任务待复核",
      budget_warning: "💸 预算预警",
      digest: "📰 每日摘要",
      info: "ℹ️ 通知",
      approval_requested: "待审批",
    },
    fields: {
      result: "结果",
      error: "错误",
      cost: "花费",
      attempts: "尝试次数",
      level: "等级",
      spent: "今日已用",
      limit: "预算上限",
      artifacts: "产出",
      followUps: "后续",
    },
    reviewHint: "请在看板 Outbox 中接受、要求修改或拒绝。",
    budgetHint: "执行已暂停（或即将暂停），请检查成本或提高 daily_budget_usd。",
  },
  en: {
    kind: { action: "Approval needed", decision: "Decision needed", review: "Review needed", question: "Question" },
    risk: { high: "high risk", medium: "medium risk", low: "low risk" },
    task: "Task",
    wants: "The agent wants to",
    why: "Why",
    recommendation: "Recommendation",
    options: "Options",
    howTo: "How to answer",
    link: "Link",
    expires: "Expires",
    noExpiry: "never expires",
    optionLabel: { approve: "Approve", edit: "Edit & approve", reject: "Reject", respond: "Respond", accept: "Accept", request_changes: "Request changes" },
    how: {
      approve: (id: string) => `/approve ${id} [note]`,
      reject: (id: string) => `/reject ${id} [reason]`,
      edit: (id: string) => `/edit ${id} {"input":{...}}`,
      respond: (id: string) => `/respond ${id} <answer>`,
      custom: (id: string, v: string) => `/decide ${id} ${v}`,
    },
    hint: "Or tap a button, or handle it in the dashboard Outbox.",
    events: {
      task_done: "✅ Task done",
      task_failed: "❌ Task failed",
      review_ready: "👀 Task ready for review",
      budget_warning: "💸 Budget warning",
      digest: "📰 Daily digest",
      info: "ℹ️ Notice",
      approval_requested: "Approval",
    },
    fields: {
      result: "Result",
      error: "Error",
      cost: "Cost",
      attempts: "Attempts",
      level: "Level",
      spent: "Spent today",
      limit: "Daily limit",
      artifacts: "Artifacts",
      followUps: "Follow-ups",
    },
    reviewHint: "Accept, request changes or reject it in the dashboard Outbox.",
    budgetHint: "Execution is paused (or about to be). Check costs or raise daily_budget_usd.",
  },
} as const;

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

export function formatDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    void locale; // both locales use the unambiguous YYYY-MM-DD HH:mm form
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: renderTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ") + "Z";
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** One-or-two-line description of the concrete action in an approval payload. */
export function describeAction(payload: Record<string, unknown>, max = 700): string {
  const tool = typeof payload.tool === "string" ? payload.tool : typeof payload.name === "string" ? payload.name : typeof payload.action === "string" ? payload.action : "";
  const input = asRecord(payload.input) ?? asRecord(payload.args) ?? asRecord(payload.arguments) ?? payload;
  const lines: string[] = [];
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  if (tool) lines.push(`[${tool}]`);
  if (typeof payload.description === "string" && payload.description) lines.push(payload.description);
  const command = str("command");
  const to = str("to") ?? (Array.isArray(input.to) ? (input.to as unknown[]).join(", ") : undefined);
  const subject = str("subject");
  const filePath = str("file_path") ?? str("path");
  const title = str("title");
  if (command) lines.push(`$ ${truncate(command, 400)}`);
  else if (to || subject) {
    if (to) lines.push(`To: ${truncate(to, 200)}`);
    if (subject) lines.push(`Subject: ${truncate(subject, 200)}`);
    const body = str("body") ?? str("text");
    if (body) lines.push(truncate(body.replace(/\s+/g, " "), 240));
  } else if (title && (/(pr|pull|issue|publish|release)/i.test(tool) || input.base !== undefined || input.head !== undefined)) {
    lines.push(`PR: ${truncate(title, 200)}`);
    if (str("base") || str("head")) lines.push(`${str("head") ?? "?"} → ${str("base") ?? "?"}`);
  } else if (filePath) lines.push(`File: ${truncate(filePath, 200)}`);
  else if (str("url")) lines.push(`URL: ${truncate(str("url")!, 200)}`);
  else if (input !== payload || !tool) {
    const keys = Object.keys(input).filter((k) => !["tool", "name", "action", "description"].includes(k));
    if (keys.length) {
      let json = "";
      try {
        json = JSON.stringify(Object.fromEntries(keys.map((k) => [k, input[k]])));
      } catch {
        json = String(input);
      }
      lines.push(truncate(json, 400));
    }
  }
  return truncate(lines.join("\n"), max) || "—";
}

function optionLabel(o: ApprovalOption, loc: Locale): string {
  const dict = T[loc].optionLabel as Record<string, string>;
  // Standard options are always localized; custom options keep their own label.
  const label = dict[o.value] ?? (o.label && o.label !== o.value ? o.label : o.value);
  return o.description ? `${label} — ${truncate(o.description, 120)}` : label;
}

function howToAnswer(o: ApprovalOption, id: string, loc: Locale): string {
  const h = T[loc].how;
  switch (o.value) {
    case "approve":
      return h.approve(id);
    case "reject":
      return h.reject(id);
    case "edit":
      return h.edit(id);
    case "respond":
      return h.respond(id);
    default:
      return h.custom(id, o.value);
  }
}

export function outboxUrl(publicUrl: string | undefined, approvalId: string): string | undefined {
  if (!publicUrl) return undefined;
  return `${publicUrl.replace(/\/+$/, "")}/#/outbox/${approvalId}`;
}

export function taskUrl(publicUrl: string | undefined, taskId: string): string | undefined {
  if (!publicUrl) return undefined;
  return `${publicUrl.replace(/\/+$/, "")}/#/tasks/${taskId}`;
}

/** Concise, scannable approval message. */
export function renderApproval(a: Approval, task: Task | undefined, locale: string, publicUrl?: string): { title: string; body: string } {
  const loc = normalizeLocale(locale);
  const t = T[loc];
  const emoji = RISK_EMOJI[a.risk] ?? "🟠";
  const kindLabel = t.kind[a.kind] ?? t.kind.action;
  const title = `${emoji} ${kindLabel}: ${truncate(a.title, 120)}`;

  const lines: string[] = [];
  lines.push(`${t.risk[a.risk] ?? a.risk} · ${a.id}`);
  if (task) lines.push(`${t.task}: ${truncate(task.title, 120)} (${task.id}, L${task.level}, ${task.priority})`);
  lines.push("");
  if (a.kind !== "question" || Object.keys(a.payload).length) {
    lines.push(`${t.wants}:`);
    lines.push(describeAction(a.payload));
    lines.push("");
  }
  if (a.context) {
    lines.push(`${t.why}: ${truncate(a.context.trim(), 900)}`);
    lines.push("");
  }
  if (a.recommendation) {
    lines.push(`${t.recommendation}: ${truncate(a.recommendation.trim(), 400)}`);
    lines.push("");
  }
  if (a.options.length) {
    lines.push(`${t.options}:`);
    for (const o of a.options) lines.push(`• ${optionLabel(o, loc)} → ${howToAnswer(o, a.id, loc)}`);
    lines.push(t.hint);
    lines.push("");
  }
  const url = outboxUrl(publicUrl, a.id);
  if (url) lines.push(`${t.link}: ${url}`);
  lines.push(`${t.expires}: ${a.expires_at ? formatDate(a.expires_at, loc) : t.noExpiry}`);
  return { title, body: clampBody(lines.join("\n")) };
}

function clampBody(body: string): string {
  return body.length > MAX_BODY ? body.slice(0, MAX_BODY - 2) + "\n…" : body;
}

/** Task lifecycle / system notifications. `extra` carries kind-specific data (see docs/modules/hitl.md). */
export function renderTaskEvent(kind: NotifyMessage["kind"], task: Task, locale: string, extra: Record<string, unknown> = {}): { title: string; body: string } {
  const loc = normalizeLocale(locale);
  const t = T[loc];
  const f = t.fields;
  const heading = t.events[kind] ?? t.events.info;
  const publicUrl = typeof extra.publicUrl === "string" ? extra.publicUrl : undefined;
  const lines: string[] = [];
  const taskLine = `${t.task}: ${truncate(task.title, 120)} (${task.id}, L${task.level}, ${task.priority})`;
  const str = (k: string) => (typeof extra[k] === "string" ? (extra[k] as string) : undefined);

  switch (kind) {
    case "task_done": {
      lines.push(taskLine);
      const summary = str("summary") ?? task.result_summary;
      if (summary) lines.push(`${f.result}: ${truncate(summary, 1200)}`);
      const artifacts = Array.isArray(extra.artifacts) ? (extra.artifacts as Array<Record<string, unknown>>) : [];
      if (artifacts.length) {
        lines.push(`${f.artifacts}:`);
        for (const a of artifacts.slice(0, 8)) lines.push(`• ${truncate(String(a.title ?? a.path ?? a.url ?? ""), 100)}${a.url ? ` ${a.url}` : ""}`);
      }
      const followUps = Array.isArray(extra.follow_ups) ? (extra.follow_ups as unknown[]) : [];
      if (followUps.length) {
        lines.push(`${f.followUps}:`);
        for (const x of followUps.slice(0, 5)) lines.push(`• ${truncate(String(x), 160)}`);
      }
      lines.push(`${f.cost}: $${(task.cost_usd ?? 0).toFixed(2)}`);
      break;
    }
    case "task_failed": {
      lines.push(taskLine);
      const err = str("error") ?? task.last_error;
      if (err) lines.push(`${f.error}: ${truncate(err, 800)}`);
      lines.push(`${f.attempts}: ${task.attempts}/${task.max_attempts} · ${f.cost}: $${(task.cost_usd ?? 0).toFixed(2)}`);
      break;
    }
    case "review_ready": {
      lines.push(taskLine);
      const summary = str("summary") ?? task.result_summary;
      if (summary) lines.push(`${f.result}: ${truncate(summary, 1200)}`);
      lines.push(t.reviewHint);
      break;
    }
    case "budget_warning": {
      const spent = typeof extra.spentUsd === "number" ? extra.spentUsd : undefined;
      const limit = typeof extra.limitUsd === "number" ? extra.limitUsd : undefined;
      if (spent !== undefined || limit !== undefined) lines.push(`${f.spent}: $${(spent ?? 0).toFixed(2)} / ${f.limit}: $${(limit ?? 0).toFixed(2)}`);
      if (task.id) lines.push(taskLine);
      lines.push(str("message") ?? t.budgetHint);
      break;
    }
    case "digest": {
      lines.push(str("text") ?? str("body") ?? "");
      break;
    }
    default: {
      if (str("body")) lines.push(str("body")!);
      else lines.push(taskLine);
    }
  }
  const url = kind === "digest" ? publicUrl : taskUrl(publicUrl, task.id);
  if (url) lines.push(`${t.link}: ${url}`);
  const title = str("title") ?? (kind === "digest" || kind === "budget_warning" || kind === "info" ? heading : `${heading}: ${truncate(task.title, 100)}`);
  return { title, body: clampBody(lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n")) };
}
