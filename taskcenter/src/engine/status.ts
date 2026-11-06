/**
 * Status snapshot shared by `tc status`, the inbound /status command and the daemon log.
 */
import { join } from "node:path";
import type { AppContext, ExecutorStatus } from "../core/app.js";
import type { BudgetStatus } from "../core/budget.js";
import type { Schedule } from "../core/types.js";
import { readLock, type LockInfo } from "./lock.js";

export interface StatusSnapshot {
  version: string;
  now: string;
  dataDir: string;
  configPath: string | null;
  provider: string;
  locale: string;
  daemon: (LockInfo & { lockPath: string }) | null;
  executor: ExecutorStatus | null;
  budget: BudgetStatus;
  inbox: Record<string, number>;
  tasks: Record<string, number>;
  approvals: Record<string, number>;
  activeRuns: Array<{ id: string; task_id: string; status: string; started_at: string | null }>;
  untriagedSignals: number;
  lastPatrol: { ts: string; message: string } | null;
  schedules: Schedule[];
  sensors: Array<{ name: string; enabled: boolean; configured: boolean; failures: number }>;
  channels: string[];
}

export function collectStatus(ctx: AppContext, extra: { sensors?: StatusSnapshot["sensors"]; version?: string } = {}): StatusSnapshot {
  const { repo, config } = ctx;
  const lockPath = join(ctx.dataDir, "taskcenter.lock");
  const lock = readLock(lockPath);
  const lastPatrol = repo.events.list({ type: "sensor_poll", limit: 1 })[0];
  const ch = config.notifications.channels;
  const channels = [
    ch.console.enabled ? "console" : null,
    ch.telegram.enabled ? "telegram" : null,
    ch.ntfy.enabled ? "ntfy" : null,
    ch.email.enabled ? "email" : null,
    ch.webhook.enabled ? "webhook" : null,
  ].filter((x): x is string => !!x);
  return {
    version: extra.version ?? "0.1.0",
    now: new Date().toISOString(),
    dataDir: ctx.dataDir,
    configPath: ctx.loaded.configPath,
    provider: config.brain.provider,
    locale: config.locale,
    daemon: lock ? { ...lock, lockPath } : null,
    executor: ctx.services.executor?.status() ?? null,
    budget: ctx.budget.status(),
    inbox: repo.inbox.counts(),
    tasks: repo.tasks.counts(),
    approvals: repo.approvals.counts(),
    activeRuns: repo.runs.active().map((r) => ({ id: r.id, task_id: r.task_id, status: r.status, started_at: r.started_at })),
    untriagedSignals: repo.signals.listUntriaged(1000).length,
    lastPatrol: lastPatrol ? { ts: lastPatrol.ts, message: lastPatrol.message } : null,
    schedules: repo.schedules.all(),
    sensors: extra.sensors ?? [],
    channels,
  };
}

export function statusLine(s: StatusSnapshot, locale = "en"): string {
  const zh = locale.toLowerCase().startsWith("zh");
  const t = s.tasks;
  const parts = zh
    ? [
        `待审批 ${s.approvals.pending ?? 0}`,
        `运行中 ${t.running ?? 0}`,
        `就绪 ${t.ready ?? 0}`,
        `待评审 ${t.review ?? 0}`,
        `等待人工 ${t.waiting_human ?? 0}`,
        `Inbox 新 ${s.inbox.new ?? 0}/已分诊 ${s.inbox.triaged ?? 0}`,
        `今日成本 $${s.budget.spentUsd.toFixed(2)}/$${s.budget.limitUsd}`,
        s.executor?.paused ? `执行器已暂停(${s.executor.pauseReason ?? ""})` : "",
      ]
    : [
        `pending approvals ${s.approvals.pending ?? 0}`,
        `running ${t.running ?? 0}`,
        `ready ${t.ready ?? 0}`,
        `review ${t.review ?? 0}`,
        `waiting ${t.waiting_human ?? 0}`,
        `inbox new ${s.inbox.new ?? 0}/triaged ${s.inbox.triaged ?? 0}`,
        `cost today $${s.budget.spentUsd.toFixed(2)}/$${s.budget.limitUsd}`,
        s.executor?.paused ? `executor paused (${s.executor.pauseReason ?? ""})` : "",
      ];
  return parts.filter(Boolean).join(" · ");
}
