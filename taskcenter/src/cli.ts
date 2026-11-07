#!/usr/bin/env node
/**
 * `tc` — Task Center command line. See src/cli/args.ts (HELP) for the command list.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppContext } from "./core/app.js";
import type { LogLevel } from "./core/logger.js";
import { transitionTask } from "./core/state.js";
import type { Approval, Event, InboxItem, Level, Task, TaskStatus } from "./core/types.js";
import { INBOX_STATUSES, PRIORITIES, TASK_STATUSES, isLevel } from "./core/types.js";
import { createApp } from "./engine/app.js";
import { startDaemon } from "./engine/daemon.js";
import { seedDemoFallback } from "./engine/demo.js";
import { exportState, importState } from "./engine/state-export.js";
import { collectStatus } from "./engine/status.js";
import { clampLevel, errMsg, parseUntil, sleep, trimText } from "./engine/util.js";
import { getWired } from "./engine/wiring.js";
import { HELP, flagBool, flagNum, flagStr, parseArgs, type ParsedArgs } from "./cli/args.js";
import { runDoctor } from "./cli/doctor.js";
import { ago, formatKv, formatTable, shortTime, type Column } from "./cli/format.js";
import { makeT, type I18nKey } from "./cli/i18n.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.TC_ROOT ??= PKG_ROOT;

class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

function version(): string {
  try {
    return (JSON.parse(readFileSync(resolve(PKG_ROOT, "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

interface Cli {
  args: ParsedArgs;
  json: boolean;
  dry: boolean;
  ctx?: AppContext;
  t: (k: I18nKey) => string;
  app(level?: LogLevel): Promise<AppContext>;
  out(data: unknown, text?: string | (() => string)): void;
}

function makeCli(args: ParsedArgs): Cli {
  const json = flagBool(args, "json");
  const dry = flagBool(args, "dry");
  const cli: Cli = {
    args,
    json,
    dry,
    t: makeT(undefined),
    async app(level) {
      if (cli.ctx) return cli.ctx;
      const logLevel = (process.env.TC_LOG_LEVEL as LogLevel | undefined) ?? level ?? "warn";
      cli.ctx = await createApp({ configPath: flagStr(args, "config"), dry, logLevel, logToStderr: true });
      cli.t = makeT(cli.ctx.config.locale);
      return cli.ctx;
    },
    out(data, text) {
      if (json) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
      else process.stdout.write((typeof text === "function" ? text() : (text ?? String(data))) + "\n");
    },
  };
  return cli;
}

function need(args: ParsedArgs, index: number, what: string): string {
  const v = args._[index];
  if (!v) throw new CliError(`missing ${what}`);
  return v;
}

function tz(cli: Cli): string | undefined {
  return cli.ctx?.config.timezone;
}

const levelFmt = (v: unknown) => (v ? `L${v}` : "");

function taskColumns(cli: Cli): Column[] {
  const t = cli.t;
  return [
    { key: "id", label: t("id") },
    { key: "status", label: t("status") },
    { key: "level", label: t("level"), format: levelFmt },
    { key: "priority", label: t("priority") },
    { key: "category", label: t("category") },
    { key: "title", label: t("title"), max: 50 },
    { key: "attempts", label: t("attempts"), align: "right" },
    { key: "cost_usd", label: t("cost"), align: "right", format: (v) => `$${Number(v ?? 0).toFixed(2)}` },
    { key: "updated_at", label: t("updated"), format: (v) => ago(v as string) },
  ];
}

function inboxColumns(cli: Cli): Column[] {
  const t = cli.t;
  return [
    { key: "id", label: t("id") },
    { key: "status", label: t("status") },
    { key: "kind", label: t("kind") },
    { key: "level", label: t("level"), format: levelFmt },
    { key: "priority", label: t("priority") },
    { key: "category", label: t("category") },
    { key: "title", label: t("title"), max: 56 },
    { key: "created_at", label: t("created"), format: (v) => ago(v as string) },
  ];
}

function approvalColumns(cli: Cli): Column[] {
  const t = cli.t;
  return [
    { key: "id", label: t("id") },
    { key: "status", label: t("status") },
    { key: "kind", label: t("kind") },
    { key: "risk", label: t("risk") },
    { key: "task_id", label: t("task") },
    { key: "title", label: t("title"), max: 56 },
    { key: "expires_at", label: t("expires"), format: (v) => shortTime(v as string, tz(cli)) },
  ];
}

function eventColumns(cli: Cli): Column[] {
  const t = cli.t;
  return [
    { key: "ts", label: t("time"), format: (v) => shortTime(v as string, tz(cli)) },
    { key: "level", label: "lvl" },
    { key: "type", label: t("type") },
    { key: "task_id", label: t("task") },
    { key: "message", label: t("message"), max: 90 },
  ];
}

function parseStatusList<T extends string>(raw: string | undefined, all: readonly T[]): T[] | undefined {
  if (!raw) return undefined;
  const list = raw.split(",").map((s) => s.trim()) as T[];
  for (const s of list) if (!all.includes(s)) throw new CliError(`unknown status "${s}" (valid: ${all.join(", ")})`);
  return list;
}

// ── commands ──────────────────────────────────────────────────────

async function cmdDaemon(cli: Cli, serveOnly = false): Promise<number> {
  const ctx = await cli.app("info");
  const serve = cli.args.flags.serve !== false;
  if (serveOnly) {
    const w = getWired(ctx);
    if (!w?.createServer) throw new CliError("server module not available");
    const s = w.createServer(ctx);
    const { host, port } = await s.start();
    ctx.logger.info(`serving API + dashboard at http://${host}:${port} (no loops)`);
    const stop = async () => {
      await s.stop();
      await ctx.shutdown();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise(() => {});
    return 0;
  }
  await startDaemon(ctx, { serve });
  await new Promise(() => {});
  return 0;
}

async function cmdPatrol(cli: Cli): Promise<number> {
  const ctx = await cli.app();
  const sensor = flagStr(cli.args, "sensor");
  const report = await ctx.services.patrol!.runOnce(sensor ? sensor.split(",") : undefined);
  const t = cli.t;
  let triage: unknown = null;
  if (!flagBool(cli.args, "once")) triage = await ctx.services.triage!.runOnce();
  cli.out({ patrol: report, triage }, () => {
    const table = formatTable(
      report.sensors.map((s) => ({ ...s, ok: s.ok ? t("ok") : t("error"), detail: s.error ?? s.summary ?? "" })),
      [
        { key: "name", label: t("sensor") },
        { key: "ok", label: t("status") },
        { key: "newSignals", label: t("new"), align: "right" },
        { key: "changedSignals", label: t("changed"), align: "right" },
        { key: "durationMs", label: "ms", align: "right" },
        { key: "detail", label: t("detail"), max: 70 },
      ],
      { empty: `${t("none")} (no enabled sensors)` },
    );
    const tr = triage as { signalsTriaged: number; inboxCreated: number; tasksCreated: number; dismissed: number; costUsd: number } | null;
    return table + (tr ? `\n\ntriage: ${tr.signalsTriaged} signals → ${tr.inboxCreated} inbox items, ${tr.tasksCreated} tasks, ${tr.dismissed} dismissed ($${tr.costUsd.toFixed(4)})` : "");
  });
  return report.sensors.some((s) => !s.ok) ? 2 : 0;
}

async function cmdTriage(cli: Cli): Promise<number> {
  const ctx = await cli.app();
  const r = await ctx.services.triage!.runOnce();
  cli.out(r, `triage: ${r.signalsTriaged} signals → ${r.inboxCreated} inbox items, ${r.tasksCreated} tasks, ${r.dismissed} dismissed ($${r.costUsd.toFixed(4)})${r.errors.length ? `\nerrors: ${r.errors.join("; ")}` : ""}`);
  return r.errors.length ? 2 : 0;
}

async function cmdPlan(cli: Cli): Promise<number> {
  const ctx = await cli.app();
  const w = getWired(ctx)!;
  const id = cli.args._[1];
  if (id) {
    const task = await w.planner.planTask(id);
    cli.out(task, () => `${task.id} ${task.status} — ${task.plan ? `${task.plan.steps.length} steps, ${ctx.repo.tasks.children(task.id).length} subtasks` : "no plan"}`);
    return 0;
  }
  const r = await w.planner.planPending();
  cli.out(r, `planned ${r.planned} task(s)${r.errors.length ? `; errors: ${r.errors.join("; ")}` : ""}`);
  return 0;
}

async function cmdRun(cli: Cli): Promise<number> {
  const id = need(cli.args, 1, "taskId");
  const ctx = await cli.app();
  const onEvent = (ev: Event) => {
    if (ev.task_id !== id) return;
    process.stderr.write(`${ev.ts.slice(11, 19)} ${ev.type.padEnd(17)} ${trimText(ev.message, 160)}\n`);
  };
  ctx.bus.on("event", onEvent);
  try {
    const task = await ctx.services.executor!.runTaskNow(id);
    const run = ctx.repo.runs.latestForTask(id);
    cli.out({ task, run }, () => `${task.id} → ${task.status}${task.result_summary ? `\n${task.result_summary}` : ""}${task.last_error ? `\nerror: ${task.last_error}` : ""}${run ? `\nrun ${run.id}: ${run.status}, $${run.cost_usd.toFixed(4)}, ${run.num_turns} turns` : ""}`);
    return task.status === "failed" ? 2 : 0;
  } finally {
    ctx.bus.off("event", onEvent);
  }
}

async function cmdInbox(cli: Cli): Promise<number> {
  const ctx = await cli.app();
  const sub = cli.args._[1] ?? "list";
  const svc = ctx.services.inbox!;
  const t = cli.t;
  switch (sub) {
    case "list": {
      const status = parseStatusList(flagStr(cli.args, "status"), INBOX_STATUSES) ?? ["new", "triaged", "snoozed"];
      const items = ctx.repo.inbox.list({ status: flagBool(cli.args, "all") ? undefined : status, limit: flagNum(cli.args, "limit") ?? 50 });
      cli.out(items, () => formatTable(items as unknown as Record<string, unknown>[], inboxColumns(cli), { empty: t("none") }));
      return 0;
    }
    case "show": {
      const id = need(cli.args, 2, "id");
      const item = ctx.repo.inbox.get(id);
      if (!item) throw new CliError(`inbox item ${id} ${t("not_found")}`);
      const signals = ctx.repo.signals.getMany(item.source_signal_ids);
      cli.out({ item, signals }, () => {
        const { source_signal_ids, tags, ...rest } = item;
        return formatKv({ ...rest, tags: tags.join(", "), signals: source_signal_ids.length }) + "\n\n" + signals.map((s) => `[${s.source}/${s.kind}] ${s.title}${s.url ? ` ${s.url}` : ""}\n${trimText(s.body, 600)}`).join("\n\n");
      });
      return 0;
    }
    case "promote": {
      const id = need(cli.args, 2, "id");
      const overrides: Partial<Task> = {};
      const lvl = flagNum(cli.args, "level");
      if (lvl !== undefined) overrides.level = clampLevel(lvl);
      const pri = flagStr(cli.args, "priority");
      if (pri) {
        if (!(PRIORITIES as readonly string[]).includes(pri)) throw new CliError(`priority must be one of ${PRIORITIES.join(", ")}`);
        overrides.priority = pri as Task["priority"];
      }
      const task = svc.promote(id, overrides);
      cli.out(task, `${t("promoted")}: ${task.id} (${task.status}, L${task.level} ${task.priority}) — ${task.title}`);
      return 0;
    }
    case "dismiss": {
      const id = need(cli.args, 2, "id");
      const item = svc.dismiss(id, cli.args._[3]);
      cli.out(item, `${t("dismissed")}: ${item.id}`);
      return 0;
    }
    case "snooze": {
      const id = need(cli.args, 2, "id");
      const until = parseUntil(need(cli.args, 3, "duration (1d|3d|7d|2h|ISO)"));
      if (!until) throw new CliError("invalid duration; use 1d, 3d, 7d, 2h or an ISO date");
      const item = svc.snooze(id, until);
      cli.out(item, `${t("snoozed")} ${shortTime(until, tz(cli))}: ${item.id}`);
      return 0;
    }
    case "done": {
      const id = need(cli.args, 2, "id");
      const item = svc.done(id);
      cli.out(item, `${t("done")}: ${item.id}`);
      return 0;
    }
    default:
      throw new CliError(`unknown inbox command: ${sub}`);
  }
}

async function cmdTasks(cli: Cli): Promise<number> {
  const ctx = await cli.app();
  const sub = cli.args._[1] ?? "list";
  const t = cli.t;
  const ex = ctx.services.executor!;
  switch (sub) {
    case "list": {
      const status = parseStatusList(flagStr(cli.args, "status"), TASK_STATUSES);
      const tasks = ctx.repo.tasks.list({ status: status ?? (flagBool(cli.args, "all") ? undefined : (TASK_STATUSES.filter((s) => !["done", "cancelled"].includes(s)) as TaskStatus[])), limit: flagNum(cli.args, "limit") ?? 100 });
      cli.out(tasks, () => formatTable(tasks as unknown as Record<string, unknown>[], taskColumns(cli), { empty: t("none") }));
      return 0;
    }
    case "show": {
      const id = need(cli.args, 2, "id");
      const task = ctx.repo.tasks.get(id);
      if (!task) throw new CliError(`task ${id} ${t("not_found")}`);
      const runs = ctx.repo.runs.listByTask(id);
      const artifacts = ctx.repo.artifacts.listByTask(id);
      const children = ctx.repo.tasks.children(id);
      const approvals = ctx.repo.approvals.list({ task_id: id, limit: 20 });
      cli.out({ task, runs, artifacts, children, approvals }, () => {
        const { context, plan, ...rest } = task;
        const parts = [formatKv({ ...rest, depends_on: rest.depends_on.join(", "), labels: rest.labels.join(", "), acceptance_criteria: rest.acceptance_criteria.join(" | ") })];
        if (plan) parts.push(`\nplan: ${plan.goal}\n` + plan.steps.map((s, i) => `  ${i + 1}. ${s.title}${s.needs_approval ? " (approval)" : ""}`).join("\n") + (plan.risks?.length ? `\n  risks: ${plan.risks.join("; ")}` : ""));
        if (children.length) parts.push("\nsubtasks:\n" + formatTable(children as unknown as Record<string, unknown>[], taskColumns(cli)));
        if (runs.length)
          parts.push(
            "\nruns:\n" +
              formatTable(runs as unknown as Record<string, unknown>[], [
                { key: "id", label: t("id") },
                { key: "attempt", label: t("attempts"), align: "right" },
                { key: "status", label: t("status") },
                { key: "reason", label: "reason" },
                { key: "model", label: "model" },
                { key: "cost_usd", label: t("cost"), align: "right", format: (v) => `$${Number(v ?? 0).toFixed(4)}` },
                { key: "num_turns", label: "turns", align: "right" },
                { key: "started_at", label: t("time"), format: (v) => shortTime(v as string, tz(cli)) },
                { key: "error", label: t("error"), max: 50 },
              ]),
          );
        if (artifacts.length) parts.push("\nartifacts:\n" + artifacts.map((a) => `  [${a.type}] ${a.title}${a.path ? ` ${a.path}` : ""}${a.url ? ` ${a.url}` : ""}`).join("\n"));
        if (approvals.length) parts.push("\napprovals:\n" + formatTable(approvals as unknown as Record<string, unknown>[], approvalColumns(cli)));
        if (Object.keys(context).length) parts.push("\ncontext: " + trimText(JSON.stringify(context), 1500));
        return parts.join("\n");
      });
      return 0;
    }
    case "create": {
      const title = need(cli.args, 2, "title");
      const level = clampLevel(flagNum(cli.args, "level") ?? 2);
      const priority = (flagStr(cli.args, "priority") ?? "P2") as Task["priority"];
      if (!(PRIORITIES as readonly string[]).includes(priority)) throw new CliError(`priority must be one of ${PRIORITIES.join(", ")}`);
      const category = (flagStr(cli.args, "category") ?? "other") as Task["category"];
      const kind = (flagStr(cli.args, "kind") ?? "todo") as Task["kind"];
      const description = flagStr(cli.args, "description") ?? "";
      const task = ctx.repo.tasks.create({
        title,
        description,
        level,
        priority,
        category,
        kind,
        status: level <= 2 ? "ready" : "todo",
        budget_usd: ctx.config.brain.budget_usd_per_run,
        max_attempts: ctx.config.executor.max_attempts,
        labels: ["manual"],
        context: { created_by: "cli" },
      });
      ctx.bus.record({ type: "system", task_id: task.id, message: `task created from CLI (${task.status}, L${task.level})`, payload: { by: "cli" } });
      ctx.bus.emit("task.changed", { task_id: task.id, status: task.status });
      cli.out(task, `created ${task.id} (${task.status}, L${task.level} ${task.priority}) — ${task.title}`);
      return 0;
    }
    case "retry": {
      const id = need(cli.args, 2, "id");
      const task = await ex.retryTask(id);
      cli.out(task, `${t("retried")}: ${task.id} (${task.status})`);
      return 0;
    }
    case "cancel": {
      const id = need(cli.args, 2, "id");
      const task = await ex.cancelTask(id, cli.args._[3] ?? "cancelled from CLI");
      cli.out(task, `${t("cancelled")}: ${task.id}`);
      return 0;
    }
    case "done": {
      const id = need(cli.args, 2, "id");
      const task = transitionTask(ctx.repo, ctx.bus, id, "done", { reason: "marked done from CLI" });
      cli.out(task, `${t("done")}: ${task.id}`);
      return 0;
    }
    default:
      throw new CliError(`unknown tasks command: ${sub}`);
  }
}

async function cmdApprovals(cli: Cli): Promise<number> {
  const ctx = await cli.app();
  const sub = cli.args._[1] ?? "list";
  const svc = ctx.services.approvals!;
  const t = cli.t;
  const decide = async (decision: "approve" | "reject" | "respond", id: string, note?: string) => {
    const a = await svc.decide({ approvalId: id, decision, note, decidedBy: process.env.USER ? `cli:${process.env.USER}` : "cli" });
    const task = a.task_id ? ctx.repo.tasks.get(a.task_id) : undefined;
    cli.out({ approval: a, task }, `${a.id} ${a.status} (${a.decision})${task ? ` — task ${task.id} ${task.status}` : ""}`);
    return 0;
  };
  switch (sub) {
    case "list": {
      const status = parseStatusList(flagStr(cli.args, "status"), ["pending", "approved", "rejected", "edited", "expired", "cancelled"] as const);
      const list = ctx.repo.approvals.list({ status: status ?? (flagBool(cli.args, "all") ? undefined : "pending"), limit: flagNum(cli.args, "limit") ?? 50 });
      cli.out(list, () => formatTable(list as unknown as Record<string, unknown>[], approvalColumns(cli), { empty: t("none") }));
      return 0;
    }
    case "show": {
      const id = need(cli.args, 2, "id");
      const a: Approval | undefined = ctx.repo.approvals.get(id);
      if (!a) throw new CliError(`approval ${id} ${t("not_found")}`);
      cli.out(a, () => {
        const { options, payload, channel_refs, edited_payload, ...rest } = a;
        return formatKv(rest) + `\n\noptions: ${options.map((o) => `${o.value} (${o.label})`).join(", ")}\n\npayload:\n${JSON.stringify(payload, null, 2)}${edited_payload ? `\n\nedited payload:\n${JSON.stringify(edited_payload, null, 2)}` : ""}`;
      });
      return 0;
    }
    case "approve":
      return decide("approve", need(cli.args, 2, "id"), cli.args._.slice(3).join(" ") || undefined);
    case "reject":
      return decide("reject", need(cli.args, 2, "id"), cli.args._.slice(3).join(" ") || undefined);
    case "respond": {
      const id = need(cli.args, 2, "id");
      const text = cli.args._.slice(3).join(" ");
      if (!text) throw new CliError("respond needs a text");
      return decide("respond", id, text);
    }
    default:
      throw new CliError(`unknown approvals command: ${sub}`);
  }
}

async function cmdEvents(cli: Cli): Promise<number> {
  const ctx = await cli.app();
  const opts = { task_id: flagStr(cli.args, "task"), run_id: flagStr(cli.args, "run"), type: flagStr(cli.args, "type")?.split(","), level: flagStr(cli.args, "level"), limit: flagNum(cli.args, "limit") ?? 50 };
  const print = (events: Event[]) => {
    const rows = [...events].reverse();
    if (cli.json) for (const e of rows) process.stdout.write(JSON.stringify(e) + "\n");
    else if (rows.length) process.stdout.write(formatTable(rows as unknown as Record<string, unknown>[], eventColumns(cli)) + "\n");
  };
  const first = ctx.repo.events.list(opts);
  print(first);
  if (!flagBool(cli.args, "follow")) return 0;
  let lastId = first[0]?.id;
  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
  });
  while (!stop) {
    await sleep(1000);
    const fresh = ctx.repo.events.list({ ...opts, after_id: lastId, limit: 200 });
    if (fresh.length) {
      const rows = [...fresh].reverse();
      for (const e of rows) process.stdout.write(cli.json ? JSON.stringify(e) + "\n" : `${shortTime(e.ts, tz(cli))}  ${e.level.padEnd(5)} ${e.type.padEnd(17)} ${e.task_id ?? ""} ${trimText(e.message, 120)}\n`);
      lastId = fresh[0].id;
    }
  }
  return 0;
}

async function cmdCapture(cli: Cli): Promise<number> {
  const text = cli.args._.slice(1).join(" ");
  if (!text) throw new CliError("capture needs a text");
  const ctx = await cli.app();
  const s = await ctx.services.capture!(text, process.env.USER ? `cli:${process.env.USER}` : "cli");
  const daemon = collectStatus(ctx).daemon;
  cli.out(s, `${cli.t("captured")}: ${s.id} — ${s.title}${daemon?.alive ? "" : "\n(no daemon running: run `tc triage` to classify it)"}`);
  return 0;
}

async function cmdStatus(cli: Cli): Promise<number> {
  const ctx = await cli.app();
  const w = getWired(ctx);
  const s = collectStatus(ctx, { sensors: w?.patrol.sensors(), version: version() });
  const t = cli.t;
  cli.out(s, () => {
    const lines: string[] = [];
    lines.push(`tc ${s.version} · ${s.provider}${w?.dry ? " [dry]" : ""} · ${s.locale} · ${s.dataDir}`);
    lines.push(s.daemon?.alive ? `${t("daemon_running")} (pid ${s.daemon.pid}, ${ago(s.daemon.startedAt)})` : t("daemon_stopped"));
    if (s.executor) lines.push(`executor: ${s.executor.running.length}/${s.executor.concurrency} running${s.executor.paused ? ` — paused: ${s.executor.pauseReason ?? ""}` : ""}`);
    lines.push(`${t("budget")}: $${s.budget.spentUsd.toFixed(2)} / $${s.budget.limitUsd} (${Math.round(s.budget.ratio * 100)}%, ${s.budget.runs} runs)`);
    const counts = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ") || "0";
    lines.push(`inbox: ${counts(s.inbox)}`);
    lines.push(`tasks: ${counts(s.tasks)}`);
    lines.push(`approvals: ${counts(s.approvals)}`);
    lines.push(`signals untriaged: ${s.untriagedSignals}${s.lastPatrol ? ` · last patrol ${ago(s.lastPatrol.ts)} ago: ${s.lastPatrol.message}` : ""}`);
    if (s.activeRuns.length) lines.push(`active runs: ${s.activeRuns.map((r) => `${r.id} (${r.task_id})`).join(", ")}`);
    lines.push(`channels: ${s.channels.join(", ") || "none"}`);
    if (s.sensors.length) lines.push(`sensors: ${s.sensors.map((x) => `${x.name}${x.enabled ? "" : " (off)"}${x.failures ? ` ×${x.failures} fail` : ""}`).join(", ")}`);
    lines.push("", formatTable(s.schedules as unknown as Record<string, unknown>[], [
      { key: "name", label: t("name") },
      { key: "cron", label: t("cron") },
      { key: "enabled", label: t("enabled"), format: (v) => (v ? "✓" : "✗") },
      { key: "last_status", label: t("status") },
      { key: "last_run_at", label: t("last_run"), format: (v) => shortTime(v as string, tz(cli)) },
      { key: "next_run_at", label: t("next_run"), format: (v) => shortTime(v as string, tz(cli)) },
      { key: "last_error", label: t("error"), max: 40 },
    ]));
    return lines.join("\n");
  });
  return 0;
}

async function cmdDoctor(cli: Cli): Promise<number> {
  const r = await runDoctor({ configPath: flagStr(cli.args, "config"), probe: flagBool(cli.args, "probe"), dry: cli.dry });
  const t = cli.t;
  cli.out(r, () => {
    const icon = { ok: "✓", warn: "!", fail: "✗" } as const;
    return formatTable(
      r.checks.map((c) => ({ s: icon[c.status], name: c.name, detail: c.detail })),
      [
        { key: "s", label: " " },
        { key: "name", label: t("check") },
        { key: "detail", label: t("detail"), max: 110 },
      ],
    ) + `\n\n${r.ok ? "all checks passed" : "some checks FAILED"}`;
  });
  return r.ok ? 0 : 1;
}

async function cmdState(cli: Cli): Promise<number> {
  const sub = cli.args._[1];
  const ctx = await cli.app();
  const t = cli.t;
  if (sub === "export") {
    const r = exportState(ctx, cli.args._[2], { sinceDays: flagNum(cli.args, "since") });
    cli.out(r, `${t("exported")} ${r.dir}\n${Object.entries(r.manifest.tables).map(([k, v]) => `  ${k}: ${v.rows}`).join("\n")}`);
    return 0;
  }
  if (sub === "import") {
    const r = importState(ctx, need(cli.args, 2, "dir"));
    cli.out(r, `${t("imported")} ${r.dir}\n${Object.entries(r.tables).map(([k, v]) => `  ${k}: ${v.applied} applied, ${v.skipped} skipped, ${v.errors} errors`).join("\n")}`);
    return 0;
  }
  throw new CliError("usage: tc state export [dir] | tc state import <dir>");
}

async function cmdDemo(cli: Cli): Promise<number> {
  const ctx = await cli.app();
  const w = getWired(ctx);
  const r = w?.seedDemo ? w.seedDemo() : seedDemoFallback(ctx);
  const summary = r && typeof r === "object" ? Object.fromEntries(Object.entries(r as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? v.length : v])) : r;
  cli.out(summary, `demo data seeded: ${JSON.stringify(summary)}`);
  return 0;
}

async function cmdDigest(cli: Cli): Promise<number> {
  const ctx = await cli.app();
  if (flagBool(cli.args, "send")) {
    await ctx.services.digest!.send();
    cli.out({ sent: true }, "digest sent");
    return 0;
  }
  const text = await ctx.services.digest!.build();
  cli.out({ digest: text }, text);
  return 0;
}

async function cmdContext(cli: Cli): Promise<number> {
  if (cli.args._[1] !== "refresh") throw new CliError("usage: tc context refresh");
  const ctx = await cli.app();
  const r = await ctx.services.contextRefresh!.runOnce();
  cli.out(r, `context refreshed: ${r.memoriesAdded} memories added`);
  return 0;
}

function cmdInit(cli: Cli): number {
  const root = process.env.TC_ROOT ?? PKG_ROOT;
  const pairs: Array<[string, string, number?]> = [
    ["config/taskcenter.example.yaml", "config/taskcenter.yaml"],
    ["config/profile.example.yaml", "config/profile.yaml"],
    [".env.example", ".env", 0o600],
  ];
  const done: string[] = [];
  const kept: string[] = [];
  for (const [from, to, mode] of pairs) {
    const src = resolve(root, from);
    const dst = resolve(root, to);
    if (existsSync(dst)) {
      kept.push(to);
      continue;
    }
    if (!existsSync(src)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    if (mode) chmodSync(dst, mode);
    done.push(to);
  }
  mkdirSync(resolve(root, "data"), { recursive: true });
  cli.out({ created: done, kept }, `created: ${done.join(", ") || "(nothing)"}${kept.length ? `\nkept existing: ${kept.join(", ")}` : ""}\nnext: edit config/taskcenter.yaml and .env, then run \`tc doctor\``);
  return 0;
}

// ── main ──────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cli = makeCli(args);
  const cmd = args._[0];
  if (flagBool(args, "version")) {
    process.stdout.write(`tc ${version()}\n`);
    return 0;
  }
  if (!cmd || flagBool(args, "help") || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    switch (cmd) {
      case "daemon":
        return await cmdDaemon(cli);
      case "serve":
        return await cmdDaemon(cli, true);
      case "patrol":
        return await cmdPatrol(cli);
      case "triage":
        return await cmdTriage(cli);
      case "plan":
        return await cmdPlan(cli);
      case "run":
        return await cmdRun(cli);
      case "inbox":
        return await cmdInbox(cli);
      case "tasks":
      case "task":
        return await cmdTasks(cli);
      case "approvals":
      case "approve":
      case "outbox":
        if (cmd === "approve") args._.splice(1, 0, "approve");
        return await cmdApprovals(cli);
      case "events":
        return await cmdEvents(cli);
      case "capture":
        return await cmdCapture(cli);
      case "status":
        return await cmdStatus(cli);
      case "doctor":
        return await cmdDoctor(cli);
      case "state":
        return await cmdState(cli);
      case "demo":
        return await cmdDemo(cli);
      case "digest":
        return await cmdDigest(cli);
      case "context":
        return await cmdContext(cli);
      case "init":
        return cmdInit(cli);
      default:
        throw new CliError(`unknown command: ${cmd}\n\n${HELP}`);
    }
  } catch (e) {
    const msg = e instanceof CliError ? e.message : errMsg(e);
    if (cli.json) process.stdout.write(JSON.stringify({ error: msg }) + "\n");
    process.stderr.write(`error: ${msg}\n`);
    return e instanceof CliError ? e.code : 1;
  } finally {
    if (cli.ctx && !["daemon", "serve"].includes(cmd)) await cli.ctx.shutdown().catch(() => {});
  }
}

const code = await main(process.argv.slice(2));
if (!["daemon", "serve"].includes(process.argv[2] ?? "")) process.exit(code);
