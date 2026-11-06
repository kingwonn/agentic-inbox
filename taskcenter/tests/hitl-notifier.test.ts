import { describe, expect, it } from "vitest";
import { Notifier, createNotifier, parseQuietHours, isQuiet } from "../src/hitl/notifier.js";
import { transitionTask } from "../src/core/state.js";
import { FakeChannel, cfg, fakeApproval, mem, tick } from "./hitl-helpers.js";

function setup(over: { quietHours?: string | null; now?: () => Date; notify_on?: string[]; locale?: string } = {}) {
  const ctx = mem();
  const a = new FakeChannel("a");
  const b = new FakeChannel("b");
  const config = cfg({ locale: over.locale ?? "en", notifications: over.notify_on ? { notify_on: over.notify_on } : {} });
  const n = new Notifier({ ...ctx, config, channels: [a, b], quietHours: over.quietHours ?? null, now: over.now, reviewDelayMs: 5, publicUrl: "http://tc.local" });
  return { ...ctx, n, a, b, config };
}

describe("quiet hours helpers", () => {
  it("parses and evaluates ranges incl. midnight span", () => {
    const q = parseQuietHours("23:00-08:00")!;
    expect(q).toEqual({ start: 1380, end: 480 });
    expect(isQuiet(q, new Date("2026-11-05T23:30:00Z"), "UTC")).toBe(true);
    expect(isQuiet(q, new Date("2026-11-05T03:00:00Z"), "UTC")).toBe(true);
    expect(isQuiet(q, new Date("2026-11-05T12:00:00Z"), "UTC")).toBe(false);
    expect(isQuiet(q, new Date("2026-11-05T12:00:00Z"), "Asia/Shanghai")).toBe(false); // 20:00 local
    expect(isQuiet(q, new Date("2026-11-05T16:00:00Z"), "Asia/Shanghai")).toBe(true); // 00:00 local
    expect(parseQuietHours("")).toBeUndefined();
    expect(parseQuietHours("nonsense")).toBeUndefined();
    expect(parseQuietHours("9-17")).toEqual({ start: 540, end: 1020 });
  });
});

describe("Notifier.notify", () => {
  it("sends to every channel, records rows + event and stores channel refs", async () => {
    const { n, a, b, repo } = setup();
    const ap = repo.approvals.create({ kind: "action", title: "x" });
    await n.notify({ kind: "approval_requested", title: "T", body: "B", approval: ap });
    expect(a.sent.length).toBe(1);
    expect(b.sent.length).toBe(1);
    expect(a.sent[0].priority).toBe("normal");
    const rows = repo.notifications.list();
    expect(rows.map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(repo.approvals.get(ap.id)?.channel_refs).toEqual({ a: "a-1", b: "b-1" });
    const ev = repo.events.list({ type: "notification" });
    expect(ev.length).toBe(1);
    expect((ev[0].payload.channels as any[]).length).toBe(2);
  });

  it("dedupes approvals per channel and isolates channel failures", async () => {
    const { n, a, b, repo } = setup();
    const ap = repo.approvals.create({ kind: "action", title: "x" });
    b.fail = true;
    await n.notify({ kind: "approval_requested", title: "T", body: "B", approval: ap });
    expect(a.sent.length).toBe(1);
    expect(repo.notifications.list().find((r) => r.channel === "b")?.status).toBe("failed");
    b.fail = false;
    await n.notify({ kind: "approval_requested", title: "T", body: "B", approval: ap });
    expect(a.sent.length).toBe(1); // deduped
    expect(b.sent.length).toBe(1); // retried because the earlier attempt failed
    await n.notify({ kind: "info", title: "T", body: "B" });
    expect(a.sent.length).toBe(2); // non-approval messages are never deduped
  });

  it("filters by notify_on (info always allowed)", async () => {
    const { n, a } = setup({ notify_on: ["task_done"] });
    await n.notify({ kind: "digest", title: "D", body: "" });
    await n.notify({ kind: "task_failed", title: "F", body: "" });
    await n.notify({ kind: "task_done", title: "OK", body: "" });
    await n.notify({ kind: "info", title: "I", body: "" });
    expect(a.sent.map((m) => m.kind)).toEqual(["task_done", "info"]);
  });

  it("defers normal messages during quiet hours, passes high priority, flushes afterwards", async () => {
    let clock = new Date("2026-11-05T23:30:00Z");
    const { n, a, repo } = setup({ quietHours: "23:00-08:00", now: () => clock });
    const high = repo.approvals.create({ kind: "action", title: "risky", risk: "high" });
    const low = repo.approvals.create({ kind: "action", title: "meh", risk: "low" });
    await n.notify({ kind: "approval_requested", title: "H", body: "", approval: high });
    await n.notify({ kind: "approval_requested", title: "L", body: "", approval: low });
    await n.notify({ kind: "approval_requested", title: "L", body: "", approval: low }); // duplicate while deferred
    await n.notify({ kind: "task_done", title: "D", body: "" });
    await n.notify({ kind: "budget_warning", title: "B", body: "" }); // high by default
    expect(a.sent.map((m) => m.title)).toEqual(["H", "B"]);
    expect(n.pendingDeferred()).toBe(2);
    expect(await n.flushDeferred()).toBe(0); // still quiet
    repo.approvals.decide(low.id, { status: "approved", decision: "approve" }); // decided meanwhile → dropped
    clock = new Date("2026-11-06T09:00:00Z");
    expect(await n.flushDeferred()).toBe(1);
    expect(a.sent.map((m) => m.title)).toEqual(["H", "B", "D"]);
    expect(n.pendingDeferred()).toBe(0);
    await n.stop();
  });

  it("never throws", async () => {
    const { n, a, b } = setup();
    a.fail = true;
    b.fail = true;
    await expect(n.notify({ kind: "info", title: "x", body: "y" })).resolves.toBeUndefined();
  });
});

describe("Notifier bus integration", () => {
  it("auto-notifies on done/failed for top-level tasks only, and review_ready unless a review approval exists", async () => {
    const { n, a, repo, bus } = setup({ locale: "zh-CN" });
    const parent = repo.tasks.create({ title: "Parent", status: "running" });
    const child = repo.tasks.create({ title: "Child", status: "running", parent_id: parent.id });
    transitionTask(repo, bus, child.id, "done");
    await tick(5);
    expect(a.sent.length).toBe(0);
    transitionTask(repo, bus, parent.id, "failed", { patch: { last_error: "boom" } });
    await tick(5);
    expect(a.sent.length).toBe(1);
    expect(a.sent[0].kind).toBe("task_failed");
    expect(a.sent[0].title).toContain("❌ 任务失败");
    expect(a.sent[0].url).toBe("http://tc.local/#/tasks/" + parent.id);

    const r1 = repo.tasks.create({ title: "R1", status: "running" });
    transitionTask(repo, bus, r1.id, "review");
    await tick(30);
    expect(a.sent.map((m) => m.kind)).toContain("review_ready");

    const r2 = repo.tasks.create({ title: "R2", status: "running" });
    transitionTask(repo, bus, r2.id, "review");
    repo.approvals.create({ kind: "review", title: "Review R2", task_id: r2.id });
    await tick(30);
    expect(a.sent.filter((m) => m.kind === "review_ready").length).toBe(1);
    await n.stop();
  });

  it("calls channel.onDecided when an approval is decided; start/stop propagate", async () => {
    const { n, a, b, repo, bus } = setup();
    const ap = repo.approvals.create({ kind: "action", title: "x" });
    repo.approvals.decide(ap.id, { status: "rejected", decision: "reject" });
    bus.emit("approval.decided", { approval_id: ap.id, task_id: null, decision: "reject" });
    await tick(5);
    expect(a.decided[0]?.status).toBe("rejected");
    const handler = { decide: async () => ({ ok: true, message: "" }) };
    await n.start(handler);
    expect(a.started && b.started).toBe(true);
    await n.stop();
    expect(a.stopped && b.stopped).toBe(true);
    expect(bus.listenerCount("task.changed")).toBe(0);
  });

  it("createNotifier builds the console channel by default", () => {
    const ctx = mem();
    const n = createNotifier({ ...ctx, config: cfg(), channelDeps: { consoleStderr: false } });
    expect(n.channelNames()).toEqual(["console"]);
  });
});
