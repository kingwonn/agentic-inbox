import type { Bus } from "./events.js";
import type { Repo } from "./repo.js";
import { nowIso } from "./time.js";
import type { ApprovalStatus, RunStatus, Task, TaskStatus } from "./types.js";

export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ["planning", "ready", "blocked", "cancelled", "done"],
  planning: ["ready", "todo", "blocked", "failed", "cancelled"],
  ready: ["running", "blocked", "todo", "cancelled", "waiting_human"],
  running: ["waiting_human", "review", "done", "failed", "ready", "blocked", "cancelled"],
  waiting_human: ["ready", "running", "review", "done", "failed", "cancelled", "todo"],
  review: ["done", "ready", "todo", "failed", "cancelled"],
  blocked: ["ready", "todo", "cancelled", "failed"],
  done: ["todo", "ready"],
  failed: ["ready", "todo", "cancelled"],
  cancelled: ["todo"],
};

export const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "cancelled", "failed", "interrupted"],
  running: ["waiting_human", "succeeded", "failed", "interrupted", "cancelled"],
  waiting_human: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  interrupted: [],
  cancelled: [],
};

export const APPROVAL_TRANSITIONS: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  pending: ["approved", "rejected", "edited", "expired", "cancelled"],
  approved: [],
  rejected: [],
  edited: [],
  expired: ["pending"],
  cancelled: [],
};

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["done", "failed", "cancelled"];
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "interrupted", "cancelled"];

export class InvalidTransition extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`Invalid ${entity} transition ${from} -> ${to}`);
    this.name = "InvalidTransition";
  }
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TASK_TRANSITIONS[from].includes(to);
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return from === to || RUN_TRANSITIONS[from].includes(to);
}

export interface TransitionOpts {
  reason?: string;
  run_id?: string;
  patch?: Partial<Task>;
  force?: boolean;
}

/**
 * Transition a task, persist, log a status_change event, and notify the bus.
 * Throws InvalidTransition unless `force` is set.
 */
export function transitionTask(repo: Repo, bus: Bus, taskId: string, to: TaskStatus, opts: TransitionOpts = {}): Task {
  const task = repo.tasks.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const from = task.status;
  if (!opts.force && !canTransitionTask(from, to)) throw new InvalidTransition("task", from, to);
  const patch: Partial<Task> = { ...opts.patch, status: to };
  if (to === "running" && !task.started_at) patch.started_at = nowIso();
  if (TERMINAL_TASK_STATUSES.includes(to)) patch.finished_at = nowIso();
  if (from !== to && (to === "todo" || to === "ready") && TERMINAL_TASK_STATUSES.includes(from)) patch.finished_at = null;
  const updated = repo.tasks.update(taskId, patch)!;
  if (from !== to) {
    bus.record({
      type: "status_change",
      task_id: taskId,
      run_id: opts.run_id ?? null,
      message: `${from} -> ${to}${opts.reason ? `: ${opts.reason}` : ""}`,
      payload: { entity: "task", from, to, reason: opts.reason ?? null },
    });
    bus.emit("task.changed", { task_id: taskId, status: to, previous: from });
    // Unblock children/dependents when a task completes
    if (to === "done") unblockDependents(repo, bus, taskId);
  }
  return updated;
}

/** Tasks that were blocked on `taskId` and now have all dependencies satisfied move to ready. */
export function unblockDependents(repo: Repo, bus: Bus, taskId: string): string[] {
  const unblocked: string[] = [];
  const candidates = repo.tasks.list({ status: ["blocked"], limit: 1000 });
  for (const t of candidates) {
    if (!t.depends_on.includes(taskId)) continue;
    if (repo.tasks.dependenciesSatisfied(t)) {
      transitionTask(repo, bus, t.id, "ready", { reason: `dependency ${taskId} done` });
      unblocked.push(t.id);
    }
  }
  if (unblocked.length) bus.wake("dependency_unblocked");
  return unblocked;
}

export function transitionRun(repo: Repo, bus: Bus, runId: string, to: RunStatus, patch: Record<string, unknown> = {}, force = false) {
  const run = repo.runs.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const from = run.status;
  if (!force && !canTransitionRun(from, to)) throw new InvalidTransition("run", from, to);
  const p: Record<string, unknown> = { ...patch, status: to };
  if (to === "running" && !run.started_at) p.started_at = nowIso();
  if (TERMINAL_RUN_STATUSES.includes(to) || to === "waiting_human") p.ended_at = p.ended_at ?? nowIso();
  const updated = repo.runs.update(runId, p as never)!;
  if (from !== to) {
    bus.record({
      type: "status_change",
      task_id: run.task_id,
      run_id: runId,
      message: `run ${from} -> ${to}`,
      payload: { entity: "run", from, to },
    });
    bus.emit("run.changed", { run_id: runId, task_id: run.task_id, status: to });
  }
  return updated;
}
