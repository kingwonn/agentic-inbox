import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import type { AppContext } from "../../core/app.js";
import type { Config } from "../../config/schema.js";
import { countsByStatus } from "../util.js";

/** Config summary without secrets (tokens, passwords, hosts of mail servers are omitted). */
export function configSummary(config: Config) {
  const sensors = Object.entries(config.sensors)
    .filter(([, v]) => (v as { enabled?: boolean }).enabled)
    .map(([k]) => k);
  const channels = Object.entries(config.notifications.channels)
    .filter(([, v]) => (v as { enabled?: boolean }).enabled)
    .map(([k]) => k);
  return {
    provider: config.brain.provider,
    models: config.brain.models,
    effort: config.brain.effort,
    max_turns: config.brain.max_turns,
    timeout_seconds: config.brain.timeout_seconds,
    budget_usd_per_run: config.brain.budget_usd_per_run,
    daily_budget_usd: config.brain.daily_budget_usd,
    concurrency: config.executor.concurrency,
    max_attempts: config.executor.max_attempts,
    patrol_interval_minutes: config.patrol.interval_minutes,
    approval: config.approval,
    sensors,
    channels,
    digest: config.notifications.digest,
    schedules: config.schedules,
    timezone: config.timezone,
    locale: config.locale,
    server: { host: config.server.host, port: config.server.port, auth: Boolean(config.server.token), public_url: config.server.public_url || null },
  };
}

export function readVersion(rootDir: string): string {
  try {
    return String(JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export function statusRoutes(ctx: AppContext) {
  const app = new Hono();
  const version = readVersion(ctx.loaded.rootDir);

  app.get("/status", (c) => {
    const { repo } = ctx;
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const cursors = repo.cursors.all();
    const sensors: Record<string, { cursors: number; updated_at: string | null }> = {};
    for (const cur of cursors) {
      const s = (sensors[cur.sensor] ??= { cursors: 0, updated_at: null });
      s.cursors++;
      if (!s.updated_at || cur.updated_at > s.updated_at) s.updated_at = cur.updated_at;
    }
    return c.json({
      startedAt: ctx.startedAt,
      now: new Date().toISOString(),
      version,
      config: configSummary(ctx.config),
      counts: {
        inbox: repo.inbox.counts(),
        tasks: repo.tasks.counts(),
        runs: countsByStatus(repo, "runs"),
        approvals: repo.approvals.counts(),
        signals: repo.signals.count(),
        untriaged: repo.signals.listUntriaged(1000).length,
        failures24h: repo.events.count({ type: "error", since: dayAgo }),
      },
      budget: ctx.budget.status(),
      executor: ctx.services.executor?.status() ?? null,
      schedules: repo.schedules.all(),
      sensors,
      cursors,
      dataDir: ctx.dataDir,
      services: Object.entries(ctx.services)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k),
    });
  });

  app.get("/budget", (c) => c.json({ status: ctx.budget.status(), history: ctx.repo.budgets.recent(30) }));

  app.get("/schedules", (c) => c.json({ items: ctx.repo.schedules.all() }));

  app.get("/notifications", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json({ items: ctx.repo.notifications.list({ limit: Math.min(500, Math.max(1, limit || 50)) }) });
  });

  return app;
}
