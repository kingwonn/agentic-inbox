import { afterEach, describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "../src/engine/daemon.js";
import { LockHeldError, acquireLock, readLock } from "../src/engine/lock.js";
import { runRecovery } from "../src/engine/recovery.js";
import { runFollowUps } from "../src/engine/scheduler.js";
import { runMaintenance } from "../src/engine/maintenance.js";
import { isoPlus } from "../src/core/time.js";
import { makeCtx, type TestCtx } from "./engine-helpers.js";

describe("engine/recovery + daemon", () => {
  let t: TestCtx;
  afterEach(async () => t?.cleanup());

  it("marks active runs interrupted and resets their tasks (failed when attempts are exhausted)", async () => {
    t = await makeCtx();
    const { repo } = t.ctx;
    const a = repo.tasks.create({ title: "A", status: "running", attempts: 0 });
    const ra = repo.runs.create({ task_id: a.id, runner: "dry", model: "m", status: "running", session_id: "sess-a" });
    const b = repo.tasks.create({ title: "B", status: "running", attempts: 3, max_attempts: 3 });
    repo.runs.create({ task_id: b.id, runner: "dry", model: "m", status: "queued" });
    const c = repo.tasks.create({ title: "C", status: "planning" });
    const expired = repo.approvals.create({ kind: "action", title: "old", task_id: a.id, expires_at: isoPlus(-1000) });
    const lockPath = join(t.ctx.dataDir, "taskcenter.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: "x", host: "h" }));
    const r = runRecovery(t.ctx);
    expect(r).toMatchObject({ interruptedRuns: 2, tasksReset: 2, tasksFailed: 1, approvalsExpired: 1, staleLockRemoved: true });
    expect(repo.runs.get(ra.id)?.status).toBe("interrupted");
    expect(repo.tasks.get(a.id)?.status).toBe("ready");
    expect(repo.tasks.get(a.id)?.attempts).toBe(0);
    expect(repo.tasks.get(b.id)?.status).toBe("failed");
    expect(repo.tasks.get(c.id)?.status).toBe("todo");
    expect(repo.approvals.get(expired.id)?.status).toBe("expired");
    expect(existsSync(lockPath)).toBe(false);
    expect(repo.runs.active().length).toBe(0);
  });

  it("lock file: held by a live pid, stale otherwise", async () => {
    t = await makeCtx();
    const path = join(t.ctx.dataDir, "taskcenter.lock");
    const l = acquireLock(path);
    expect(readLock(path)?.alive).toBe(true);
    expect(() => acquireLock(path)).not.toThrow(); // same pid re-acquires
    writeFileSync(path, JSON.stringify({ pid: 1, startedAt: "x", host: "h" }));
    expect(() => acquireLock(path)).toThrow(LockHeldError);
    writeFileSync(path, JSON.stringify({ pid: 999999, startedAt: "x", host: "h" }));
    const l2 = acquireLock(path);
    expect(readLock(path)?.pid).toBe(process.pid);
    l2.release();
    l.release();
    expect(existsSync(path)).toBe(false);
  });

  it("follow-ups: due follow-ups → ready, snoozed → new, expired approvals block waiting tasks", async () => {
    t = await makeCtx();
    const { repo } = t.ctx;
    const w = repo.tasks.create({ title: "wait", status: "waiting_human", follow_up_at: isoPlus(-1000) });
    const item = repo.inbox.create({ kind: "info", title: "z", summary: "", category: "other", priority: "P3", level: 1, level_proposed: 1, level_reason: "", confidence: 0.5, suggested_action: "", source_signal_ids: [], tags: [], status: "snoozed", snoozed_until: isoPlus(-1000) });
    const parked = repo.tasks.create({ title: "parked", status: "waiting_human" });
    repo.approvals.create({ kind: "action", title: "stale", task_id: parked.id, expires_at: isoPlus(-1000) });
    const r = runFollowUps(t.ctx, { executor: t.wired.executor, expireApprovals: (now) => t.wired.approvals.expireDue!(now) as never });
    expect(r).toMatchObject({ followUps: 1, unsnoozed: 1, expired: 1, blocked: 1 });
    expect(repo.tasks.get(w.id)?.status).toBe("ready");
    expect(repo.inbox.get(item.id)?.status).toBe("new");
    expect(repo.tasks.get(parked.id)?.status).toBe("blocked");
  });

  it("maintenance prunes old events (keeping audit types) and finished workspaces", async () => {
    t = await makeCtx();
    const { repo } = t.ctx;
    const old = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
    repo.db.run("INSERT INTO events (id, ts, level, type, message, payload) VALUES ('e1', ?, 'info', 'tool_call', 'x', '{}')", old);
    repo.db.run("INSERT INTO events (id, ts, level, type, message, payload) VALUES ('e2', ?, 'info', 'status_change', 'x', '{}')", old);
    repo.db.run("INSERT INTO events (id, ts, level, type, message, payload) VALUES ('e3', ?, 'info', 'tool_call', 'x', '{}')", new Date().toISOString());
    const ws = join(t.ctx.loaded.resolve(t.ctx.config.executor.workspace_root), "tsk_old");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(ws, { recursive: true });
    const task = repo.tasks.create({ title: "old", status: "done", workspace: ws, finished_at: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString() });
    const r = await runMaintenance(t.ctx, { vacuum: false });
    expect(r.eventsPruned).toBe(1);
    expect(r.workspacesPruned).toBe(1);
    expect(existsSync(ws)).toBe(false);
    expect(repo.tasks.get(task.id)?.workspace).toBeNull();
    expect(repo.events.list({ limit: 100 }).some((e) => e.id === "e2")).toBe(true);
  });

  it("startDaemon runs recovery, starts loops and stops cleanly", async () => {
    t = await makeCtx();
    const { repo } = t.ctx;
    const task = repo.tasks.create({ title: "run me", level: 1, status: "ready" });
    const h = await startDaemon(t.ctx, { serve: false, handleSignals: false, initialPatrolDelayMs: 0 });
    expect(h.url).toBeNull();
    expect(readLock(join(t.ctx.dataDir, "taskcenter.lock"))?.pid).toBe(process.pid);
    await t.wired.executor.drain();
    await new Promise((r) => setTimeout(r, 50));
    expect(repo.tasks.get(task.id)?.status).toBe("done");
    expect(repo.schedules.all().every((s) => s.next_run_at)).toBe(true);
    await h.stop();
    expect(existsSync(join(t.ctx.dataDir, "taskcenter.lock"))).toBe(false);
  });
});
