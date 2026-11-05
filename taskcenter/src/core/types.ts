/**
 * Core domain types for the Task Center.
 *
 * Everything that is persisted in SQLite is described here. JSON columns are
 * typed as objects/arrays; the repository layer serializes them.
 */

// ── Enumerations ────────────────────────────────────────────────────

export const INBOX_KINDS = ["todo", "problem", "opportunity", "decision", "info"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const LEVELS = [1, 2, 3, 4, 5] as const;
export type Level = (typeof LEVELS)[number];

export const CATEGORIES = [
  "code",
  "research",
  "writing",
  "communication",
  "external_communication",
  "scheduling",
  "finance",
  "publishing",
  "ops",
  "learning",
  "personal",
  "admin",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const INBOX_STATUSES = ["new", "triaged", "promoted", "dismissed", "snoozed", "done"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export const TASK_STATUSES = [
  "todo",
  "planning",
  "ready",
  "running",
  "waiting_human",
  "review",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_human",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_REASONS = [
  "scheduled",
  "manual",
  "retry",
  "resume_after_approval",
  "dependency_unblocked",
  "follow_up",
  "recovery",
] as const;
export type RunReason = (typeof RUN_REASONS)[number];

export const DECISIONS = ["approve", "edit", "reject", "respond"] as const;
export type Decision = (typeof DECISIONS)[number];

export const APPROVAL_KINDS = ["action", "decision", "review", "question"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "edited", "expired", "cancelled"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const RISKS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];

export const ARTIFACT_TYPES = ["file", "url", "text", "pr", "email_draft", "document", "patch"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const EVENT_LEVELS = ["debug", "info", "warn", "error"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

export const EVENT_TYPES = [
  "tool_call",
  "tool_result",
  "assistant_message",
  "status_change",
  "approval_requested",
  "approval_decided",
  "notification",
  "error",
  "cost",
  "sensor_poll",
  "triage",
  "plan",
  "run_started",
  "run_finished",
  "artifact",
  "memory",
  "system",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const MEMORY_KINDS = ["fact", "preference", "project", "person", "habit", "goal"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type TaskOwner = "ai" | "human";

// ── Entities ────────────────────────────────────────────────────────

export interface Signal {
  id: string;
  source: string; // sensor name, e.g. "github", "imap", "ics", "localgit", "fsdocs", "manual"
  external_id: string; // stable id within the source
  kind: string; // source-specific kind, e.g. "pull_request", "email", "event", "uncommitted_changes"
  title: string;
  body: string;
  url: string | null;
  actor: string | null;
  occurred_at: string; // ISO
  observed_at: string; // ISO (first seen)
  updated_at: string; // ISO (last change)
  fingerprint: string; // hash of (title, body, metadata) to detect updates
  metadata: Record<string, unknown>;
  inbox_item_id: string | null;
  triaged: 0 | 1;
}

export interface InboxItem {
  id: string;
  kind: InboxKind;
  title: string;
  summary: string;
  category: Category;
  priority: Priority;
  level: Level;
  level_proposed: Level;
  level_reason: string;
  confidence: number; // 0..1
  suggested_action: string;
  status: InboxStatus;
  snoozed_until: string | null;
  task_id: string | null;
  source_signal_ids: string[];
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface TaskPlanStep {
  id: string;
  title: string;
  description?: string;
  needs_approval?: boolean;
  tools?: string[];
  done?: boolean;
}

export interface TaskPlan {
  goal: string;
  steps: TaskPlanStep[];
  required_capabilities: string[];
  risks: string[];
  acceptance_criteria: string[];
  estimated_cost_usd?: number;
  notes?: string;
}

export interface Task {
  id: string;
  parent_id: string | null;
  title: string;
  description: string;
  kind: InboxKind;
  category: Category;
  priority: Priority;
  level: Level;
  status: TaskStatus;
  owner: TaskOwner;
  runner: string | null; // runner name override
  model: string | null; // model override
  plan: TaskPlan | null;
  depends_on: string[];
  acceptance_criteria: string[];
  deadline: string | null;
  follow_up_at: string | null;
  attempts: number;
  max_attempts: number;
  budget_usd: number;
  cost_usd: number;
  result_summary: string | null;
  last_error: string | null;
  inbox_item_id: string | null;
  workspace: string | null;
  labels: string[];
  context: Record<string, unknown>; // free-form context handed to the agent (signal excerpts, links)
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Run {
  id: string;
  task_id: string;
  attempt: number;
  runner: string;
  model: string;
  status: RunStatus;
  session_id: string | null;
  resume_of: string | null;
  reason: RunReason;
  started_at: string | null;
  ended_at: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  num_turns: number;
  result: AgentOutput | null;
  result_text: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Event {
  id: string;
  ts: string;
  task_id: string | null;
  run_id: string | null;
  level: EventLevel;
  type: EventType;
  message: string;
  payload: Record<string, unknown>;
}

export interface ApprovalOption {
  value: string; // "approve" | "reject" | custom
  label: string;
  description?: string;
}

export interface Approval {
  id: string;
  task_id: string | null;
  run_id: string | null;
  kind: ApprovalKind;
  title: string;
  context: string; // background for the human
  recommendation: string;
  options: ApprovalOption[];
  payload: Record<string, unknown>; // the exact action (tool name + input), editable
  risk: Risk;
  status: ApprovalStatus;
  decision: string | null; // chosen option value
  decision_note: string | null;
  edited_payload: Record<string, unknown> | null;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string | null;
  channel_refs: Record<string, string>; // channel -> external message id
  created_at: string;
  updated_at: string;
}

export interface Artifact {
  id: string;
  task_id: string;
  run_id: string | null;
  type: ArtifactType;
  title: string;
  path: string | null;
  url: string | null;
  content: string | null;
  mime: string | null;
  size: number | null;
  created_at: string;
}

export interface Notification {
  id: string;
  channel: string;
  target: string | null;
  approval_id: string | null;
  task_id: string | null;
  title: string;
  body: string;
  status: "sent" | "failed" | "skipped";
  external_ref: string | null;
  error: string | null;
  sent_at: string;
}

export interface Memory {
  id: string;
  kind: MemoryKind;
  content: string;
  source: string; // where it was learned (task id, signal id, "user")
  confidence: number;
  valid_from: string;
  valid_to: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface SensorCursor {
  sensor: string;
  key: string;
  value: string;
  updated_at: string;
}

export interface Schedule {
  name: string;
  cron: string;
  job: string;
  enabled: 0 | 1;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  next_run_at: string | null;
}

export interface BudgetDay {
  day: string; // YYYY-MM-DD
  cost_usd: number;
  runs: number;
}

// ── Agent I/O contracts ─────────────────────────────────────────────

/** Structured output every execution agent must end with. */
export interface AgentOutput {
  summary: string;
  status: "done" | "partial" | "blocked" | "needs_human";
  artifacts: Array<{
    type: ArtifactType;
    title: string;
    path?: string;
    url?: string;
    content?: string;
  }>;
  verification: { passed: boolean; details: string };
  follow_ups: string[];
  needs_human?: { question: string; options?: string[] } | null;
  learned?: string[]; // facts about the user/projects worth remembering
}

/** Classifier output for one inbox item. */
export interface TriageResult {
  signal_ids: string[];
  kind: InboxKind;
  title: string;
  summary: string;
  category: Category;
  priority: Priority;
  level: Level;
  level_reason: string;
  confidence: number;
  suggested_action: string;
  tags: string[];
  dismiss?: boolean; // noise
  learned?: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────

export type NewSignal = Pick<Signal, "source" | "external_id" | "kind" | "title" | "body"> &
  Partial<Pick<Signal, "url" | "actor" | "occurred_at" | "metadata">>;

export type NewTask = Partial<Omit<Task, "id" | "created_at" | "updated_at">> & Pick<Task, "title">;

export type NewApproval = Pick<Approval, "kind" | "title"> &
  Partial<
    Pick<
      Approval,
      | "task_id"
      | "run_id"
      | "context"
      | "recommendation"
      | "options"
      | "payload"
      | "risk"
      | "expires_at"
    >
  >;

export type NewEvent = Pick<Event, "type" | "message"> &
  Partial<Pick<Event, "task_id" | "run_id" | "level" | "payload">>;

export type NewArtifact = Pick<Artifact, "task_id" | "type" | "title"> &
  Partial<Pick<Artifact, "run_id" | "path" | "url" | "content" | "mime" | "size">>;

export type NewMemory = Pick<Memory, "kind" | "content" | "source"> &
  Partial<Pick<Memory, "confidence" | "tags" | "valid_from" | "valid_to">>;

export const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function isLevel(n: unknown): n is Level {
  return typeof n === "number" && (LEVELS as readonly number[]).includes(n);
}
