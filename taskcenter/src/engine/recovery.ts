/**
 * Startup recovery: runs left queued/running by a previous process are marked
 * interrupted and their tasks go back to ready (attempts unchanged) unless the
 * attempt budget is spent. Overdue approvals expire and stale locks are removed.
 */
import { join } from "node:path";
import type { AppContext } from "../core/app.js";
import { transitionRun, transitionTask } from "../core/state.js";
import { cleanStaleLock } from "./lock.js";
import { errMsg } from "./util.js";

export interface RecoveryReport {
  interruptedRuns: number;
  tasksReset: number;
  tasksFailed: number;
  approvalsExpired: number;
  staleLockRemoved: boolean;
}

export function runRecovery(ctx: AppContext, opts: { expireApprovals?: (now?: Date) => unknown[] } = {}): RecoveryReport {
  const { repo, bus, config } = ctx;
  const logger = ctx.logger.child("recovery");
  const report: RecoveryReport = { interruptedRuns: 0, tasksReset: 0, tasksFailed: 0, approvalsExpired: 0, staleLockRemoved: false };

  repo.transaction(() => {
    for (const run of repo.runs.active()) {
      transitionRun(repo, bus, run.id, "interrupted", { error: run.error ?? "interrupted by restart" }, true);
      bus.record({ type: "system", level: "warn", task_id: run.task_id, run_id: run.id, message: "run interrupted by daemon restart", payload: { previous_status: run.status, session_id: run.session_id } });
      report.interruptedRuns++;
    }
    // Tasks stuck in running (with or without an active run)
    for (const task of repo.tasks.list({ status: "running", limit: 1000 })) {
      const max = task.max_attempts > 0 ? task.max_attempts : config.executor.max_attempts;
      if (task.attempts >= max) {
        transitionTask(repo, bus, task.id, "failed", { reason: "interrupted and attempt budget exhausted", patch: { last_error: task.last_error ?? "interrupted by restart" } });
        report.tasksFailed++;
      } else {
        transitionTask(repo, bus, task.id, "ready", { reason: "recovered after restart" });
        report.tasksReset++;
      }
    }
    // Tasks that were planning when the process died
    for (const task of repo.tasks.list({ status: "planning", limit: 1000 })) {
      transitionTask(repo, bus, task.id, "todo", { reason: "recovered after restart (re-plan)" });
      report.tasksReset++;
    }
  });

  try {
    const expired = opts.expireApprovals ? opts.expireApprovals() : repo.approvals.expireDue();
    report.approvalsExpired = expired.length;
  } catch (e) {
    logger.warn(`expiring approvals failed: ${errMsg(e)}`);
  }

  report.staleLockRemoved = cleanStaleLock(join(ctx.dataDir, "taskcenter.lock"));
  if (report.interruptedRuns || report.tasksReset || report.tasksFailed || report.approvalsExpired) {
    logger.info(`recovery: ${report.interruptedRuns} runs interrupted, ${report.tasksReset} tasks reset, ${report.tasksFailed} failed, ${report.approvalsExpired} approvals expired`);
  }
  return report;
}
