import { afterEach, describe, expect, it } from "vitest";
import { makeCtx, waitFor, type TestCtx } from "./engine-helpers.js";

describe("engine/executor", () => {
  let t: TestCtx;
  afterEach(async () => t?.cleanup());

  async function runAll() {
    await t.wired.executor.tick();
    await t.wired.executor.drain();
  }

  it("runs an L5 task to done: events persisted, cost recorded, artifacts + memories stored", async () => {
    t = await makeCtx();
    const { repo } = t.ctx;
    const task = repo.tasks.create({ title: "Ship it", level: 5, status: "ready", category: "code", context: { dry: { cost: 0.25, learned: ["likes tests"], artifacts: [{ type: "text", title: "notes", content: "hello" }] } } });
    await runAll();
    const done = repo.tasks.get(task.id)!;
    expect(done.status).toBe("done");
    expect(done.result_summary).toContain("Dry run completed");
    expect(done.cost_usd).toBeCloseTo(0.25);
    expect(done.workspace).toContain(task.id);
    const run = repo.runs.latestForTask(task.id)!;
    expect(run.status).toBe("succeeded");
    expect(run.reason).toBe("scheduled");
    expect(run.attempt).toBe(1);
    expect(run.cost_usd).toBeCloseTo(0.25);
    expect(run.session_id).toBe(`dry-${run.id}`);
    expect(run.result?.status).toBe("done");
    const types = repo.events.list({ run_id: run.id, limit: 100 }).map((e) => e.type);
    for (const ty of ["run_started", "assistant_message", "tool_call", "tool_result", "cost", "run_finished", "artifact"]) expect(types).toContain(ty);
    expect(types.filter((x) => x === "status_change").length).toBeGreaterThanOrEqual(3);
    expect(repo.artifacts.listByTask(task.id).map((a) => a.title)).toEqual(["notes"]);
    expect(repo.memories.active().map((m) => m.content)).toContain("likes tests");
    expect(t.ctx.budget.status().spentUsd).toBeCloseTo(0.25);
    expect(t.ctx.budget.status().runs).toBe(1);
    expect(repo.approvals.pending().length).toBe(0);
  });

  it("sends L3 deliverables to review with a review approval; accepting it completes the task", async () => {
    t = await makeCtx();
    const { repo } = t.ctx;
    const task = repo.tasks.create({ title: "Draft doc", level: 3, status: "ready", category: "writing" });
    await runAll();
    expect(repo.tasks.get(task.id)?.status).toBe("review");
    const approvals = repo.approvals.list({ task_id: task.id });
    expect(approvals.length).toBe(1);
    expect(approvals[0].kind).toBe("review");
    expect(approvals[0].status).toBe("pending");
    expect(approvals[0].options.map((o) => o.value)).toEqual(["accept", "request_changes", "reject"]);
    expect((approvals[0].payload.artifacts as string[]).length).toBe(1);
    await t.wired.approvals.decide({ approvalId: approvals[0].id, decision: "approve", decidedBy: "test" });
    expect(repo.tasks.get(task.id)?.status).toBe("done");
  });

  it("L2 completes directly; L5 with failed verification goes to review", async () => {
    t = await makeCtx();
    const { repo } = t.ctx;
    const l2 = repo.tasks.create({ title: "Analyse", level: 2, status: "ready" });
    const l5 = repo.tasks.create({ title: "Unverified", level: 5, status: "ready", context: { dry: { verified: false } } });
    await runAll();
    expect(repo.tasks.get(l2.id)?.status).toBe("done");
    expect(repo.tasks.get(l5.id)?.status).toBe("review");
  });

  it("retries failures with backoff and fails after max_attempts (notification sent)", async () => {
    t = await makeCtx({ executor: { max_attempts: 2, backoff_seconds: [1] } });
    const { repo } = t.ctx;
    const task = repo.tasks.create({ title: "Flaky", level: 5, status: "ready", max_attempts: 2, context: { dry: { fail: true, error: "kaboom" } } });
    await runAll();
    let cur = repo.tasks.get(task.id)!;
    expect(cur.status).toBe("blocked");
    expect(cur.attempts).toBe(1);
    expect(cur.last_error).toBe("kaboom");
    expect(cur.follow_up_at).toBeTruthy();
    expect(repo.runs.latestForTask(task.id)?.status).toBe("failed");
    // not due yet
    expect(t.wired.executor.retryDue()).toBe(0);
    await new Promise((r) => setTimeout(r, 1100));
    expect(t.wired.executor.retryDue()).toBe(1);
    cur = repo.tasks.get(task.id)!;
    expect(cur.status).toBe("ready");
    expect(cur.follow_up_at).toBeNull();
    await runAll();
    cur = repo.tasks.get(task.id)!;
    expect(cur.status).toBe("failed");
    expect(cur.attempts).toBe(2);
    const runs = repo.runs.listByTask(task.id);
    expect(runs.map((r) => r.reason)).toEqual(["scheduled", "retry"]);
    expect(runs[1].attempt).toBe(2);
    expect(repo.notifications.list().some((n) => n.title.startsWith("Failed:"))).toBe(true);
  });

  it("parks a run on a pending approval, then resumes after the decision with reason resume_after_approval", async () => {
    t = await makeCtx();
    const { repo } = t.ctx;
    const task = repo.tasks.create({ title: "Push it", level: 4, status: "ready", category: "code", context: { dry: { tool: "Bash", toolInput: { command: "git push origin main" } } } });
    await runAll();
    let cur = repo.tasks.get(task.id)!;
    expect(cur.status).toBe("waiting_human");
    const run1 = repo.runs.latestForTask(task.id)!;
    expect(run1.status).toBe("waiting_human");
    const pending = repo.approvals.list({ task_id: task.id, status: "pending" });
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe("action");
    expect(pending[0].payload.tool).toBe("Bash");
    expect(cur.context.waiting_approval_id).toBe(pending[0].id);
    // human approves → service moves task to ready with the resume marker
    await t.wired.approvals.decide({ approvalId: pending[0].id, decision: "approve", decidedBy: "test", note: "go" });
    cur = repo.tasks.get(task.id)!;
    expect(cur.status).toBe("ready");
    expect((cur.context.pending_resume as { resume: { approvalId: string } }).resume.approvalId).toBe(pending[0].id);
    await runAll();
    cur = repo.tasks.get(task.id)!;
    expect(cur.status).toBe("review"); // L4 deliverable
    expect(cur.context.pending_resume).toBeUndefined();
    expect((cur.context.last_resume as { approvalId: string }).approvalId).toBe(pending[0].id);
    const run2 = repo.runs.latestForTask(task.id)!;
    expect(run2.id).not.toBe(run1.id);
    expect(run2.reason).toBe("resume_after_approval");
    expect(run2.resume_of).toBe(run1.id);
    expect(run2.session_id).toBe(run1.session_id);
    expect(run2.status).toBe("succeeded");
    expect(run2.attempt).toBe(1);
  });

  it("asks a question when the agent needs a human, and resumes with the response", async () => {
    t = await makeCtx();
    const { repo } = t.ctx;
    const task = repo.tasks.create({ title: "Ambiguous", level: 5, status: "ready", context: { dry: { agentStatus: "needs_human", question: "Which repo?", options: ["a", "b"] } } });
    await runAll();
    expect(repo.tasks.get(task.id)?.status).toBe("waiting_human");
    const q = repo.approvals.list({ task_id: task.id, status: "pending" })[0];
    expect(q.kind).toBe("question");
    expect(q.title).toBe("Which repo?");
    expect(q.options.map((o) => o.value)).toEqual(["a", "b"]);
    await t.wired.approvals.decide({ approvalId: q.id, decision: "respond", note: "a", decidedBy: "test" });
    expect(repo.tasks.get(task.id)?.status).toBe("ready");
    // the resumed dry run completes normally
    repo.tasks.update(task.id, { context: { ...repo.tasks.get(task.id)!.context, dry: {} } });
    await runAll();
    expect(repo.tasks.get(task.id)?.status).toBe("done");
    expect(repo.runs.latestForTask(task.id)?.reason).toBe("resume_after_approval");
  });

  it("warns once at 80% and pauses at 100% of the daily budget", async () => {
    t = await makeCtx({ brain: { daily_budget_usd: 0.1, budget_usd_per_run: 0.04 } });
    const { repo } = t.ctx;
    for (let i = 0; i < 4; i++) repo.tasks.create({ title: `T${i}`, level: 2, status: "ready", priority: "P2", context: { dry: { cost: 0.045 } } });
    const budgetNotes = () => repo.notifications.list().filter((n) => n.title.toLowerCase().includes("budget"));
    await runAll(); // concurrency 2 → two runs: $0.09 = 90% → warning
    expect(repo.tasks.list({ status: "done" }).length).toBe(2);
    expect(t.ctx.budget.status().warn).toBe(true);
    expect(t.ctx.budget.status().exhausted).toBe(false);
    expect(t.wired.executor.status().paused).toBe(false);
    expect(budgetNotes().length).toBe(1);
    expect(repo.meta.get(`budget_notified:${t.ctx.budget.status().day}`)).toBe("warn");
    await runAll(); // $0.135 → exhausted → pause
    expect(repo.tasks.list({ status: "done" }).length).toBe(3);
    expect(t.ctx.budget.status().exhausted).toBe(true);
    const st = t.wired.executor.status();
    expect(st.paused).toBe(true);
    expect(st.pauseReason).toMatch(/budget/);
    expect(budgetNotes().length).toBe(2);
    expect(repo.meta.get(`budget_notified:${t.ctx.budget.status().day}`)).toBe("exhausted");
    await runAll(); // paused: nothing runs
    expect(repo.tasks.list({ status: "ready" }).length).toBe(1);
    expect(repo.events.list({ type: "system" }).some((e) => e.message.includes("executor paused"))).toBe(true);
  });

  it("respects concurrency and priority order, skips children of cancelled parents, and cancels running tasks", async () => {
    t = await makeCtx({ executor: { concurrency: 1 } });
    const { repo } = t.ctx;
    const low = repo.tasks.create({ title: "low", level: 2, status: "ready", priority: "P3", context: { dry: { delayMs: 150 } } });
    const high = repo.tasks.create({ title: "high", level: 2, status: "ready", priority: "P0", context: { dry: { delayMs: 150 } } });
    const parent = repo.tasks.create({ title: "parent", level: 4, status: "cancelled" });
    const orphan = repo.tasks.create({ title: "child", level: 2, status: "ready", parent_id: parent.id });
    await t.wired.executor.tick();
    expect(t.wired.executor.status().running.map((r) => r.task_id)).toEqual([high.id]);
    await waitFor(() => repo.tasks.get(high.id)?.status === "done");
    await t.wired.executor.tick();
    await waitFor(() => t.wired.executor.status().running.length === 1);
    expect(t.wired.executor.status().running[0].task_id).toBe(low.id);
    const cancelled = await t.wired.executor.cancelTask(low.id, "changed my mind");
    expect(cancelled.status).toBe("cancelled");
    expect(repo.runs.latestForTask(low.id)?.status).toBe("cancelled");
    await runAll();
    expect(repo.tasks.get(orphan.id)?.status).toBe("ready");
  });

  it("runTaskNow executes immediately and retryTask re-queues a failed task", async () => {
    t = await makeCtx();
    const { repo } = t.ctx;
    const task = repo.tasks.create({ title: "Now", level: 1, status: "todo" });
    const done = await t.wired.executor.runTaskNow(task.id);
    expect(done.status).toBe("done");
    expect(repo.runs.latestForTask(task.id)?.reason).toBe("manual");
    repo.tasks.update(task.id, { status: "failed", last_error: "x" });
    const re = await t.wired.executor.retryTask(task.id);
    expect(re.status).toBe("ready");
    expect(re.last_error).toBeNull();
  });

  it("marks the parent ready for integration once all subtasks are done", async () => {
    t = await makeCtx();
    const { repo } = t.ctx;
    const parent = repo.tasks.create({ title: "P", level: 4, status: "blocked", context: { phase: "integrate" } });
    const c1 = repo.tasks.create({ title: "c1", level: 2, status: "ready", parent_id: parent.id });
    const c2 = repo.tasks.create({ title: "c2", level: 2, status: "ready", parent_id: parent.id });
    repo.tasks.update(parent.id, { depends_on: [c1.id, c2.id] });
    await runAll();
    expect(repo.tasks.get(c1.id)?.status).toBe("done");
    expect(repo.tasks.get(c2.id)?.status).toBe("done");
    const p = repo.tasks.get(parent.id)!;
    expect(p.status).toBe("ready");
    expect(p.context.phase).toBe("integrate");
  });

  it("times out a run that exceeds brain.timeout_seconds", async () => {
    t = await makeCtx({ brain: { timeout_seconds: 1 } });
    const { repo } = t.ctx;
    const task = repo.tasks.create({ title: "Slow", level: 5, status: "ready", context: { dry: { delayMs: 5000 } } });
    await runAll();
    const cur = repo.tasks.get(task.id)!;
    expect(cur.status).toBe("blocked");
    expect(cur.attempts).toBe(1);
    expect(repo.runs.latestForTask(task.id)?.error).toMatch(/aborted|timeout/);
  });
});
