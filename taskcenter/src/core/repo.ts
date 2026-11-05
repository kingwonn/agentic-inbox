/**
 * Repository layer: typed data access for every table.
 * JSON columns are (de)serialized here; callers work with domain objects.
 */
import { createHash } from "node:crypto";
import type { Db, Param, Row } from "./db.js";
import { ID_PREFIX, newId } from "./ids.js";
import { nowIso } from "./time.js";
import type {
  Approval,
  ApprovalStatus,
  Artifact,
  BudgetDay,
  Event,
  InboxItem,
  InboxStatus,
  Memory,
  NewApproval,
  NewArtifact,
  NewEvent,
  NewMemory,
  NewSignal,
  NewTask,
  Notification,
  Run,
  RunReason,
  RunStatus,
  Schedule,
  SensorCursor,
  Signal,
  Task,
  TaskStatus,
} from "./types.js";

type JsonCols = readonly string[];

function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === "") return fallback;
  if (typeof v !== "string") return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function toRow(obj: Record<string, unknown>, jsonCols: JsonCols): Record<string, Param> {
  const out: Record<string, Param> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (jsonCols.includes(k)) out[k] = v === null ? null : JSON.stringify(v);
    else if (typeof v === "boolean") out[k] = v ? 1 : 0;
    else out[k] = v as Param;
  }
  return out;
}

function fromRow<T>(row: Row | undefined, jsonCols: JsonCols, jsonDefaults: Record<string, unknown> = {}): T | undefined {
  if (!row) return undefined;
  const out: Record<string, unknown> = { ...row };
  for (const c of jsonCols) {
    out[c] = parseJson(row[c], jsonDefaults[c] ?? null);
  }
  return out as T;
}

function insertSql(table: string, row: Record<string, Param>): [string, Param[]] {
  const cols = Object.keys(row);
  return [
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    cols.map((c) => row[c]),
  ];
}

function updateSql(table: string, idCol: string, id: string, row: Record<string, Param>): [string, Param[]] {
  const cols = Object.keys(row);
  if (cols.length === 0) return [`SELECT 1`, []];
  return [
    `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE ${idCol} = ?`,
    [...cols.map((c) => row[c]), id],
  ];
}

export function fingerprintOf(parts: unknown[]): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 20);
}

// ── Signals ─────────────────────────────────────────────────────────

const SIGNAL_JSON = ["metadata"] as const;
const SIGNAL_DEFAULTS = { metadata: {} };

export class SignalRepo {
  constructor(private db: Db) {}

  get(id: string): Signal | undefined {
    return fromRow<Signal>(this.db.get("SELECT * FROM signals WHERE id = ?", id), SIGNAL_JSON, SIGNAL_DEFAULTS);
  }

  getByExternal(source: string, externalId: string): Signal | undefined {
    return fromRow<Signal>(
      this.db.get("SELECT * FROM signals WHERE source = ? AND external_id = ?", source, externalId),
      SIGNAL_JSON,
      SIGNAL_DEFAULTS,
    );
  }

  /** Insert or update. Returns the stored signal and whether it is new/changed. */
  upsert(input: NewSignal): { signal: Signal; isNew: boolean; changed: boolean } {
    const now = nowIso();
    const metadata = input.metadata ?? {};
    const fingerprint = fingerprintOf([input.title, input.body, metadata]);
    const existing = this.getByExternal(input.source, input.external_id);
    if (!existing) {
      const signal: Signal = {
        id: newId(ID_PREFIX.signal),
        source: input.source,
        external_id: input.external_id,
        kind: input.kind,
        title: input.title,
        body: input.body ?? "",
        url: input.url ?? null,
        actor: input.actor ?? null,
        occurred_at: input.occurred_at ?? now,
        observed_at: now,
        updated_at: now,
        fingerprint,
        metadata,
        inbox_item_id: null,
        triaged: 0,
      };
      const [sql, params] = insertSql("signals", toRow(signal as unknown as Record<string, unknown>, SIGNAL_JSON));
      this.db.run(sql, ...params);
      return { signal, isNew: true, changed: true };
    }
    if (existing.fingerprint === fingerprint) return { signal: existing, isNew: false, changed: false };
    const patch = {
      kind: input.kind,
      title: input.title,
      body: input.body ?? "",
      url: input.url ?? existing.url,
      actor: input.actor ?? existing.actor,
      occurred_at: input.occurred_at ?? existing.occurred_at,
      updated_at: now,
      fingerprint,
      metadata,
      triaged: 0, // re-triage on change
    };
    const [sql, params] = updateSql("signals", "id", existing.id, toRow(patch, SIGNAL_JSON));
    this.db.run(sql, ...params);
    return { signal: { ...existing, ...patch, triaged: 0 }, isNew: false, changed: true };
  }

  update(id: string, patch: Partial<Signal>): void {
    const [sql, params] = updateSql("signals", "id", id, toRow({ ...patch, updated_at: nowIso() }, SIGNAL_JSON));
    this.db.run(sql, ...params);
  }

  listUntriaged(limit = 50): Signal[] {
    return this.db
      .all("SELECT * FROM signals WHERE triaged = 0 ORDER BY occurred_at DESC LIMIT ?", limit)
      .map((r) => fromRow<Signal>(r, SIGNAL_JSON, SIGNAL_DEFAULTS)!);
  }

  list(opts: { source?: string; limit?: number; offset?: number; q?: string } = {}): Signal[] {
    const params: Param[] = [];
    let where = "1=1";
    if (opts.source) {
      where += " AND source = ?";
      params.push(opts.source);
    }
    let sql = `SELECT * FROM signals WHERE ${where} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`;
    if (opts.q) {
      sql = `SELECT s.* FROM signals_fts f JOIN signals s ON s.rowid = f.rowid WHERE signals_fts MATCH ? AND ${where.replace(/source/g, "s.source")} ORDER BY s.occurred_at DESC LIMIT ? OFFSET ?`;
      params.unshift(opts.q);
    }
    params.push(opts.limit ?? 50, opts.offset ?? 0);
    return this.db.all(sql, ...params).map((r) => fromRow<Signal>(r, SIGNAL_JSON, SIGNAL_DEFAULTS)!);
  }

  getMany(ids: string[]): Signal[] {
    if (ids.length === 0) return [];
    const sql = `SELECT * FROM signals WHERE id IN (${ids.map(() => "?").join(",")})`;
    return this.db.all(sql, ...ids).map((r) => fromRow<Signal>(r, SIGNAL_JSON, SIGNAL_DEFAULTS)!);
  }

  count(): number {
    return (this.db.get<{ n: number }>("SELECT COUNT(*) n FROM signals")?.n as number) ?? 0;
  }
}

// ── Inbox ───────────────────────────────────────────────────────────

const INBOX_JSON = ["source_signal_ids", "tags"] as const;
const INBOX_DEFAULTS = { source_signal_ids: [], tags: [] };

export class InboxRepo {
  constructor(private db: Db) {}

  create(input: Omit<InboxItem, "id" | "created_at" | "updated_at" | "status" | "task_id" | "snoozed_until"> & Partial<Pick<InboxItem, "status" | "task_id" | "snoozed_until">>): InboxItem {
    const now = nowIso();
    const item: InboxItem = {
      id: newId(ID_PREFIX.inbox),
      status: "new",
      task_id: null,
      snoozed_until: null,
      ...input,
      created_at: now,
      updated_at: now,
    };
    const [sql, params] = insertSql("inbox_items", toRow(item as unknown as Record<string, unknown>, INBOX_JSON));
    this.db.run(sql, ...params);
    return item;
  }

  get(id: string): InboxItem | undefined {
    return fromRow<InboxItem>(this.db.get("SELECT * FROM inbox_items WHERE id = ?", id), INBOX_JSON, INBOX_DEFAULTS);
  }

  update(id: string, patch: Partial<InboxItem>): InboxItem | undefined {
    const [sql, params] = updateSql("inbox_items", "id", id, toRow({ ...patch, updated_at: nowIso() }, INBOX_JSON));
    this.db.run(sql, ...params);
    return this.get(id);
  }

  list(opts: { status?: InboxStatus | InboxStatus[]; limit?: number; offset?: number } = {}): InboxItem[] {
    const params: Param[] = [];
    let where = "1=1";
    if (opts.status) {
      const st = Array.isArray(opts.status) ? opts.status : [opts.status];
      where += ` AND status IN (${st.map(() => "?").join(",")})`;
      params.push(...st);
    }
    params.push(opts.limit ?? 100, opts.offset ?? 0);
    return this.db
      .all(`SELECT * FROM inbox_items WHERE ${where} ORDER BY priority ASC, created_at DESC LIMIT ? OFFSET ?`, ...params)
      .map((r) => fromRow<InboxItem>(r, INBOX_JSON, INBOX_DEFAULTS)!);
  }

  /** Items whose snooze has elapsed. */
  dueSnoozed(now = nowIso()): InboxItem[] {
    return this.db
      .all("SELECT * FROM inbox_items WHERE status = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ?", now)
      .map((r) => fromRow<InboxItem>(r, INBOX_JSON, INBOX_DEFAULTS)!);
  }

  counts(): Record<string, number> {
    const rows = this.db.all<{ status: string; n: number }>("SELECT status, COUNT(*) n FROM inbox_items GROUP BY status");
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}

// ── Tasks ───────────────────────────────────────────────────────────

const TASK_JSON = ["plan", "depends_on", "acceptance_criteria", "labels", "context"] as const;
const TASK_DEFAULTS = { plan: null, depends_on: [], acceptance_criteria: [], labels: [], context: {} };

export class TaskRepo {
  constructor(private db: Db) {}

  create(input: NewTask): Task {
    const now = nowIso();
    const task: Task = {
      id: newId(ID_PREFIX.task),
      parent_id: null,
      description: "",
      kind: "todo",
      category: "other",
      priority: "P2",
      level: 2,
      status: "todo",
      owner: "ai",
      runner: null,
      model: null,
      plan: null,
      depends_on: [],
      acceptance_criteria: [],
      deadline: null,
      follow_up_at: null,
      attempts: 0,
      max_attempts: 3,
      budget_usd: 2,
      cost_usd: 0,
      result_summary: null,
      last_error: null,
      inbox_item_id: null,
      workspace: null,
      labels: [],
      context: {},
      started_at: null,
      finished_at: null,
      ...input,
      created_at: now,
      updated_at: now,
    };
    const [sql, params] = insertSql("tasks", toRow(task as unknown as Record<string, unknown>, TASK_JSON));
    this.db.run(sql, ...params);
    return task;
  }

  get(id: string): Task | undefined {
    return fromRow<Task>(this.db.get("SELECT * FROM tasks WHERE id = ?", id), TASK_JSON, TASK_DEFAULTS);
  }

  update(id: string, patch: Partial<Task>): Task | undefined {
    const [sql, params] = updateSql("tasks", "id", id, toRow({ ...patch, updated_at: nowIso() }, TASK_JSON));
    this.db.run(sql, ...params);
    return this.get(id);
  }

  list(opts: { status?: TaskStatus | TaskStatus[]; parent_id?: string | null; limit?: number; offset?: number; includeChildren?: boolean } = {}): Task[] {
    const params: Param[] = [];
    let where = "1=1";
    if (opts.status) {
      const st = Array.isArray(opts.status) ? opts.status : [opts.status];
      where += ` AND status IN (${st.map(() => "?").join(",")})`;
      params.push(...st);
    }
    if (opts.parent_id !== undefined) {
      if (opts.parent_id === null) where += " AND parent_id IS NULL";
      else {
        where += " AND parent_id = ?";
        params.push(opts.parent_id);
      }
    }
    params.push(opts.limit ?? 200, opts.offset ?? 0);
    return this.db
      .all(`SELECT * FROM tasks WHERE ${where} ORDER BY priority ASC, created_at DESC LIMIT ? OFFSET ?`, ...params)
      .map((r) => fromRow<Task>(r, TASK_JSON, TASK_DEFAULTS)!);
  }

  children(parentId: string): Task[] {
    return this.db
      .all("SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC", parentId)
      .map((r) => fromRow<Task>(r, TASK_JSON, TASK_DEFAULTS)!);
  }

  /** Tasks that could run now: status ready/todo with all dependencies done. */
  runnable(limit = 20): Task[] {
    const candidates = this.list({ status: ["ready"], limit: 500 });
    const out: Task[] = [];
    for (const t of candidates) {
      if (this.dependenciesSatisfied(t)) out.push(t);
      if (out.length >= limit) break;
    }
    return out;
  }

  dependenciesSatisfied(t: Task): boolean {
    for (const dep of t.depends_on) {
      const d = this.get(dep);
      if (!d) continue; // missing dependency: treat as satisfied
      if (d.status !== "done") return false;
    }
    return true;
  }

  dueFollowUps(now = nowIso()): Task[] {
    return this.db
      .all("SELECT * FROM tasks WHERE follow_up_at IS NOT NULL AND follow_up_at <= ? AND status IN ('waiting_human','blocked','todo')", now)
      .map((r) => fromRow<Task>(r, TASK_JSON, TASK_DEFAULTS)!);
  }

  counts(): Record<string, number> {
    const rows = this.db.all<{ status: string; n: number }>("SELECT status, COUNT(*) n FROM tasks GROUP BY status");
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  addCost(id: string, usd: number): void {
    this.db.run("UPDATE tasks SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?", usd, nowIso(), id);
  }
}

// ── Runs ────────────────────────────────────────────────────────────

const RUN_JSON = ["result"] as const;
const RUN_DEFAULTS = { result: null };

export class RunRepo {
  constructor(private db: Db) {}

  create(input: Pick<Run, "task_id" | "runner" | "model"> & Partial<Pick<Run, "attempt" | "reason" | "resume_of" | "session_id" | "status">>): Run {
    const now = nowIso();
    const run: Run = {
      id: newId(ID_PREFIX.run),
      attempt: 1,
      status: "queued",
      session_id: null,
      resume_of: null,
      reason: "scheduled" as RunReason,
      started_at: null,
      ended_at: null,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      num_turns: 0,
      result: null,
      result_text: null,
      error: null,
      ...input,
      created_at: now,
      updated_at: now,
    };
    const [sql, params] = insertSql("runs", toRow(run as unknown as Record<string, unknown>, RUN_JSON));
    this.db.run(sql, ...params);
    return run;
  }

  get(id: string): Run | undefined {
    return fromRow<Run>(this.db.get("SELECT * FROM runs WHERE id = ?", id), RUN_JSON, RUN_DEFAULTS);
  }

  update(id: string, patch: Partial<Run>): Run | undefined {
    const [sql, params] = updateSql("runs", "id", id, toRow({ ...patch, updated_at: nowIso() }, RUN_JSON));
    this.db.run(sql, ...params);
    return this.get(id);
  }

  listByTask(taskId: string): Run[] {
    return this.db
      .all("SELECT * FROM runs WHERE task_id = ? ORDER BY created_at ASC", taskId)
      .map((r) => fromRow<Run>(r, RUN_JSON, RUN_DEFAULTS)!);
  }

  list(opts: { status?: RunStatus | RunStatus[]; limit?: number; offset?: number } = {}): Run[] {
    const params: Param[] = [];
    let where = "1=1";
    if (opts.status) {
      const st = Array.isArray(opts.status) ? opts.status : [opts.status];
      where += ` AND status IN (${st.map(() => "?").join(",")})`;
      params.push(...st);
    }
    params.push(opts.limit ?? 100, opts.offset ?? 0);
    return this.db
      .all(`SELECT * FROM runs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params)
      .map((r) => fromRow<Run>(r, RUN_JSON, RUN_DEFAULTS)!);
  }

  active(): Run[] {
    return this.list({ status: ["queued", "running"], limit: 1000 });
  }

  latestForTask(taskId: string): Run | undefined {
    return fromRow<Run>(
      this.db.get("SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", taskId),
      RUN_JSON,
      RUN_DEFAULTS,
    );
  }
}

// ── Events ──────────────────────────────────────────────────────────

const EVENT_JSON = ["payload"] as const;
const EVENT_DEFAULTS = { payload: {} };

export class EventRepo {
  constructor(private db: Db) {}

  append(input: NewEvent): Event {
    const ev: Event = {
      id: newId(ID_PREFIX.event),
      ts: nowIso(),
      task_id: input.task_id ?? null,
      run_id: input.run_id ?? null,
      level: input.level ?? "info",
      type: input.type,
      message: input.message,
      payload: input.payload ?? {},
    };
    const [sql, params] = insertSql("events", toRow(ev as unknown as Record<string, unknown>, EVENT_JSON));
    this.db.run(sql, ...params);
    return ev;
  }

  list(opts: { task_id?: string; run_id?: string; type?: string | string[]; level?: string; since?: string; limit?: number; offset?: number; after_id?: string } = {}): Event[] {
    const params: Param[] = [];
    let where = "1=1";
    if (opts.task_id) {
      where += " AND task_id = ?";
      params.push(opts.task_id);
    }
    if (opts.run_id) {
      where += " AND run_id = ?";
      params.push(opts.run_id);
    }
    if (opts.type) {
      const t = Array.isArray(opts.type) ? opts.type : [opts.type];
      where += ` AND type IN (${t.map(() => "?").join(",")})`;
      params.push(...t);
    }
    if (opts.level) {
      where += " AND level = ?";
      params.push(opts.level);
    }
    if (opts.since) {
      where += " AND ts >= ?";
      params.push(opts.since);
    }
    if (opts.after_id) {
      where += " AND id > ?";
      params.push(opts.after_id);
    }
    params.push(opts.limit ?? 200, opts.offset ?? 0);
    return this.db
      .all(`SELECT * FROM events WHERE ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`, ...params)
      .map((r) => fromRow<Event>(r, EVENT_JSON, EVENT_DEFAULTS)!);
  }

  count(opts: { type?: string; since?: string; level?: string } = {}): number {
    const params: Param[] = [];
    let where = "1=1";
    if (opts.type) {
      where += " AND type = ?";
      params.push(opts.type);
    }
    if (opts.level) {
      where += " AND level = ?";
      params.push(opts.level);
    }
    if (opts.since) {
      where += " AND ts >= ?";
      params.push(opts.since);
    }
    return this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM events WHERE ${where}`, ...params)?.n ?? 0;
  }
}

// ── Approvals (Outbox) ──────────────────────────────────────────────

const APPROVAL_JSON = ["options", "payload", "edited_payload", "channel_refs"] as const;
const APPROVAL_DEFAULTS = { options: [], payload: {}, edited_payload: null, channel_refs: {} };

export class ApprovalRepo {
  constructor(private db: Db) {}

  create(input: NewApproval): Approval {
    const now = nowIso();
    const a: Approval = {
      id: newId(ID_PREFIX.approval),
      task_id: input.task_id ?? null,
      run_id: input.run_id ?? null,
      kind: input.kind,
      title: input.title,
      context: input.context ?? "",
      recommendation: input.recommendation ?? "",
      options: input.options ?? [
        { value: "approve", label: "Approve" },
        { value: "reject", label: "Reject" },
      ],
      payload: input.payload ?? {},
      risk: input.risk ?? "medium",
      status: "pending",
      decision: null,
      decision_note: null,
      edited_payload: null,
      decided_by: null,
      decided_at: null,
      expires_at: input.expires_at ?? null,
      channel_refs: {},
      created_at: now,
      updated_at: now,
    };
    const [sql, params] = insertSql("approvals", toRow(a as unknown as Record<string, unknown>, APPROVAL_JSON));
    this.db.run(sql, ...params);
    return a;
  }

  get(id: string): Approval | undefined {
    return fromRow<Approval>(this.db.get("SELECT * FROM approvals WHERE id = ?", id), APPROVAL_JSON, APPROVAL_DEFAULTS);
  }

  update(id: string, patch: Partial<Approval>): Approval | undefined {
    const [sql, params] = updateSql("approvals", "id", id, toRow({ ...patch, updated_at: nowIso() }, APPROVAL_JSON));
    this.db.run(sql, ...params);
    return this.get(id);
  }

  /** Atomically decide a pending approval. Returns false if it was not pending. */
  decide(id: string, patch: Pick<Approval, "status" | "decision"> & Partial<Pick<Approval, "decision_note" | "edited_payload" | "decided_by">>): boolean {
    const now = nowIso();
    const r = this.db.run(
      "UPDATE approvals SET status = ?, decision = ?, decision_note = ?, edited_payload = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      patch.status,
      patch.decision,
      patch.decision_note ?? null,
      patch.edited_payload ? JSON.stringify(patch.edited_payload) : null,
      patch.decided_by ?? "human",
      now,
      now,
      id,
    );
    return r.changes === 1;
  }

  list(opts: { status?: ApprovalStatus | ApprovalStatus[]; task_id?: string; limit?: number; offset?: number } = {}): Approval[] {
    const params: Param[] = [];
    let where = "1=1";
    if (opts.status) {
      const st = Array.isArray(opts.status) ? opts.status : [opts.status];
      where += ` AND status IN (${st.map(() => "?").join(",")})`;
      params.push(...st);
    }
    if (opts.task_id) {
      where += " AND task_id = ?";
      params.push(opts.task_id);
    }
    params.push(opts.limit ?? 100, opts.offset ?? 0);
    return this.db
      .all(`SELECT * FROM approvals WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params)
      .map((r) => fromRow<Approval>(r, APPROVAL_JSON, APPROVAL_DEFAULTS)!);
  }

  pending(): Approval[] {
    return this.list({ status: "pending", limit: 500 });
  }

  expireDue(now = nowIso()): Approval[] {
    const due = this.db
      .all("SELECT * FROM approvals WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?", now)
      .map((r) => fromRow<Approval>(r, APPROVAL_JSON, APPROVAL_DEFAULTS)!);
    for (const a of due) this.update(a.id, { status: "expired" });
    return due;
  }

  counts(): Record<string, number> {
    const rows = this.db.all<{ status: string; n: number }>("SELECT status, COUNT(*) n FROM approvals GROUP BY status");
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}

// ── Artifacts ───────────────────────────────────────────────────────

export class ArtifactRepo {
  constructor(private db: Db) {}

  create(input: NewArtifact): Artifact {
    const a: Artifact = {
      id: newId(ID_PREFIX.artifact),
      run_id: input.run_id ?? null,
      path: input.path ?? null,
      url: input.url ?? null,
      content: input.content ?? null,
      mime: input.mime ?? null,
      size: input.size ?? (input.content ? Buffer.byteLength(input.content) : null),
      task_id: input.task_id,
      type: input.type,
      title: input.title,
      created_at: nowIso(),
    };
    const [sql, params] = insertSql("artifacts", toRow(a as unknown as Record<string, unknown>, []));
    this.db.run(sql, ...params);
    return a;
  }

  get(id: string): Artifact | undefined {
    return fromRow<Artifact>(this.db.get("SELECT * FROM artifacts WHERE id = ?", id), []);
  }

  listByTask(taskId: string): Artifact[] {
    return this.db.all("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC", taskId).map((r) => fromRow<Artifact>(r, [])!);
  }

  list(opts: { limit?: number; offset?: number } = {}): Artifact[] {
    return this.db
      .all("SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ? OFFSET ?", opts.limit ?? 100, opts.offset ?? 0)
      .map((r) => fromRow<Artifact>(r, [])!);
  }
}

// ── Notifications ───────────────────────────────────────────────────

export class NotificationRepo {
  constructor(private db: Db) {}

  create(input: Omit<Notification, "id" | "sent_at"> & Partial<Pick<Notification, "sent_at">>): Notification {
    const n: Notification = { id: newId(ID_PREFIX.notification), sent_at: nowIso(), ...input };
    const [sql, params] = insertSql("notifications", toRow(n as unknown as Record<string, unknown>, []));
    this.db.run(sql, ...params);
    return n;
  }

  existsFor(approvalId: string, channel: string): boolean {
    return !!this.db.get("SELECT 1 FROM notifications WHERE approval_id = ? AND channel = ? AND status = 'sent'", approvalId, channel);
  }

  list(opts: { limit?: number; offset?: number } = {}): Notification[] {
    return this.db
      .all("SELECT * FROM notifications ORDER BY sent_at DESC LIMIT ? OFFSET ?", opts.limit ?? 100, opts.offset ?? 0)
      .map((r) => fromRow<Notification>(r, [])!);
  }
}

// ── Memories ────────────────────────────────────────────────────────

const MEMORY_JSON = ["tags"] as const;
const MEMORY_DEFAULTS = { tags: [] };

export class MemoryRepo {
  constructor(private db: Db) {}

  create(input: NewMemory): Memory {
    const now = nowIso();
    const m: Memory = {
      id: newId(ID_PREFIX.memory),
      confidence: 0.7,
      tags: [],
      valid_from: now,
      valid_to: null,
      ...input,
      created_at: now,
      updated_at: now,
    };
    const [sql, params] = insertSql("memories", toRow(m as unknown as Record<string, unknown>, MEMORY_JSON));
    this.db.run(sql, ...params);
    return m;
  }

  /** Insert unless an identical active memory already exists. */
  upsertByContent(input: NewMemory): { memory: Memory; isNew: boolean } {
    const existing = fromRow<Memory>(
      this.db.get("SELECT * FROM memories WHERE content = ? AND valid_to IS NULL", input.content),
      MEMORY_JSON,
      MEMORY_DEFAULTS,
    );
    if (existing) {
      const conf = Math.min(1, Math.max(existing.confidence, input.confidence ?? 0.7) + 0.05);
      this.update(existing.id, { confidence: conf });
      return { memory: { ...existing, confidence: conf }, isNew: false };
    }
    return { memory: this.create(input), isNew: true };
  }

  get(id: string): Memory | undefined {
    return fromRow<Memory>(this.db.get("SELECT * FROM memories WHERE id = ?", id), MEMORY_JSON, MEMORY_DEFAULTS);
  }

  update(id: string, patch: Partial<Memory>): void {
    const [sql, params] = updateSql("memories", "id", id, toRow({ ...patch, updated_at: nowIso() }, MEMORY_JSON));
    this.db.run(sql, ...params);
  }

  active(opts: { kind?: string; minConfidence?: number; limit?: number } = {}): Memory[] {
    const params: Param[] = [];
    let where = "valid_to IS NULL";
    if (opts.kind) {
      where += " AND kind = ?";
      params.push(opts.kind);
    }
    if (opts.minConfidence !== undefined) {
      where += " AND confidence >= ?";
      params.push(opts.minConfidence);
    }
    params.push(opts.limit ?? 200);
    return this.db
      .all(`SELECT * FROM memories WHERE ${where} ORDER BY confidence DESC, updated_at DESC LIMIT ?`, ...params)
      .map((r) => fromRow<Memory>(r, MEMORY_JSON, MEMORY_DEFAULTS)!);
  }

  retire(id: string): void {
    this.update(id, { valid_to: nowIso() });
  }
}

// ── Cursors, schedules, budgets ─────────────────────────────────────

export class CursorRepo {
  constructor(private db: Db) {}

  get(sensor: string, key: string): string | undefined {
    return this.db.get<{ value: string }>("SELECT value FROM sensor_cursors WHERE sensor = ? AND key = ?", sensor, key)?.value;
  }

  set(sensor: string, key: string, value: string): void {
    this.db.run(
      "INSERT INTO sensor_cursors (sensor, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(sensor, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      sensor,
      key,
      value,
      nowIso(),
    );
  }

  all(sensor?: string): SensorCursor[] {
    if (sensor) return this.db.all<SensorCursor>("SELECT * FROM sensor_cursors WHERE sensor = ?", sensor);
    return this.db.all<SensorCursor>("SELECT * FROM sensor_cursors");
  }

  clear(sensor: string): void {
    this.db.run("DELETE FROM sensor_cursors WHERE sensor = ?", sensor);
  }
}

export class ScheduleRepo {
  constructor(private db: Db) {}

  upsert(s: Pick<Schedule, "name" | "cron" | "job"> & Partial<Schedule>): void {
    this.db.run(
      `INSERT INTO schedules (name, cron, job, enabled, last_run_at, last_status, last_error, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET cron = excluded.cron, job = excluded.job, enabled = COALESCE(?, schedules.enabled)`,
      s.name,
      s.cron,
      s.job,
      s.enabled ?? 1,
      s.last_run_at ?? null,
      s.last_status ?? null,
      s.last_error ?? null,
      s.next_run_at ?? null,
      s.enabled ?? null,
    );
  }

  update(name: string, patch: Partial<Schedule>): void {
    const [sql, params] = updateSql("schedules", "name", name, toRow(patch, []));
    this.db.run(sql, ...params);
  }

  all(): Schedule[] {
    return this.db.all<Schedule>("SELECT * FROM schedules ORDER BY name");
  }

  get(name: string): Schedule | undefined {
    return this.db.get<Schedule>("SELECT * FROM schedules WHERE name = ?", name);
  }
}

export class BudgetRepo {
  constructor(private db: Db) {}

  add(day: string, usd: number, runs = 1): void {
    this.db.run(
      "INSERT INTO budgets (day, cost_usd, runs) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd, runs = runs + excluded.runs",
      day,
      usd,
      runs,
    );
  }

  get(day: string): BudgetDay {
    return this.db.get<BudgetDay>("SELECT * FROM budgets WHERE day = ?", day) ?? { day, cost_usd: 0, runs: 0 };
  }

  recent(days = 30): BudgetDay[] {
    return this.db.all<BudgetDay>("SELECT * FROM budgets ORDER BY day DESC LIMIT ?", days);
  }
}

export class MetaRepo {
  constructor(private db: Db) {}
  get(key: string): string | undefined {
    return this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
  }
  set(key: string, value: string): void {
    this.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
}

// ── Aggregate ───────────────────────────────────────────────────────

export class Repo {
  readonly signals: SignalRepo;
  readonly inbox: InboxRepo;
  readonly tasks: TaskRepo;
  readonly runs: RunRepo;
  readonly events: EventRepo;
  readonly approvals: ApprovalRepo;
  readonly artifacts: ArtifactRepo;
  readonly notifications: NotificationRepo;
  readonly memories: MemoryRepo;
  readonly cursors: CursorRepo;
  readonly schedules: ScheduleRepo;
  readonly budgets: BudgetRepo;
  readonly meta: MetaRepo;

  constructor(readonly db: Db) {
    this.signals = new SignalRepo(db);
    this.inbox = new InboxRepo(db);
    this.tasks = new TaskRepo(db);
    this.runs = new RunRepo(db);
    this.events = new EventRepo(db);
    this.approvals = new ApprovalRepo(db);
    this.artifacts = new ArtifactRepo(db);
    this.notifications = new NotificationRepo(db);
    this.memories = new MemoryRepo(db);
    this.cursors = new CursorRepo(db);
    this.schedules = new ScheduleRepo(db);
    this.budgets = new BudgetRepo(db);
    this.meta = new MetaRepo(db);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }
}
