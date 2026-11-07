/**
 * Engine-internal dependency contracts.
 *
 * Every engine module depends only on these structural types (plus src/core and the
 * interface files src/{sensors,runners,brain,hitl}/types.ts). The concrete
 * implementations from the brain/runners/hitl/sensors modules are bound in exactly
 * one place: engine/wiring.ts. Tests supply stubs.
 */
import type { Config } from "../config/schema.js";
import type { LlmProvider } from "../brain/llm.js";
import type { Bus } from "../core/events.js";
import type { Logger } from "../core/logger.js";
import type { Policy } from "../core/policy.js";
import type { Repo } from "../core/repo.js";
import type { AgentOutput, Category, Level, Priority, Run, Signal, Task, TaskPlan, TriageResult } from "../core/types.js";
import type { ApprovalService } from "../hitl/types.js";
import type { Runner, ToolGate } from "../runners/types.js";
import type { Sensor, SensorContext } from "../sensors/types.js";
import type { NotifierLike } from "../core/app.js";

/** Mirrors sensors/registry.ts SensorEntry (structurally identical). */
export interface SensorEntry {
  sensor: Sensor;
  config: Record<string, unknown>;
  enabled: boolean;
}

/** Mirrors brain/context.ts ContextSnapshot (structurally identical). */
export interface ContextSnapshotLike {
  profile: Record<string, unknown>;
  profileText: string;
  memoriesText: string;
  text: string;
  locale: string;
}

export type LoadContextFn = () => ContextSnapshotLike;

/** Mirrors brain/classifier.ts triageSignals. */
export type TriageFn = (
  signals: Signal[],
  deps: { llm: LlmProvider; policy: Policy; config: Config; context: ContextSnapshotLike; logger: Logger; availableCapabilities: string[] },
) => Promise<{ results: TriageResult[]; costUsd: number }>;

/** Mirrors brain/planner.ts PlannedSubtask. */
export interface PlannedSubtaskLike {
  title: string;
  description: string;
  level: Level;
  category: Category;
  priority: Priority;
  depends_on: number[];
  acceptance_criteria: string[];
}

/** Mirrors brain/planner.ts planTask. */
export type PlanFn = (
  task: Task,
  deps: { llm: LlmProvider; policy: Policy; config: Config; context: ContextSnapshotLike; logger: Logger },
) => Promise<{ plan: TaskPlan; subtasks: PlannedSubtaskLike[]; costUsd: number }>;

export interface ResumeInfo {
  approvalId: string;
  decision: string;
  note?: string;
  editedPayload?: Record<string, unknown>;
}

/** Mirrors brain/prompts/execute.ts buildExecutionPrompt. */
export type BuildPromptFn = (
  task: Task,
  context: ContextSnapshotLike,
  opts: { level: Level; workspace: string; locale: string; resume?: ResumeInfo },
) => { prompt: string; systemPromptAppend: string };

export type RecordLearnedFn = (learned: string[], source: string) => number;

/** Mirrors runners/gate.ts createToolGate options (plus optional repo for the fallback gate). */
export interface GateFactoryOpts {
  policy: Policy;
  level: Level;
  task: Task;
  run: Run;
  workspace: string;
  approvals: ApprovalService;
  bus: Bus;
  waitMs: number;
  expiresHours: number;
  signal: AbortSignal;
  logger: Logger;
  repo?: Repo;
}
export type GateFactory = (opts: GateFactoryOpts) => ToolGate;

export interface Workspace {
  path: string;
  kind: "worktree" | "dir";
  cleanup(): Promise<void>;
}
export type PrepareWorkspaceFn = (task: Task) => Promise<Workspace>;

export type SelectRunnerFn = (override?: string | null) => Promise<Runner>;

/** Stored in task.context.pending_resume while a decided approval waits for its resume run. */
export interface PendingResume extends ResumeInfo {
  kind?: string;
  runId?: string | null;
  sessionId?: string | null;
  decidedAt?: string | null;
}

export interface ExecutorDeps {
  selectRunner: SelectRunnerFn;
  gateFactory: GateFactory;
  prepareWorkspace: PrepareWorkspaceFn;
  buildExecutionPrompt: BuildPromptFn;
  loadContext: LoadContextFn;
  outputSchema: Record<string, unknown>;
  parseAgentOutput(x: unknown): AgentOutput | undefined;
  extractAgentOutputFromText?(text: string): AgentOutput | undefined;
  recordLearned: RecordLearnedFn;
  approvals: ApprovalService;
  notifier?: NotifierLike;
  /** Extra MCP servers for the agent (e.g. the in-process taskcenter tools). */
  mcpServers?(args: { task: Task; run: Run; workspace: string }): Record<string, unknown> | undefined;
  /** Loop tick interval (ms); default 30s. */
  tickMs?: number;
  /** Graceful stop grace period (ms); default 30s. */
  graceMs?: number;
}

export interface TriageDeps {
  llm: LlmProvider;
  triageSignals: TriageFn;
  loadContext: LoadContextFn;
  availableCapabilities: string[];
  recordLearned: RecordLearnedFn;
  inbox: InboxService;
}

export interface PlannerDeps {
  llm: LlmProvider;
  planTask: PlanFn;
  loadContext: LoadContextFn;
}

export interface PatrolDeps {
  makeSensorContext?: (entry: SensorEntry) => SensorContext;
  timeoutMs?: number;
  parallelism?: number;
}

export interface InboxService {
  promote(inboxItemId: string, overrides?: Partial<Task>): Task;
  dismiss(inboxItemId: string, reason?: string): import("../core/types.js").InboxItem;
  snooze(inboxItemId: string, untilIso: string): import("../core/types.js").InboxItem;
  done(inboxItemId: string): import("../core/types.js").InboxItem;
  capture(text: string, by: string, opts?: { title?: string; url?: string }): Promise<Signal>;
}

export interface DigestDeps {
  buildDigest(deps: { repo: Repo; config: Config; context: ContextSnapshotLike; llm?: LlmProvider; logger: Logger }): Promise<string>;
  loadContext: LoadContextFn;
  llm?: LlmProvider;
}

export interface ContextRefreshDeps {
  refreshContext(deps: { repo: Repo; config: Config; loaded: import("../config/load.js").LoadedConfig; llm?: LlmProvider; logger: Logger }): Promise<{ memoriesAdded: number }>;
  llm?: LlmProvider;
}
