/**
 * Cron scheduler (croner). Each job runs without overlap, records last/next run in
 * repo.schedules, and can be triggered by name (also from bus wake reasons:
 * patrol/capture -> triage, triage/promote -> plan).
 */
import { Cron } from "croner";
import type { Config } from "../config/schema.js";
import type { AppContext } from "../core/app.js";
import { nowIso } from "../core/time.js";
import type { Approval, Schedule } from "../core/types.js";
import { transitionTask } from "../core/state.js";
import type { ExecutorService } from "./executor.js";
import type { PlannerService } from "./plan.js";
import { errMsg } from "./util.js";

export interface SchedulerDeps {
  executor?: ExecutorService;
  planner?: PlannerService;
  maintenance?: () => Promise<unknown>;
  /** Expire overdue approvals; defaults to repo.approvals.expireDue(). */
  expireApprovals?: (now?: Date) => Approval[];
}

export interface JobDefinition {
  name: string;
  cron: string;
  job: string;
  enabled: boolean;
}

export interface SchedulerService {
  start(): void;
  stop(): void;
  trigger(name: string): Promise<void>;
  jobs(): Array<JobDefinition & { running: boolean; nextRun: string | null }>;
}

export const TRIAGE_CATCHUP_CRON = "*/5 * * * *";
export const PLAN_CRON = "* * * * *";
export const EXECUTOR_TICK_CRON = "*/30 * * * * *";
export const FOLLOW_UPS_CRON = "2-59/5 * * * *";

export function scheduleDefinitions(config: Config): JobDefinition[] {
  return [
    { name: "patrol", cron: config.schedules.patrol, job: "patrol", enabled: true },
    { name: "triage", cron: TRIAGE_CATCHUP_CRON, job: "triage", enabled: true },
    { name: "plan", cron: PLAN_CRON, job: "plan", enabled: true },
    { name: "executor_tick", cron: EXECUTOR_TICK_CRON, job: "executor_tick", enabled: true },
    { name: "follow_ups", cron: FOLLOW_UPS_CRON, job: "follow_ups", enabled: true },
    { name: "digest", cron: config.notifications.digest.cron, job: "digest", enabled: config.notifications.digest.enabled },
    { name: "context_refresh", cron: config.schedules.context_refresh, job: "context_refresh", enabled: true },
    { name: "maintenance", cron: config.schedules.maintenance, job: "maintenance", enabled: true },
  ];
}

/** Upsert the schedule rows (config is authoritative for cron; `enabled` is kept from the DB except for digest). */
export function registerSchedules(ctx: AppContext): JobDefinition[] {
  const defs = scheduleDefinitions(ctx.config);
  for (const d of defs) {
    ctx.repo.schedules.upsert({ name: d.name, cron: d.cron, job: d.job, ...(d.name === "digest" ? { enabled: d.enabled ? 1 : 0 } : {}) });
  }
  return defs;
}

/** Follow-ups pass: due follow-ups/retries, snoozed inbox items, expired approvals. */
export function runFollowUps(ctx: AppContext, deps: SchedulerDeps): { followUps: number; unsnoozed: number; expired: number; blocked: number } {
  const { repo, bus } = ctx;
  const out = { followUps: 0, unsnoozed: 0, expired: 0, blocked: 0 };
  if (deps.executor) out.followUps = deps.executor.retryDue();
  else {
    for (const t of repo.tasks.dueFollowUps()) {
      try {
        transitionTask(repo, bus, t.id, "ready", { reason: "follow-up due", patch: { follow_up_at: null } });
        out.followUps++;
      } catch {
        /* ignore */
      }
    }
  }
  for (const item of repo.inbox.dueSnoozed()) {
    repo.inbox.update(item.id, { status: "new", snoozed_until: null });
    bus.record({ type: "status_change", message: `inbox snooze elapsed: ${item.title}`, payload: { entity: "inbox", inbox_item_id: item.id, from: "snoozed", to: "new" } });
    bus.emit("inbox.changed", { inbox_item_id: item.id, status: "new" });
    out.unsnoozed++;
  }
  const expired = deps.expireApprovals ? deps.expireApprovals() : repo.approvals.expireDue();
  out.expired = expired.length;
  for (const a of expired) {
    if (!a.task_id) continue;
    const task = repo.tasks.get(a.task_id);
    if (!task || task.status !== "waiting_human") continue;
    const others = repo.approvals.list({ task_id: task.id, status: "pending", limit: 20 });
    if (others.length) continue;
    try {
      transitionTask(repo, bus, task.id, "blocked", { reason: `approval ${a.id} expired`, patch: { last_error: `approval expired: ${a.title}` } });
      out.blocked++;
    } catch (e) {
      ctx.logger.warn(`blocking ${task.id} after expiry failed: ${errMsg(e)}`);
    }
  }
  if (out.followUps || out.unsnoozed) bus.wake("follow_ups");
  return out;
}

export function createScheduler(ctx: AppContext, deps: SchedulerDeps = {}): SchedulerService {
  const { repo, bus, config } = ctx;
  const logger = ctx.logger.child("scheduler");
  const crons = new Map<string, Cron>();
  const busy = new Set<string>();
  const pending = new Set<string>();
  let started = false;

  const handlers: Record<string, () => Promise<unknown>> = {
    patrol: async () => ctx.services.patrol?.runOnce(),
    triage: async () => ctx.services.triage?.runOnce(),
    plan: async () => deps.planner?.planPending(),
    executor_tick: async () => {
      deps.executor?.retryDue();
      deps.executor?.wake("tick");
    },
    follow_ups: async () => runFollowUps(ctx, deps),
    digest: async () => ctx.services.digest?.send(),
    context_refresh: async () => ctx.services.contextRefresh?.runOnce(),
    maintenance: async () => deps.maintenance?.(),
  };

  function enabled(name: string): boolean {
    const row = repo.schedules.get(name);
    return row ? row.enabled === 1 : true;
  }

  function nextRunIso(name: string): string | null {
    const c = crons.get(name);
    const d = c?.nextRun();
    return d ? d.toISOString() : null;
  }

  async function runJob(name: string, source: "cron" | "trigger"): Promise<void> {
    const handler = handlers[name];
    if (!handler) throw new Error(`unknown job: ${name}`);
    if (source === "cron" && !enabled(name)) return;
    if (busy.has(name)) {
      pending.add(name);
      return;
    }
    busy.add(name);
    try {
      do {
        pending.delete(name);
        const startedAt = nowIso();
        const quiet = name === "executor_tick";
        if (!quiet) repo.schedules.update(name, { last_run_at: startedAt, last_status: "running" });
        try {
          await handler();
          if (!quiet) repo.schedules.update(name, { last_status: "ok", last_error: null, next_run_at: nextRunIso(name) });
          else repo.schedules.update(name, { last_run_at: startedAt, last_status: "ok", next_run_at: nextRunIso(name) });
        } catch (e) {
          const msg = errMsg(e);
          logger.error(`job ${name} failed: ${msg}`);
          bus.record({ type: "error", level: "error", message: `job ${name} failed: ${msg}`, payload: { job: name } });
          repo.schedules.update(name, { last_status: "error", last_error: msg, next_run_at: nextRunIso(name) });
        }
      } while (pending.has(name));
    } finally {
      busy.delete(name);
    }
  }

  const onWake = ({ reason }: { reason: string }) => {
    if (!started) return;
    if (reason === "patrol" || reason === "capture") void runJob("triage", "trigger").catch(() => {});
    if (reason === "triage" || reason === "promote") void runJob("plan", "trigger").catch(() => {});
  };

  function start(): void {
    if (started) return;
    started = true;
    for (const d of registerSchedules(ctx)) {
      try {
        const c = new Cron(d.cron, { timezone: config.timezone, protect: true, unref: true, catch: (e) => logger.error(`job ${d.name} threw: ${errMsg(e)}`) }, () => runJob(d.name, "cron"));
        crons.set(d.name, c);
        repo.schedules.update(d.name, { next_run_at: nextRunIso(d.name) });
      } catch (e) {
        logger.error(`invalid cron for ${d.name} (${d.cron}): ${errMsg(e)}`);
        repo.schedules.update(d.name, { last_status: "error", last_error: `invalid cron: ${errMsg(e)}` });
      }
    }
    bus.on("wake", onWake);
    logger.info(`scheduler started with ${crons.size} jobs (tz ${config.timezone})`);
  }

  function stop(): void {
    if (!started) return;
    started = false;
    bus.off("wake", onWake);
    for (const c of crons.values()) c.stop();
    crons.clear();
  }

  return {
    start,
    stop,
    trigger: (name) => runJob(name, "trigger"),
    jobs: () =>
      scheduleDefinitions(config).map((d) => {
        const row: Schedule | undefined = repo.schedules.get(d.name);
        return { ...d, enabled: row ? row.enabled === 1 : d.enabled, running: busy.has(d.name), nextRun: nextRunIso(d.name) };
      }),
  };
}
