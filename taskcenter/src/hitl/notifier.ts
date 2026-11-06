/**
 * Notifier: fans NotifyMessages out to every configured channel, applying
 * notify_on filters, profile quiet hours, per-(approval, channel) dedupe, and
 * recording notification rows + a `notification` event. Also auto-notifies on
 * task lifecycle changes (done / failed / review) for top-level tasks.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config } from "../config/schema.js";
import type { NotifierLike } from "../core/app.js";
import type { Bus } from "../core/events.js";
import type { Logger } from "../core/logger.js";
import type { Repo } from "../core/repo.js";
import type { Approval, Task } from "../core/types.js";
import { createChannels, type ChannelDeps } from "./channels/index.js";
import { renderTaskEvent, setRenderTimeZone, taskUrl } from "./render.js";
import type { Channel, InboundHandler, NotifyMessage } from "./types.js";

export interface NotifierDeps {
  config: Config;
  repo: Repo;
  bus: Bus;
  logger: Logger;
  /** Explicit channels (tests); default createChannels(config). */
  channels?: Channel[];
  /** Root for resolving config.profile_path / data_dir (default process.cwd()). */
  rootDir?: string;
  dataDir?: string;
  publicUrl?: string;
  /** Override quiet hours ("23:00-08:00" | null to disable); default from the profile. */
  quietHours?: string | null;
  /** Clock (tests). */
  now?: () => Date;
  /** Delay before a review_ready auto-notification (lets a `review` approval supersede it). */
  reviewDelayMs?: number;
  channelDeps?: Partial<ChannelDeps>;
}

export interface QuietHours {
  start: number; // minutes since midnight
  end: number;
}

export function parseQuietHours(s: string | null | undefined): QuietHours | undefined {
  if (!s) return undefined;
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*[-–~]\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(s);
  if (!m) return undefined;
  const start = Number(m[1]) * 60 + Number(m[2] ?? 0);
  const end = Number(m[3]) * 60 + Number(m[4] ?? 0);
  if (start === end) return undefined;
  return { start, end };
}

export function minutesInZone(d: Date, timeZone?: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? d.getHours());
    const mi = Number(parts.find((p) => p.type === "minute")?.value ?? d.getMinutes());
    return (h % 24) * 60 + mi;
  } catch {
    return d.getHours() * 60 + d.getMinutes();
  }
}

export function isQuiet(q: QuietHours | undefined, d: Date, timeZone?: string): boolean {
  if (!q) return false;
  const m = minutesInZone(d, timeZone);
  if (q.start < q.end) return m >= q.start && m < q.end;
  return m >= q.start || m < q.end; // spans midnight
}

/** Read habits.quiet_hours from the profile YAML (cached by mtime). */
export function loadProfileQuietHours(config: Config, rootDir: string, cache: { path?: string; mtime?: number; value?: string | null } = {}): string | null {
  const p = isAbsolute(config.profile_path) ? config.profile_path : resolve(rootDir, config.profile_path);
  try {
    if (!existsSync(p)) return null;
    const mtime = statSync(p).mtimeMs;
    if (cache.path === p && cache.mtime === mtime && cache.value !== undefined) return cache.value;
    const doc = parseYaml(readFileSync(p, "utf8")) as { habits?: { quiet_hours?: unknown } } | null;
    const v = doc?.habits?.quiet_hours;
    cache.path = p;
    cache.mtime = mtime;
    cache.value = typeof v === "string" && v.trim() ? v.trim() : null;
    return cache.value;
  } catch {
    return null;
  }
}

export function defaultPriority(msg: NotifyMessage): NonNullable<NotifyMessage["priority"]> {
  if (msg.priority) return msg.priority;
  if (msg.kind === "approval_requested" && msg.approval?.risk === "high") return "high";
  if (msg.kind === "budget_warning") return "high";
  return "normal";
}

export class Notifier implements NotifierLike {
  readonly channels: Channel[];
  private readonly logger: Logger;
  private readonly config: Config;
  private readonly repo: Repo;
  private readonly bus: Bus;
  private readonly rootDir: string;
  private readonly now: () => Date;
  private readonly profileCache: { path?: string; mtime?: number; value?: string | null } = {};
  private readonly deferred: NotifyMessage[] = [];
  private flushTimer?: NodeJS.Timeout;
  private started = false;
  private handler?: InboundHandler;
  private readonly reviewDelayMs: number;
  private readonly publicUrl?: string;
  private readonly onTaskChanged = (ev: { task_id: string; status: string; previous?: string }) => {
    void this.handleTaskChanged(ev).catch((e) => this.logger.error("task.changed handler failed", e));
  };
  private readonly onApprovalDecided = (ev: { approval_id: string }) => {
    void this.handleApprovalDecided(ev.approval_id).catch((e) => this.logger.error("approval.decided handler failed", e));
  };

  constructor(private readonly deps: NotifierDeps) {
    this.config = deps.config;
    this.repo = deps.repo;
    this.bus = deps.bus;
    this.logger = deps.logger.child("notifier");
    this.rootDir = deps.rootDir ?? process.env.TC_ROOT ?? process.cwd();
    this.now = deps.now ?? (() => new Date());
    this.reviewDelayMs = deps.reviewDelayMs ?? 1500;
    this.publicUrl = deps.publicUrl || deps.config.server.public_url || undefined;
    setRenderTimeZone(deps.config.timezone);
    this.channels =
      deps.channels ??
      createChannels(deps.config, {
        logger: deps.logger,
        repo: deps.repo,
        dataDir: deps.dataDir ?? (isAbsolute(deps.config.data_dir) ? deps.config.data_dir : resolve(this.rootDir, deps.config.data_dir)),
        publicUrl: this.publicUrl,
        ...deps.channelDeps,
      });
    this.bus.on("task.changed", this.onTaskChanged);
    this.bus.on("approval.decided", this.onApprovalDecided);
  }

  channelNames(): string[] {
    return this.channels.map((c) => c.name);
  }

  quietHours(): QuietHours | undefined {
    const s = this.deps.quietHours !== undefined ? this.deps.quietHours : loadProfileQuietHours(this.config, this.rootDir, this.profileCache);
    return parseQuietHours(s);
  }

  inQuietHours(at = this.now()): boolean {
    return isQuiet(this.quietHours(), at, this.config.timezone);
  }

  /** Should this message be sent at all (notify_on)? `info` is always allowed (explicit sends). */
  allowed(kind: NotifyMessage["kind"]): boolean {
    if (kind === "info") return true;
    return this.config.notifications.notify_on.includes(kind);
  }

  async notify(msg: NotifyMessage): Promise<void> {
    try {
      if (!this.allowed(msg.kind)) {
        this.logger.debug(`notification ${msg.kind} filtered by notify_on`);
        return;
      }
      const priority = defaultPriority(msg);
      const m: NotifyMessage = { ...msg, priority };
      if (priority !== "high" && this.inQuietHours()) {
        this.defer(m);
        return;
      }
      await this.dispatch(m);
    } catch (e) {
      this.logger.error("notify failed", e);
    }
  }

  private defer(m: NotifyMessage): void {
    // Dedupe deferred approvals by id
    if (m.approval && this.deferred.some((d) => d.approval?.id === m.approval!.id)) return;
    this.deferred.push(m);
    this.logger.info(`quiet hours: deferred ${m.kind} "${m.title}"`);
    this.bus.record({
      type: "notification",
      level: "debug",
      task_id: m.task?.id ?? m.approval?.task_id ?? null,
      message: `deferred (quiet hours): ${m.title}`,
      payload: { kind: m.kind, approval_id: m.approval?.id ?? null, deferred: true },
    });
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => void this.flushDeferred(), 60_000);
      this.flushTimer.unref?.();
    }
  }

  /** Send deferred messages if quiet hours are over (called every minute; exposed for tests). */
  async flushDeferred(force = false): Promise<number> {
    if (!this.deferred.length) return 0;
    if (!force && this.inQuietHours()) return 0;
    const batch = this.deferred.splice(0, this.deferred.length);
    let sent = 0;
    for (const m of batch) {
      // Skip approvals that were decided meanwhile
      if (m.approval) {
        const a = this.repo.approvals.get(m.approval.id);
        if (a && a.status !== "pending") continue;
        if (a) m.approval = a;
      }
      await this.dispatch(m);
      sent++;
    }
    if (!this.deferred.length && this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    return sent;
  }

  pendingDeferred(): number {
    return this.deferred.length;
  }

  private async dispatch(m: NotifyMessage): Promise<void> {
    const approvalId = m.approval?.id ?? null;
    const taskId = m.task?.id ?? m.approval?.task_id ?? null;
    const results = await Promise.all(
      this.channels.map(async (ch) => {
        if (approvalId && this.repo.notifications.existsFor(approvalId, ch.name)) {
          return { channel: ch.name, status: "skipped" as const, error: "duplicate" };
        }
        try {
          const r = await ch.send(m);
          return { channel: ch.name, status: r.ok ? ("sent" as const) : ("failed" as const), externalRef: r.externalRef, error: r.error };
        } catch (e) {
          return { channel: ch.name, status: "failed" as const, error: (e as Error).message };
        }
      }),
    );
    const refs: Record<string, string> = {};
    for (const r of results) {
      if (r.status === "skipped") continue;
      try {
        this.repo.notifications.create({
          channel: r.channel,
          target: null,
          approval_id: approvalId,
          task_id: taskId,
          title: m.title,
          body: m.body,
          status: r.status,
          external_ref: r.externalRef ?? null,
          error: r.error ?? null,
        });
      } catch (e) {
        this.logger.warn("could not record notification", e);
      }
      if (r.status === "sent" && r.externalRef) refs[r.channel] = r.externalRef;
      if (r.status === "failed") this.logger.warn(`channel ${r.channel} failed: ${r.error}`);
    }
    if (approvalId && Object.keys(refs).length) {
      try {
        const a = this.repo.approvals.get(approvalId);
        if (a) this.repo.approvals.update(approvalId, { channel_refs: { ...a.channel_refs, ...refs } });
      } catch (e) {
        this.logger.warn("could not store channel refs", e);
      }
    }
    const sentTo = results.filter((r) => r.status === "sent").map((r) => r.channel);
    this.bus.record({
      type: "notification",
      level: results.some((r) => r.status === "failed") && !sentTo.length ? "warn" : "info",
      task_id: taskId,
      message: `${m.kind}: ${m.title} → ${sentTo.join(", ") || "nobody"}`,
      payload: { kind: m.kind, approval_id: approvalId, priority: m.priority ?? "normal", channels: results },
    });
  }

  // ── Bus-driven notifications ──────────────────────────────────────

  private shouldAutoNotify(task: Task): boolean {
    if (task.parent_id === null) return true;
    return this.repo.tasks.children(task.id).length > 0; // a parent completing
  }

  private async handleTaskChanged(ev: { task_id: string; status: string; previous?: string }): Promise<void> {
    if (!["done", "failed", "review"].includes(ev.status)) return;
    const task = this.repo.tasks.get(ev.task_id);
    if (!task || task.status !== ev.status) return;
    if (!this.shouldAutoNotify(task)) return;
    if (ev.status === "review") {
      await new Promise((r) => setTimeout(r, this.reviewDelayMs));
      const fresh = this.repo.tasks.get(task.id);
      if (!fresh || fresh.status !== "review") return;
      const hasReviewApproval = this.repo.approvals.list({ task_id: task.id, status: "pending", limit: 20 }).some((a) => a.kind === "review");
      if (hasReviewApproval) return; // the approval_requested message covers it
      const { title, body } = renderTaskEvent("review_ready", fresh, this.config.locale, { publicUrl: this.publicUrl });
      return this.notify({ kind: "review_ready", task: fresh, title, body, url: taskUrl(this.publicUrl, fresh.id) });
    }
    const kind = ev.status === "done" ? "task_done" : "task_failed";
    const { title, body } = renderTaskEvent(kind, task, this.config.locale, { publicUrl: this.publicUrl });
    await this.notify({ kind, task, title, body, url: taskUrl(this.publicUrl, task.id), priority: kind === "task_failed" ? "normal" : undefined });
  }

  private async handleApprovalDecided(approvalId: string): Promise<void> {
    const a: Approval | undefined = this.repo.approvals.get(approvalId);
    if (!a) return;
    await Promise.all(
      this.channels.map(async (ch) => {
        if (!ch.onDecided) return;
        try {
          await ch.onDecided(a);
        } catch (e) {
          this.logger.debug(`${ch.name}.onDecided failed: ${(e as Error).message}`);
        }
      }),
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async start(handler: InboundHandler): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.handler = handler;
    for (const ch of this.channels) {
      if (!ch.start) continue;
      try {
        await ch.start(handler);
      } catch (e) {
        this.logger.error(`channel ${ch.name} failed to start`, e);
      }
    }
    this.logger.info(`notifier started (channels: ${this.channelNames().join(", ")})`);
  }

  async stop(): Promise<void> {
    this.bus.off("task.changed", this.onTaskChanged);
    this.bus.off("approval.decided", this.onApprovalDecided);
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    for (const ch of this.channels) {
      try {
        await ch.stop?.();
      } catch (e) {
        this.logger.warn(`channel ${ch.name} failed to stop`, e);
      }
    }
    this.started = false;
    this.handler = undefined;
  }
}

export function createNotifier(deps: { config: Config; repo: Repo; bus: Bus; logger: Logger } & Partial<NotifierDeps>): Notifier {
  return new Notifier(deps);
}
