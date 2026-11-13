/**
 * AppContext: the dependency bundle every module receives. The engine builds it
 * (engine/app.ts); the HTTP server, CLI and jobs consume it. Services are
 * optional so modules can be tested in isolation.
 */
import type { Config } from "../config/schema.js";
import type { LoadedConfig } from "../config/load.js";
import type { LlmProvider } from "../brain/llm.js";
import type { ApprovalService, InboundHandler, NotifyMessage } from "../hitl/types.js";
import type { Budget } from "./budget.js";
import type { Bus } from "./events.js";
import type { Logger } from "./logger.js";
import type { Policy } from "./policy.js";
import type { Repo } from "./repo.js";
import type { InboxItem, Signal, Task } from "./types.js";

export interface PatrolReport {
  startedAt: string;
  finishedAt: string;
  sensors: Array<{ name: string; ok: boolean; newSignals: number; changedSignals: number; error?: string; summary?: string; durationMs: number }>;
  totalNew: number;
  totalChanged: number;
}

export interface TriageReport {
  signalsTriaged: number;
  inboxCreated: number;
  tasksCreated: number;
  dismissed: number;
  costUsd: number;
  errors: string[];
}

export interface ExecutorStatus {
  running: Array<{ task_id: string; run_id: string; started_at: string | null; title: string }>;
  concurrency: number;
  paused: boolean;
  pauseReason?: string;
}

export interface NotifierLike {
  notify(msg: NotifyMessage): Promise<void>;
  start?(handler: InboundHandler): Promise<void>;
  stop?(): Promise<void>;
}

export interface AppServices {
  llm?: LlmProvider;
  approvals?: ApprovalService;
  notifier?: NotifierLike;
  executor?: {
    wake(reason: string): void;
    retryTask(taskId: string): Promise<Task>;
    cancelTask(taskId: string, reason?: string): Promise<Task>;
    runTaskNow(taskId: string): Promise<Task>;
    pause(reason?: string): void;
    resume(): void;
    status(): ExecutorStatus;
  };
  patrol?: { runOnce(sensorNames?: string[]): Promise<PatrolReport> };
  triage?: { runOnce(): Promise<TriageReport> };
  planner?: { planTask(taskId: string): Promise<Task> };
  inbox?: {
    promote(inboxItemId: string, overrides?: Partial<Task>): Task;
    dismiss(inboxItemId: string, reason?: string): InboxItem;
    snooze(inboxItemId: string, untilIso: string): InboxItem;
    done(inboxItemId: string): InboxItem;
  };
  capture?: (text: string, by: string, opts?: { title?: string; url?: string }) => Promise<Signal>;
  digest?: { build(): Promise<string>; send(): Promise<void> };
  contextRefresh?: { runOnce(): Promise<{ memoriesAdded: number }> };
}

export interface AppContext {
  config: Config;
  loaded: LoadedConfig;
  repo: Repo;
  bus: Bus;
  policy: Policy;
  logger: Logger;
  budget: Budget;
  services: AppServices;
  /** Absolute data dir. */
  dataDir: string;
  startedAt: string;
  shutdown(): Promise<void>;
}
