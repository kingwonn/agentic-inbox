/**
 * Maintenance job: WAL checkpoint + VACUUM, prune old events (keeping the audit
 * types), and remove workspaces of finished tasks older than N days.
 */
import { execFile } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { AppContext } from "../core/app.js";
import { DAY } from "../core/time.js";
import { errMsg } from "./util.js";

const execFileP = promisify(execFile);

export const KEEP_EVENT_TYPES = ["status_change", "approval_requested", "approval_decided"] as const;

export interface MaintenanceReport {
  eventsPruned: number;
  workspacesPruned: number;
  vacuumed: boolean;
  errors: string[];
}

export async function runMaintenance(
  ctx: AppContext,
  opts: { eventRetentionDays?: number; workspaceRetentionDays?: number; now?: Date; vacuum?: boolean } = {},
): Promise<MaintenanceReport> {
  const { repo, config } = ctx;
  const logger = ctx.logger.child("maintenance");
  const now = opts.now ?? new Date();
  const report: MaintenanceReport = { eventsPruned: 0, workspacesPruned: 0, vacuumed: false, errors: [] };

  // 1. prune events
  try {
    const cutoff = new Date(now.getTime() - (opts.eventRetentionDays ?? 90) * DAY).toISOString();
    const r = repo.db.run(`DELETE FROM events WHERE ts < ? AND type NOT IN (${KEEP_EVENT_TYPES.map(() => "?").join(",")})`, cutoff, ...KEEP_EVENT_TYPES);
    report.eventsPruned = r.changes;
  } catch (e) {
    report.errors.push(`events: ${errMsg(e)}`);
  }

  // 2. prune workspaces of finished tasks
  const wsRoot = resolve(ctx.loaded.rootDir, config.executor.workspace_root);
  const repoRoot = resolve(ctx.loaded.rootDir, config.executor.repo_root);
  const cutoffMs = now.getTime() - (opts.workspaceRetentionDays ?? 7) * DAY;
  const finished = repo.tasks.list({ status: ["done", "cancelled", "failed"], limit: 5000 }).filter((t) => t.workspace && t.finished_at && new Date(t.finished_at).getTime() < cutoffMs);
  for (const t of finished) {
    const ws = t.workspace!;
    const inside = ws.startsWith(wsRoot + sep);
    if (!inside) continue; // never delete anything outside the workspace root
    try {
      if (existsSync(ws)) {
        let removed = false;
        if (existsSync(resolve(ws, ".git")) && statSync(resolve(ws, ".git")).isFile()) {
          try {
            await execFileP("git", ["worktree", "remove", "--force", ws], { cwd: repoRoot });
            removed = true;
          } catch {
            /* fall through to rm */
          }
        }
        if (!removed) rmSync(ws, { recursive: true, force: true });
      }
      repo.tasks.update(t.id, { workspace: null });
      report.workspacesPruned++;
    } catch (e) {
      report.errors.push(`workspace ${t.id}: ${errMsg(e)}`);
    }
  }
  if (report.workspacesPruned) {
    try {
      await execFileP("git", ["worktree", "prune"], { cwd: repoRoot });
    } catch {
      /* not a git repo */
    }
  }

  // 3. checkpoint + vacuum
  try {
    repo.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    if (opts.vacuum ?? true) repo.db.exec("VACUUM;");
    report.vacuumed = true;
  } catch (e) {
    report.errors.push(`vacuum: ${errMsg(e)}`);
  }

  ctx.bus.record({ type: "system", message: `maintenance: ${report.eventsPruned} events pruned, ${report.workspacesPruned} workspaces removed`, payload: { ...report } });
  if (report.errors.length) logger.warn(`maintenance finished with errors`, report.errors);
  return report;
}
