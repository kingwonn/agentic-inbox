/**
 * Outbox / approval service: creates approval items, waits for decisions, applies
 * decisions to tasks and wakes the executor. Decisions follow the LangChain HITL
 * semantics: approve / edit / reject / respond, plus custom option values for
 * `decision` and `review` kinds.
 */
import type { Config } from "../config/schema.js";
import type { NotifierLike } from "../core/app.js";
import type { Bus } from "../core/events.js";
import type { Logger } from "../core/logger.js";
import type { Repo } from "../core/repo.js";
import { transitionTask } from "../core/state.js";
import { isoPlus, nowIso, HOUR } from "../core/time.js";
import type { Approval, ApprovalOption, ApprovalStatus, NewApproval, Task, TaskStatus } from "../core/types.js";
import { renderApproval, outboxUrl } from "./render.js";
import type { ApprovalService, InboundDecision, InboundHandler } from "./types.js";

export const STANDARD_OPTIONS: Record<string, ApprovalOption> = {
  approve: { value: "approve", label: "Approve" },
  edit: { value: "edit", label: "Edit & approve" },
  reject: { value: "reject", label: "Reject" },
  respond: { value: "respond", label: "Respond" },
  accept: { value: "accept", label: "Accept" },
  request_changes: { value: "request_changes", label: "Request changes" },
};

/** Default options per approval kind. */
export function defaultOptions(kind: Approval["kind"], given?: ApprovalOption[]): ApprovalOption[] {
  const has = (v: string) => (given ?? []).some((o) => o.value === v);
  switch (kind) {
    case "action":
      return given && given.length ? given : [STANDARD_OPTIONS.approve, STANDARD_OPTIONS.edit, STANDARD_OPTIONS.reject];
    case "decision":
      return [...(given ?? []), ...(has("reject") ? [] : [STANDARD_OPTIONS.reject])];
    case "review":
      return given && given.length ? given : [STANDARD_OPTIONS.accept, STANDARD_OPTIONS.request_changes, STANDARD_OPTIONS.reject];
    case "question":
      return given && given.length ? given : [STANDARD_OPTIONS.respond];
    default:
      return given ?? [];
  }
}

/** Thrown when a decision arrives for an approval that is no longer pending. */
export class ApprovalNotPendingError extends Error {
  constructor(
    readonly approval: Approval,
    message?: string,
  ) {
    super(message ?? `Approval ${approval.id} is not pending (status: ${approval.status}${approval.decision ? `, decision: ${approval.decision}` : ""})`);
    this.name = "ApprovalNotPendingError";
  }
}

export class ApprovalNotFoundError extends Error {
  constructor(readonly approvalId: string) {
    super(`Approval not found: ${approvalId}`);
    this.name = "ApprovalNotFoundError";
  }
}

export interface ApprovalServiceDeps {
  repo: Repo;
  bus: Bus;
  notifier: NotifierLike;
  config: Config;
  logger: Logger;
  publicUrl?: string;
  /** DB poll interval used by waitForDecision (default 2000ms). */
  pollIntervalMs?: number;
}

export interface ApprovalServiceExt extends ApprovalService {
  /** Expire overdue approvals (maintenance job). Returns the expired rows. */
  expireDue(now?: Date): Approval[];
}

export interface ResolvedDecision {
  status: ApprovalStatus;
  decision: string;
  note?: string;
  editedPayload?: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Shallow merge of an edited payload over the original (input objects are merged one level deeper). */
export function mergeEditedPayload(original: Record<string, unknown>, edited: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...original, ...edited };
  if (isPlainObject(original.input) && isPlainObject(edited.input)) out.input = { ...original.input, ...edited.input };
  return out;
}

/** Map an inbound decision onto approval status/decision. Throws on invalid input. */
export function resolveDecision(a: Approval, d: InboundDecision): ResolvedDecision {
  const value = String(d.decision ?? "").trim();
  const note = d.note?.trim() || undefined;
  if (!value) throw new Error("decision is required");
  switch (value) {
    case "approve":
      if (a.kind === "review") return { status: "approved", decision: "accept", note };
      return { status: "approved", decision: "approve", note };
    case "reject":
      return { status: "rejected", decision: "reject", note };
    case "edit": {
      if (!isPlainObject(d.editedPayload)) throw new Error("edit requires editedPayload (a JSON object)");
      return { status: "edited", decision: "edit", note, editedPayload: mergeEditedPayload(a.payload, d.editedPayload) };
    }
    case "respond": {
      if (!note) throw new Error("respond requires a note (the answer)");
      return { status: "approved", decision: "respond", note };
    }
    default: {
      const known = a.options.some((o) => o.value === value);
      if (!known) throw new Error(`Unknown option "${value}" for approval ${a.id}; valid: ${a.options.map((o) => o.value).join(", ") || "approve, reject"}`);
      if (a.kind === "review" && value === "request_changes") return { status: "approved", decision: value, note };
      return { status: "approved", decision: value, note };
    }
  }
}

export function createApprovalService(deps: ApprovalServiceDeps): ApprovalServiceExt {
  const { repo, bus, notifier, config } = deps;
  const logger = deps.logger.child("approvals");
  const publicUrl = deps.publicUrl || config.server.public_url || undefined;
  const pollMs = deps.pollIntervalMs ?? 2000;

  function safeTransition(taskId: string, to: TaskStatus, opts: Parameters<typeof transitionTask>[4]): Task | undefined {
    try {
      return transitionTask(repo, bus, taskId, to, opts);
    } catch (e) {
      logger.warn(`task ${taskId}: transition to ${to} not allowed, forcing`, { error: (e as Error).message });
      try {
        return transitionTask(repo, bus, taskId, to, { ...opts, force: true });
      } catch (e2) {
        logger.error(`task ${taskId}: forced transition to ${to} failed`, e2);
        return undefined;
      }
    }
  }

  async function request(input: NewApproval): Promise<Approval> {
    const expiresAt = input.expires_at ?? isoPlus(config.approval.expire_hours * HOUR);
    const a = repo.approvals.create({
      ...input,
      options: defaultOptions(input.kind, input.options),
      expires_at: expiresAt,
    });
    const task = a.task_id ? repo.tasks.get(a.task_id) : undefined;
    bus.record({
      type: "approval_requested",
      task_id: a.task_id,
      run_id: a.run_id,
      message: `approval requested: ${a.title}`,
      payload: { approval_id: a.id, kind: a.kind, risk: a.risk, title: a.title },
    });
    bus.emit("approval.requested", { approval_id: a.id, task_id: a.task_id });
    if (task && (task.status === "running" || task.status === "ready")) {
      safeTransition(task.id, "waiting_human", { reason: `approval ${a.id} (${a.kind}) requested`, run_id: a.run_id ?? undefined });
    }
    const { title, body } = renderApproval(a, task, config.locale, publicUrl);
    try {
      await notifier.notify({
        kind: "approval_requested",
        approval: a,
        task,
        title,
        body,
        url: outboxUrl(publicUrl, a.id),
        priority: a.risk === "high" ? "high" : "normal",
      });
    } catch (e) {
      logger.error(`notify failed for approval ${a.id}`, e);
    }
    logger.info(`approval ${a.id} requested (${a.kind}, ${a.risk})`, { task_id: a.task_id, title: a.title });
    return repo.approvals.get(a.id) ?? a;
  }

  function waitForDecision(approvalId: string, timeoutMs: number, signal?: AbortSignal): Promise<Approval> {
    const current = repo.approvals.get(approvalId);
    if (!current) return Promise.reject(new ApprovalNotFoundError(approvalId));
    if (current.status !== "pending") return Promise.resolve(current);
    if (signal?.aborted) return Promise.resolve(current);
    return new Promise<Approval>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        bus.off("approval.decided", onDecided);
        clearInterval(poll);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(repo.approvals.get(approvalId) ?? current);
      };
      const onDecided = (ev: { approval_id: string }) => {
        if (ev.approval_id === approvalId) finish();
      };
      const onAbort = () => finish();
      const poll = setInterval(() => {
        try {
          const a = repo.approvals.get(approvalId);
          if (!a || a.status !== "pending") finish();
        } catch (e) {
          logger.warn("poll failed", e);
        }
      }, pollMs);
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
      bus.on("approval.decided", onDecided);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  function expireApproval(a: Approval, now: string): Approval | undefined {
    const ok = repo.approvals.decide(a.id, { status: "expired", decision: null, decided_by: "system" });
    if (!ok) return repo.approvals.get(a.id);
    bus.record({
      type: "approval_decided",
      level: "warn",
      task_id: a.task_id,
      run_id: a.run_id,
      message: `approval expired: ${a.title}`,
      payload: { approval_id: a.id, kind: a.kind, status: "expired", decision: "expired", expired_at: now },
    });
    bus.emit("approval.decided", { approval_id: a.id, task_id: a.task_id, decision: "expired" });
    return repo.approvals.get(a.id);
  }

  function applyToTask(a: Approval, r: ResolvedDecision): void {
    if (!a.task_id) return;
    const task = repo.tasks.get(a.task_id);
    if (!task) return;
    const reason = `approval ${a.id} ${r.decision}`;
    if (a.kind === "review") {
      if (r.decision === "accept" || r.decision === "approve") {
        safeTransition(task.id, "done", { reason, run_id: a.run_id ?? undefined, patch: r.note ? { context: { ...task.context, review_notes: appendNote(task.context.review_notes, r.note) } } : undefined });
      } else if (r.decision === "request_changes") {
        const patch: Partial<Task> = { context: { ...task.context, review_notes: appendNote(task.context.review_notes, r.note ?? "(request changes)"), pending_resume: { resume: resumeOf(a, r) } } };
        safeTransition(task.id, "ready", { reason, run_id: a.run_id ?? undefined, patch });
        bus.wake("approval_decided");
      } else {
        safeTransition(task.id, "cancelled", { reason: r.note ? `${reason}: ${r.note}` : reason, run_id: a.run_id ?? undefined });
      }
      return;
    }
    if (task.status !== "waiting_human") return; // running: the inline gate handles it
    const others = repo.approvals.list({ task_id: task.id, status: "pending", limit: 50 }).filter((x) => x.id !== a.id);
    if (others.length) {
      logger.info(`task ${task.id} still has ${others.length} pending approval(s); staying waiting_human`);
      return;
    }
    const patch: Partial<Task> = { context: { ...task.context, pending_resume: { resume: resumeOf(a, r) } } };
    safeTransition(task.id, "ready", { reason, run_id: a.run_id ?? undefined, patch });
    bus.wake("approval_decided");
  }

  async function decide(d: InboundDecision): Promise<Approval> {
    const a = repo.approvals.get(d.approvalId);
    if (!a) throw new ApprovalNotFoundError(d.approvalId);
    if (a.status !== "pending") throw new ApprovalNotPendingError(a);
    const now = nowIso();
    if (a.expires_at && a.expires_at <= now) {
      const expired = expireApproval(a, now) ?? a;
      throw new ApprovalNotPendingError(expired, `Approval ${a.id} expired at ${a.expires_at}`);
    }
    const r = resolveDecision(a, d);
    const ok = repo.approvals.decide(a.id, {
      status: r.status,
      decision: r.decision,
      decision_note: r.note ?? null,
      edited_payload: r.editedPayload ?? null,
      decided_by: d.decidedBy || "human",
    });
    if (!ok) throw new ApprovalNotPendingError(repo.approvals.get(a.id) ?? a);
    const decided = repo.approvals.get(a.id)!;
    bus.record({
      type: "approval_decided",
      task_id: a.task_id,
      run_id: a.run_id,
      message: `approval ${r.decision}: ${a.title}${r.note ? ` — ${r.note.slice(0, 200)}` : ""}`,
      payload: { approval_id: a.id, kind: a.kind, status: r.status, decision: r.decision, decided_by: decided.decided_by, note: r.note ?? null, edited: !!r.editedPayload },
    });
    bus.emit("approval.decided", { approval_id: a.id, task_id: a.task_id, decision: r.decision });
    try {
      applyToTask(decided, r);
    } catch (e) {
      logger.error(`applying decision of ${a.id} to task failed`, e);
    }
    logger.info(`approval ${a.id} ${r.status} (${r.decision}) by ${decided.decided_by}`);
    return decided;
  }

  function pending(): Approval[] {
    return repo.approvals.pending();
  }

  function expireDue(now = new Date()): Approval[] {
    const iso = now.toISOString();
    const due = repo.approvals.pending().filter((a) => a.expires_at && a.expires_at <= iso);
    const out: Approval[] = [];
    for (const a of due) {
      const e = expireApproval(a, iso);
      if (e) out.push(e);
    }
    if (out.length) logger.info(`expired ${out.length} approval(s)`);
    return out;
  }

  return { request, waitForDecision, decide, pending, expireDue };
}

function resumeOf(a: Approval, r: ResolvedDecision) {
  return { approvalId: a.id, kind: a.kind, decision: r.decision, note: r.note, editedPayload: r.editedPayload, decidedAt: nowIso() };
}

function appendNote(existing: unknown, note: string): string[] {
  const arr = Array.isArray(existing) ? existing.map(String) : typeof existing === "string" && existing ? [existing] : [];
  return [...arr, `${nowIso()} ${note}`];
}

/** Expire overdue approvals without a full service (maintenance job helper). */
export function expireDueApprovals(deps: { repo: Repo; bus: Bus; logger: Logger }, now = new Date()): Approval[] {
  const svc = createApprovalService({
    ...deps,
    notifier: { notify: async () => {} },
    config: { approval: { expire_hours: 72, wait_seconds: 600 }, locale: "en", server: { public_url: "" } } as unknown as Config,
  });
  return svc.expireDue(now);
}

/**
 * Build the inbound handler channels call (Telegram commands, buttons). Converts
 * service errors into friendly, idempotent replies.
 */
export function createInboundHandler(deps: {
  approvals: ApprovalService;
  repo: Repo;
  locale?: string;
  capture?: (text: string, by: string) => Promise<{ ok: boolean; message: string }>;
  status?: () => Promise<string>;
}): InboundHandler {
  const zh = (deps.locale ?? "en").toLowerCase().startsWith("zh");
  const label = (status: string, decision: string | null) =>
    zh
      ? ({ approved: "已批准", rejected: "已拒绝", edited: "已修改并批准", expired: "已过期", cancelled: "已取消", pending: "待处理" }[status] ?? status) + (decision && !["approve", "reject", "edit"].includes(decision) ? ` (${decision})` : "")
      : `${status}${decision && !["approve", "reject", "edit"].includes(decision) ? ` (${decision})` : ""}`;
  return {
    async decide(d) {
      try {
        const a = await deps.approvals.decide(d);
        return { ok: true, message: `${zh ? "✅ 已记录" : "✅ Recorded"}: ${a.id} ${label(a.status, a.decision)}${a.task_id ? ` · ${zh ? "任务" : "task"} ${a.task_id}` : ""}` };
      } catch (e) {
        if (e instanceof ApprovalNotPendingError) {
          const a = e.approval;
          const same = (a.decision === d.decision) || (d.decision === "approve" && a.status === "approved") || (d.decision === "reject" && a.status === "rejected");
          const msg = zh ? `${a.id} ${label(a.status, a.decision)}${a.decided_by ? `（${a.decided_by}）` : ""}，无需再处理。` : `${a.id} is already ${label(a.status, a.decision)}${a.decided_by ? ` (by ${a.decided_by})` : ""}; nothing to do.`;
          return { ok: same && a.status !== "expired", message: (same ? "ℹ️ " : "⚠️ ") + msg };
        }
        if (e instanceof ApprovalNotFoundError) return { ok: false, message: zh ? `⚠️ 找不到审批 ${d.approvalId}` : `⚠️ Approval ${d.approvalId} not found` };
        return { ok: false, message: `⚠️ ${(e as Error).message}` };
      }
    },
    capture: deps.capture,
    status:
      deps.status ??
      (async () => {
        const t = deps.repo.tasks.counts();
        const ap = deps.repo.approvals.counts();
        const ib = deps.repo.inbox.counts();
        return zh
          ? `待审批 ${ap.pending ?? 0} · 运行中 ${t.running ?? 0} · 等待人工 ${t.waiting_human ?? 0} · 就绪 ${t.ready ?? 0} · 待复核 ${t.review ?? 0} · 已完成 ${t.done ?? 0} · Inbox 新条目 ${ib.new ?? 0}`
          : `pending approvals ${ap.pending ?? 0} · running ${t.running ?? 0} · waiting_human ${t.waiting_human ?? 0} · ready ${t.ready ?? 0} · review ${t.review ?? 0} · done ${t.done ?? 0} · new inbox ${ib.new ?? 0}`;
      }),
  };
}
