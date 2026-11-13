/** Mirror of the server's domain types (src/core/types.ts). Keep in sync by hand. */

export type InboxKind = "todo" | "problem" | "opportunity" | "decision" | "info";
export type Priority = "P0" | "P1" | "P2" | "P3";
export type Level = 1 | 2 | 3 | 4 | 5;
export type InboxStatus = "new" | "triaged" | "promoted" | "dismissed" | "snoozed" | "done";
export type TaskStatus = "todo" | "planning" | "ready" | "running" | "waiting_human" | "review" | "blocked" | "done" | "failed" | "cancelled";
export type RunStatus = "queued" | "running" | "waiting_human" | "succeeded" | "failed" | "interrupted" | "cancelled";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "edited" | "expired" | "cancelled";
export type ApprovalKind = "action" | "decision" | "review" | "question";
export type Risk = "low" | "medium" | "high";
export type ArtifactType = "file" | "url" | "text" | "pr" | "email_draft" | "document" | "patch";
export type EventLevel = "debug" | "info" | "warn" | "error";
export type EventType =
  | "tool_call"
  | "tool_result"
  | "assistant_message"
  | "status_change"
  | "approval_requested"
  | "approval_decided"
  | "notification"
  | "error"
  | "cost"
  | "sensor_poll"
  | "triage"
  | "plan"
  | "run_started"
  | "run_finished"
  | "artifact"
  | "memory"
  | "system";
export type MemoryKind = "fact" | "preference" | "project" | "person" | "habit" | "goal";
export type Category =
  | "code"
  | "research"
  | "writing"
  | "communication"
  | "external_communication"
  | "scheduling"
  | "finance"
  | "publishing"
  | "ops"
  | "learning"
  | "personal"
  | "admin"
  | "other";

export interface Signal {
  id: string;
  source: string;
  external_id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  actor: string | null;
  occurred_at: string;
  observed_at: string;
  updated_at: string;
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
  confidence: number;
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
  owner: "ai" | "human";
  runner: string | null;
  model: string | null;
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
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AgentOutput {
  summary: string;
  status: "done" | "partial" | "blocked" | "needs_human";
  artifacts: Array<{ type: ArtifactType; title: string; path?: string; url?: string; content?: string }>;
  verification: { passed: boolean; details: string };
  follow_ups: string[];
  needs_human?: { question: string; options?: string[] } | null;
  learned?: string[];
}

export interface Run {
  id: string;
  task_id: string;
  task_title?: string | null;
  attempt: number;
  runner: string;
  model: string;
  status: RunStatus;
  session_id: string | null;
  resume_of: string | null;
  reason: string;
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
  value: string;
  label: string;
  description?: string;
}

export interface Approval {
  id: string;
  task_id: string | null;
  task_title?: string | null;
  run_id: string | null;
  kind: ApprovalKind;
  title: string;
  context: string;
  recommendation: string;
  options: ApprovalOption[];
  payload: Record<string, unknown>;
  risk: Risk;
  status: ApprovalStatus;
  decision: string | null;
  decision_note: string | null;
  edited_payload: Record<string, unknown> | null;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string | null;
  channel_refs: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface Artifact {
  id: string;
  task_id: string;
  task_title?: string | null;
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

export interface Memory {
  id: string;
  kind: MemoryKind;
  content: string;
  source: string;
  confidence: number;
  valid_from: string;
  valid_to: string | null;
  tags: string[];
  created_at: string;
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

export interface SensorCursor {
  sensor: string;
  key: string;
  value: string;
  updated_at: string;
}

export interface BudgetStatus {
  day: string;
  spentUsd: number;
  limitUsd: number;
  ratio: number;
  warn: boolean;
  exhausted: boolean;
  runs: number;
}

export interface BudgetDay {
  day: string;
  cost_usd: number;
  runs: number;
}

export interface ExecutorStatus {
  running: Array<{ task_id: string; run_id: string; started_at: string | null; title: string }>;
  concurrency: number;
  paused: boolean;
  pauseReason?: string;
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

export interface ConfigSummary {
  provider: string;
  models: { classify: string; plan: string; execute: string; heavy: string };
  effort: string;
  max_turns: number;
  timeout_seconds: number;
  budget_usd_per_run: number;
  daily_budget_usd: number;
  concurrency: number;
  max_attempts: number;
  patrol_interval_minutes: number;
  approval: { wait_seconds: number; expire_hours: number };
  sensors: string[];
  channels: string[];
  digest: { enabled: boolean; cron: string };
  schedules: Record<string, string>;
  timezone: string;
  locale: string;
  server: { host: string; port: number; auth: boolean; public_url: string | null };
}

export interface Status {
  startedAt: string;
  now: string;
  version: string;
  config: ConfigSummary;
  counts: {
    inbox: Record<string, number>;
    tasks: Record<string, number>;
    runs: Record<string, number>;
    approvals: Record<string, number>;
    signals: number;
    untriaged: number;
    failures24h: number;
  };
  budget: BudgetStatus;
  executor: ExecutorStatus | null;
  schedules: Schedule[];
  sensors: Record<string, { cursors: number; updated_at: string | null }>;
  cursors: SensorCursor[];
  dataDir: string;
  services: string[];
}

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  more: boolean;
}

export interface TaskDetail {
  task: Task;
  parent: Task | null;
  children: Task[];
  dependencies: Task[];
  runs: Run[];
  approvals: Approval[];
  artifacts: Artifact[];
  events: Event[];
  inbox_item: InboxItem | null;
}

export interface RunDetail {
  run: Run;
  task: Task | null;
  events: Event[];
  approvals: Approval[];
  artifacts: Artifact[];
}

export interface InboxDetail {
  item: InboxItem;
  signals: Signal[];
  task: Task | null;
}

export interface ContextInfo {
  profilePath: string;
  profileExists: boolean;
  profileText: string;
  profile: Record<string, unknown>;
  memories: Memory[];
  locale: string;
  timezone: string;
}
