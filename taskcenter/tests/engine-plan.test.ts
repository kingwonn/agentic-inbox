import { afterEach, describe, expect, it } from "vitest";
import { transitionTask } from "../src/core/state.js";
import { createDryLlm } from "../src/engine/dry.js";
import { fallbackLoadContext } from "../src/engine/fallbacks.js";
import { createPlanner } from "../src/engine/plan.js";
import type { PlanFn } from "../src/engine/types.js";
import { makeCtx, type TestCtx } from "./engine-helpers.js";

describe("engine/plan", () => {
  let t: TestCtx;
  afterEach(async () => t?.cleanup());

  const planWithSubtasks: PlanFn = async (task) => ({
    plan: { goal: `Goal: ${task.title}`, steps: [{ id: "s1", title: "a" }, { id: "s2", title: "b", needs_approval: true }], required_capabilities: ["github_write"], risks: ["push"], acceptance_criteria: ["tests pass"] },
    subtasks: [
      { title: "A", description: "first", level: 5, category: "code", priority: "P1", depends_on: [], acceptance_criteria: [] },
      { title: "B", description: "second", level: 3, category: "code", priority: "P2", depends_on: [0], acceptance_criteria: ["b ok"] },
      { title: "C", description: "third", level: 4, category: "writing", priority: "P2", depends_on: [0, 1], acceptance_criteria: [] },
    ],
    costUsd: 0.01,
  });

  it("stores the plan, creates subtasks with dependencies and blocks the parent until they finish", async () => {
    t = await makeCtx();
    const { repo, bus } = t.ctx;
    const parent = repo.tasks.create({ title: "Big", level: 4, status: "todo", category: "code", priority: "P1" });
    const planner = createPlanner(t.ctx, { llm: createDryLlm(), planTask: planWithSubtasks, loadContext: () => fallbackLoadContext(t.ctx.loaded, repo) });
    const r = await planner.planPending();
    expect(r.planned).toBe(1);
    const p = repo.tasks.get(parent.id)!;
    expect(p.status).toBe("blocked");
    expect(p.plan?.goal).toBe("Goal: Big");
    expect(p.acceptance_criteria).toEqual(["tests pass"]);
    expect(p.context.phase).toBe("integrate");
    expect(p.cost_usd).toBeCloseTo(0.01);
    const kids = repo.tasks.children(parent.id);
    expect(kids.map((k) => k.title)).toEqual(["A", "B", "C"]);
    const [a, b, c] = kids;
    expect(a.status).toBe("ready");
    expect(a.level).toBe(4); // clamped to the parent's level
    expect(b.status).toBe("blocked");
    expect(b.depends_on).toEqual([a.id]);
    expect(c.depends_on).toEqual([a.id, b.id]);
    expect(p.depends_on).toEqual(kids.map((k) => k.id));
    expect(repo.events.list({ task_id: parent.id, type: "plan" }).length).toBe(1);
    // runnable = only A
    expect(repo.tasks.runnable().map((x) => x.id)).toEqual([a.id]);
    // finishing A unblocks B; finishing all unblocks the parent (core unblockDependents)
    transitionTask(repo, bus, a.id, "running");
    transitionTask(repo, bus, a.id, "done");
    expect(repo.tasks.get(b.id)?.status).toBe("ready");
    expect(repo.tasks.get(c.id)?.status).toBe("blocked");
    transitionTask(repo, bus, b.id, "running");
    transitionTask(repo, bus, b.id, "done");
    expect(repo.tasks.get(c.id)?.status).toBe("ready");
    transitionTask(repo, bus, c.id, "running");
    transitionTask(repo, bus, c.id, "done");
    expect(repo.tasks.get(parent.id)?.status).toBe("ready");
  });

  it("plans without subtasks straight to ready, moves L1/L2 todos to ready, and retries a failing planner", async () => {
    t = await makeCtx();
    const { repo } = t.ctx;
    const simple = repo.tasks.create({ title: "Simple", level: 3, status: "todo" });
    const low = repo.tasks.create({ title: "Low", level: 2, status: "todo" });
    const broken = repo.tasks.create({ title: "Broken", level: 3, status: "todo", labels: ["fail"] });
    let calls = 0;
    const planner = createPlanner(t.ctx, {
      llm: createDryLlm(),
      loadContext: () => fallbackLoadContext(t.ctx.loaded, repo),
      planTask: async (task) => {
        calls++;
        if (task.labels.includes("fail")) throw new Error("planner down");
        return { plan: { goal: task.title, steps: [{ id: "1", title: "x" }], required_capabilities: [], risks: [], acceptance_criteria: [] }, subtasks: [], costUsd: 0 };
      },
    });
    const r = await planner.planPending();
    expect(r.planned).toBe(3);
    expect(repo.tasks.get(simple.id)?.status).toBe("ready");
    expect(repo.tasks.get(low.id)?.status).toBe("ready");
    const b = repo.tasks.get(broken.id)!;
    expect(b.status).toBe("todo");
    expect(b.context.plan_failures).toBe(1);
    expect(typeof b.context.plan_retry_at).toBe("string");
    // not retried before plan_retry_at
    await planner.planPending();
    expect(calls).toBe(2);
    expect(repo.events.list({ task_id: broken.id, type: "error" }).length).toBe(1);
  });
});
