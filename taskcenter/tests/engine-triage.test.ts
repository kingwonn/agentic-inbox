import { afterEach, describe, expect, it } from "vitest";
import type { Signal, TriageResult } from "../src/core/types.js";
import { createTriage } from "../src/engine/triage.js";
import { fallbackLoadContext } from "../src/engine/fallbacks.js";
import { createDryLlm } from "../src/engine/dry.js";
import { makeCtx, type TestCtx } from "./engine-helpers.js";

function result(s: Signal, over: Partial<TriageResult> = {}): TriageResult {
  return {
    signal_ids: [s.id],
    kind: "todo",
    title: `Item: ${s.title}`,
    summary: s.body,
    category: "code",
    priority: "P1",
    level: 4,
    level_reason: "test",
    confidence: 0.9,
    suggested_action: "do it",
    tags: ["t"],
    ...over,
  };
}

describe("engine/triage", () => {
  let t: TestCtx;
  afterEach(async () => t?.cleanup());

  function makeTriage(fn: (signals: Signal[]) => TriageResult[], learned: string[] = []) {
    const seen: Signal[][] = [];
    const triage = createTriage(t.ctx, {
      llm: createDryLlm(),
      loadContext: () => fallbackLoadContext(t.ctx.loaded, t.ctx.repo),
      availableCapabilities: ["github_token"],
      recordLearned: (l) => {
        learned.push(...l);
        return l.length;
      },
      inbox: t.wired.inbox,
      triageSignals: async (signals) => {
        seen.push(signals);
        return { results: fn(signals), costUsd: 0.002 };
      },
    });
    return { triage, seen };
  }

  it("creates inbox items, dismisses noise, auto-promotes eligible items and records cost", async () => {
    t = await makeCtx();
    const { repo } = t.ctx;
    const a = repo.signals.upsert({ source: "github", external_id: "a", kind: "pr", title: "PR", body: "review me" }).signal;
    const b = repo.signals.upsert({ source: "imap", external_id: "b", kind: "email", title: "Newsletter", body: "spam" }).signal;
    const c = repo.signals.upsert({ source: "imap", external_id: "c", kind: "email", title: "FYI", body: "info only" }).signal;
    const learned: string[] = [];
    const { triage } = makeTriage(
      () => [result(a, { learned: ["Alice reviews PRs"] }), result(b, { dismiss: true, summary: "newsletter" }), result(c, { kind: "info", level: 1, priority: "P3", category: "communication" })],
      learned,
    );
    const r = await triage.runOnce();
    expect(r.inboxCreated).toBe(2);
    expect(r.dismissed).toBe(1);
    expect(r.tasksCreated).toBe(1);
    expect(r.costUsd).toBeCloseTo(0.002);
    expect(learned).toEqual(["Alice reviews PRs"]);
    expect(repo.signals.listUntriaged().length).toBe(0);
    const items = repo.inbox.list({ limit: 10 });
    const promoted = items.find((i) => i.status === "promoted")!;
    expect(promoted.level).toBe(4);
    const task = repo.tasks.get(promoted.task_id!)!;
    expect(task.status).toBe("todo"); // L4 → planner
    expect(task.inbox_item_id).toBe(promoted.id);
    expect((task.context.signals as unknown[]).length).toBe(1);
    const info = items.find((i) => i.kind === "info")!;
    expect(info.status).toBe("triaged");
    expect(info.task_id).toBeNull();
    expect(repo.signals.get(b.id)?.inbox_item_id).toBeNull();
    expect(repo.budgets.get(t.ctx.budget.status().day).cost_usd).toBeCloseTo(0.002);
    expect(repo.events.list({ type: "triage" }).length).toBe(3);
  });

  it("merges a re-triaged (changed) signal into its existing open item", async () => {
    t = await makeCtx();
    const { repo } = t.ctx;
    const a = repo.signals.upsert({ source: "github", external_id: "a", kind: "issue", title: "Bug", body: "v1" }).signal;
    const { triage } = makeTriage((signals) => signals.map((s) => result(s, { kind: "problem", level: 2, priority: "P2", summary: s.body })));
    await triage.runOnce();
    const first = repo.inbox.list({ limit: 10 })[0];
    expect(first.summary).toBe("v1");
    // signal changes → re-triage
    repo.signals.upsert({ source: "github", external_id: "a", kind: "issue", title: "Bug", body: "v2" });
    expect(repo.signals.listUntriaged().length).toBe(1);
    const r = await triage.runOnce();
    expect(r.inboxCreated).toBe(0);
    expect(repo.inbox.list({ limit: 10 }).length).toBe(1);
    const merged = repo.inbox.get(first.id)!;
    expect(merged.summary).toBe("v2");
    expect(merged.source_signal_ids).toEqual([a.id]);
    expect(merged.status).toBe("triaged");
  });

  it("policy clamps auto-promotion (finance stays in the inbox) and skips when the budget is exhausted", async () => {
    t = await makeCtx({ brain: { daily_budget_usd: 1 } });
    const { repo } = t.ctx;
    const a = repo.signals.upsert({ source: "imap", external_id: "inv", kind: "email", title: "Invoice", body: "pay" }).signal;
    const { triage } = makeTriage(() => [result(a, { category: "finance", level: 2, priority: "P1" })]);
    const r = await triage.runOnce();
    expect(r.inboxCreated).toBe(1);
    expect(r.tasksCreated).toBe(0);
    t.ctx.budget.record(5);
    repo.signals.upsert({ source: "imap", external_id: "inv2", kind: "email", title: "Another", body: "x" });
    const r2 = await triage.runOnce();
    expect(r2.errors).toContain("budget exhausted");
    expect(repo.signals.listUntriaged().length).toBe(1);
  });

  it("parks signals the classifier keeps skipping after two misses", async () => {
    t = await makeCtx();
    const { repo } = t.ctx;
    repo.signals.upsert({ source: "x", external_id: "skip", kind: "k", title: "skipped", body: "" });
    const { triage } = makeTriage(() => []);
    await triage.runOnce();
    expect(repo.signals.listUntriaged().length).toBe(1);
    await triage.runOnce();
    expect(repo.signals.listUntriaged().length).toBe(0);
  });
});
