import { describe, expect, it } from "vitest";
import { createApprovalService, createInboundHandler, ApprovalNotPendingError, resolveDecision, defaultOptions, mergeEditedPayload } from "../src/hitl/approvals.js";
import type { NotifyMessage } from "../src/hitl/types.js";
import { cfg, fakeApproval, mem, tick } from "./hitl-helpers.js";

function setup(over: Record<string, unknown> = {}) {
  const ctx = mem();
  const sent: NotifyMessage[] = [];
  const notifier = { notify: async (m: NotifyMessage) => void sent.push(m) };
  const config = cfg({ approval: { expire_hours: 48, wait_seconds: 600 }, ...over });
  const svc = createApprovalService({ ...ctx, notifier, config, publicUrl: "http://tc.local", pollIntervalMs: 20 });
  return { ...ctx, svc, sent, config };
}

describe("approval service: request", () => {
  it("fills defaults by kind, records event, moves task to waiting_human, notifies", async () => {
    const { repo, svc, sent } = setup();
    const task = repo.tasks.create({ title: "T", status: "running", level: 3 });
    const a = await svc.request({ kind: "action", title: "git push", task_id: task.id, payload: { tool: "Bash", input: { command: "git push origin main" } }, risk: "high" });
    expect(a.options.map((o) => o.value)).toEqual(["approve", "edit", "reject"]);
    expect(a.status).toBe("pending");
    const hours = (new Date(a.expires_at!).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThan(48.1);
    expect(repo.tasks.get(task.id)?.status).toBe("waiting_human");
    expect(repo.events.list({ type: "approval_requested" }).length).toBe(1);
    expect(sent.length).toBe(1);
    expect(sent[0].kind).toBe("approval_requested");
    expect(sent[0].priority).toBe("high");
    expect(sent[0].url).toBe("http://tc.local/#/outbox/" + a.id);
    expect(sent[0].body).toContain("git push origin main");
    expect(svc.pending().map((p) => p.id)).toEqual([a.id]);
  });

  it("default options per kind", () => {
    expect(defaultOptions("decision", [{ value: "a", label: "A" }, { value: "b", label: "B" }]).map((o) => o.value)).toEqual(["a", "b", "reject"]);
    expect(defaultOptions("review").map((o) => o.value)).toEqual(["accept", "request_changes", "reject"]);
    expect(defaultOptions("question").map((o) => o.value)).toEqual(["respond"]);
  });

  it("does not touch tasks that are not running/ready and survives notifier failures", async () => {
    const ctx = mem();
    const notifier = { notify: async () => { throw new Error("channel down"); } };
    const svc = createApprovalService({ ...ctx, notifier, config: cfg() });
    const task = ctx.repo.tasks.create({ title: "T", status: "review" });
    const a = await svc.request({ kind: "review", title: "Review result", task_id: task.id });
    expect(a.status).toBe("pending");
    expect(ctx.repo.tasks.get(task.id)?.status).toBe("review");
  });
});

describe("approval service: decide", () => {
  it("approve resumes a waiting task with pending_resume and wakes the executor", async () => {
    const { repo, bus, svc } = setup();
    const task = repo.tasks.create({ title: "T", status: "running" });
    const a = await svc.request({ kind: "action", title: "x", task_id: task.id, payload: { tool: "Bash", input: { command: "ls" } } });
    let woke = "";
    bus.on("wake", (e) => (woke = e.reason));
    const decided = await svc.decide({ approvalId: a.id, decision: "approve", note: "go", decidedBy: "test" });
    expect(decided.status).toBe("approved");
    expect(decided.decision).toBe("approve");
    expect(decided.decision_note).toBe("go");
    expect(decided.decided_by).toBe("test");
    const t = repo.tasks.get(task.id)!;
    expect(t.status).toBe("ready");
    expect((t.context.pending_resume as any).resume.approvalId).toBe(a.id);
    expect((t.context.pending_resume as any).resume.decision).toBe("approve");
    expect(woke).toBe("approval_decided");
    expect(repo.events.list({ type: "approval_decided" }).length).toBe(1);
  });

  it("stays waiting_human while other approvals are pending", async () => {
    const { repo, svc } = setup();
    const task = repo.tasks.create({ title: "T", status: "running" });
    const a1 = await svc.request({ kind: "action", title: "a1", task_id: task.id });
    const a2 = await svc.request({ kind: "action", title: "a2", task_id: task.id });
    await svc.decide({ approvalId: a1.id, decision: "reject", decidedBy: "t" });
    expect(repo.tasks.get(task.id)?.status).toBe("waiting_human");
    await svc.decide({ approvalId: a2.id, decision: "approve", decidedBy: "t" });
    expect(repo.tasks.get(task.id)?.status).toBe("ready");
  });

  it("edit requires an object payload and merges it", async () => {
    const { svc, repo } = setup();
    const task = repo.tasks.create({ title: "T", status: "running" });
    const a = await svc.request({ kind: "action", title: "x", task_id: task.id, payload: { tool: "Bash", input: { command: "rm -rf build", cwd: "/w" } } });
    await expect(svc.decide({ approvalId: a.id, decision: "edit", decidedBy: "t" })).rejects.toThrow(/editedPayload/);
    await expect(svc.decide({ approvalId: a.id, decision: "edit", editedPayload: "nope" as any, decidedBy: "t" })).rejects.toThrow(/editedPayload/);
    const d = await svc.decide({ approvalId: a.id, decision: "edit", editedPayload: { input: { command: "rm -rf dist" } }, decidedBy: "t" });
    expect(d.status).toBe("edited");
    expect(d.edited_payload).toEqual({ tool: "Bash", input: { command: "rm -rf dist", cwd: "/w" } });
    expect((repo.tasks.get(task.id)!.context.pending_resume as any).resume.editedPayload.input.command).toBe("rm -rf dist");
  });

  it("respond answers a question; decision kind accepts custom options; unknown options rejected", async () => {
    const { svc, repo } = setup();
    const task = repo.tasks.create({ title: "T", status: "running" });
    const q = await svc.request({ kind: "question", title: "Which branch?", task_id: task.id });
    await expect(svc.decide({ approvalId: q.id, decision: "respond", decidedBy: "t" })).rejects.toThrow(/note/);
    const dq = await svc.decide({ approvalId: q.id, decision: "respond", note: "main", decidedBy: "t" });
    expect(dq.status).toBe("approved");
    expect(dq.decision).toBe("respond");
    expect(dq.decision_note).toBe("main");

    const task2 = repo.tasks.create({ title: "T2", status: "ready" });
    const d = await svc.request({ kind: "decision", title: "Pick", task_id: task2.id, options: [{ value: "fast", label: "Fast" }, { value: "cheap", label: "Cheap" }] });
    expect(d.options.map((o) => o.value)).toEqual(["fast", "cheap", "reject"]);
    await expect(svc.decide({ approvalId: d.id, decision: "slow", decidedBy: "t" })).rejects.toThrow(/Unknown option/);
    const dd = await svc.decide({ approvalId: d.id, decision: "cheap", decidedBy: "t" });
    expect(dd.status).toBe("approved");
    expect(dd.decision).toBe("cheap");
    expect(repo.tasks.get(task2.id)?.status).toBe("ready");
  });

  it("review: accept → done, request_changes → ready with notes, reject → cancelled", async () => {
    const { svc, repo } = setup();
    const t1 = repo.tasks.create({ title: "A", status: "review" });
    const r1 = await svc.request({ kind: "review", title: "Review A", task_id: t1.id });
    await svc.decide({ approvalId: r1.id, decision: "accept", decidedBy: "t" });
    expect(repo.tasks.get(t1.id)?.status).toBe("done");

    const t2 = repo.tasks.create({ title: "B", status: "review" });
    const r2 = await svc.request({ kind: "review", title: "Review B", task_id: t2.id });
    await svc.decide({ approvalId: r2.id, decision: "request_changes", note: "add tests", decidedBy: "t" });
    const b = repo.tasks.get(t2.id)!;
    expect(b.status).toBe("ready");
    expect((b.context.review_notes as string[])[0]).toMatch(/add tests$/);
    expect((b.context.pending_resume as any).resume.decision).toBe("request_changes");

    const t3 = repo.tasks.create({ title: "C", status: "review" });
    const r3 = await svc.request({ kind: "review", title: "Review C", task_id: t3.id });
    const d3 = await svc.decide({ approvalId: r3.id, decision: "approve", decidedBy: "t" }); // approve on a review == accept
    expect(d3.decision).toBe("accept");
    const t4 = repo.tasks.create({ title: "D", status: "review" });
    const r4 = await svc.request({ kind: "review", title: "Review D", task_id: t4.id });
    await svc.decide({ approvalId: r4.id, decision: "reject", decidedBy: "t" });
    expect(repo.tasks.get(t4.id)?.status).toBe("cancelled");
  });

  it("is idempotent: second decision throws a friendly error; inbound handler maps it", async () => {
    const { svc, repo } = setup();
    const a = await svc.request({ kind: "action", title: "x" });
    await svc.decide({ approvalId: a.id, decision: "approve", decidedBy: "t" });
    await expect(svc.decide({ approvalId: a.id, decision: "reject", decidedBy: "t" })).rejects.toThrow(ApprovalNotPendingError);
    const handler = createInboundHandler({ approvals: svc, repo });
    const same = await handler.decide({ approvalId: a.id, decision: "approve", decidedBy: "t" });
    expect(same.ok).toBe(true);
    expect(same.message).toMatch(/already approved/);
    const diff = await handler.decide({ approvalId: a.id, decision: "reject", decidedBy: "t" });
    expect(diff.ok).toBe(false);
    const missing = await handler.decide({ approvalId: "apr_nope", decision: "approve", decidedBy: "t" });
    expect(missing.ok).toBe(false);
    expect(missing.message).toMatch(/not found/);
    expect(await handler.status!()).toMatch(/pending approvals/);
  });

  it("expired approvals cannot be decided and expireDue records events", async () => {
    const { svc, repo } = setup();
    const a = await svc.request({ kind: "action", title: "old", expires_at: "2020-01-01T00:00:00.000Z" });
    await expect(svc.decide({ approvalId: a.id, decision: "approve", decidedBy: "t" })).rejects.toThrow(/expired/);
    expect(repo.approvals.get(a.id)?.status).toBe("expired");
    const b = await svc.request({ kind: "action", title: "old2", expires_at: "2020-01-01T00:00:00.000Z" });
    const c = await svc.request({ kind: "action", title: "fresh" });
    const expired = svc.expireDue();
    expect(expired.map((x) => x.id)).toEqual([b.id]);
    expect(repo.approvals.get(c.id)?.status).toBe("pending");
    expect(repo.events.list({ type: "approval_decided" }).filter((e) => e.payload.status === "expired").length).toBe(2);
  });
});

describe("approval service: waitForDecision", () => {
  it("resolves immediately when not pending, on bus event, on poll, on timeout and on abort", async () => {
    const { svc, repo, bus } = setup();
    const a = await svc.request({ kind: "action", title: "x" });
    await svc.decide({ approvalId: a.id, decision: "approve", decidedBy: "t" });
    expect((await svc.waitForDecision(a.id, 1000)).status).toBe("approved");

    // bus event
    const b = await svc.request({ kind: "action", title: "b" });
    const pb = svc.waitForDecision(b.id, 5000);
    await tick(5);
    await svc.decide({ approvalId: b.id, decision: "reject", decidedBy: "t" });
    expect((await pb).status).toBe("rejected");

    // poll (decision written directly to the DB, as another process / CLI would)
    const c = await svc.request({ kind: "action", title: "c" });
    const pc = svc.waitForDecision(c.id, 5000);
    await tick(5);
    repo.approvals.decide(c.id, { status: "approved", decision: "approve" });
    const start = Date.now();
    expect((await pc).status).toBe("approved");
    expect(Date.now() - start).toBeLessThan(2000);

    // timeout
    const d = await svc.request({ kind: "action", title: "d" });
    expect((await svc.waitForDecision(d.id, 30)).status).toBe("pending");

    // abort
    const e = await svc.request({ kind: "action", title: "e" });
    const ac = new AbortController();
    const pe = svc.waitForDecision(e.id, 5000, ac.signal);
    setTimeout(() => ac.abort(), 10);
    expect((await pe).status).toBe("pending");
    expect(bus.listenerCount("approval.decided")).toBe(0);
  });
});

describe("resolveDecision / mergeEditedPayload", () => {
  it("maps decisions", () => {
    const a = fakeApproval();
    expect(resolveDecision(a, { approvalId: a.id, decision: "approve", decidedBy: "x" })).toMatchObject({ status: "approved", decision: "approve" });
    expect(resolveDecision(a, { approvalId: a.id, decision: "reject", note: "no", decidedBy: "x" })).toMatchObject({ status: "rejected", decision: "reject", note: "no" });
    expect(() => resolveDecision(a, { approvalId: a.id, decision: "", decidedBy: "x" })).toThrow();
    expect(mergeEditedPayload({ tool: "A", input: { a: 1, b: 2 } }, { input: { b: 3 } })).toEqual({ tool: "A", input: { a: 1, b: 3 } });
  });
});
