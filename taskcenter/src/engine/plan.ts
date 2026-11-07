/**
 * Planner: for todo tasks at L3+ produce a plan and (optionally) subtasks with
 * dependencies. Parents with subtasks wait (blocked) and later run an "integrate" phase.
 */
import type { AppContext } from "../core/app.js";
import { transitionTask } from "../core/state.js";
import { MINUTE, isoPlus, nowIso } from "../core/time.js";
import type { Task, TaskStatus } from "../core/types.js";
import type { PlannerDeps } from "./types.js";
import { clampLevel, errMsg } from "./util.js";

export interface PlannerService {
  planTask(taskId: string): Promise<Task>;
  planPending(): Promise<{ planned: number; errors: string[] }>;
}

const MAX_PLAN_FAILURES = 3;

export function createPlanner(ctx: AppContext, deps: PlannerDeps): PlannerService {
  const { repo, bus, config, policy, budget } = ctx;
  const logger = ctx.logger.child("planner");
  let running = false;

  async function planTask(taskId: string): Promise<Task> {
    const task = repo.tasks.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (!budget.canSpend()) {
      bus.record({ type: "plan", level: "warn", task_id: taskId, message: "planning skipped: daily budget exhausted", payload: { skipped: true } });
      return task;
    }
    if (task.status !== "planning") {
      const allowedFrom: TaskStatus[] = ["todo", "ready", "blocked", "failed"];
      if (!allowedFrom.includes(task.status)) throw new Error(`cannot plan task in status ${task.status}`);
      if (task.status !== "todo") transitionTask(repo, bus, taskId, "todo", { reason: "re-plan" });
      transitionTask(repo, bus, taskId, "planning", { reason: "planner picked up" });
    }
    try {
      const context = deps.loadContext();
      const { plan, subtasks, costUsd } = await deps.planTask(task, { llm: deps.llm, policy, config, context, logger });
      if (costUsd > 0) {
        repo.tasks.addCost(taskId, costUsd);
        budget.addCost(costUsd);
      }
      const result = repo.transaction(() => {
        const created: Task[] = [];
        for (const st of subtasks ?? []) {
          const child = repo.tasks.create({
            parent_id: task.id,
            title: st.title,
            description: st.description ?? "",
            kind: task.kind,
            category: st.category ?? task.category,
            priority: st.priority ?? task.priority,
            level: clampLevel(Math.min(st.level ?? task.level, task.level)),
            status: "ready",
            owner: "ai",
            runner: task.runner,
            model: task.model,
            acceptance_criteria: st.acceptance_criteria ?? [],
            budget_usd: task.budget_usd,
            max_attempts: task.max_attempts,
            inbox_item_id: task.inbox_item_id,
            labels: [...task.labels],
            context: { parent_task_id: task.id, parent_title: task.title, goal: plan.goal, inbox_item_id: task.context?.inbox_item_id ?? null },
          });
          created.push(child);
        }
        created.forEach((child, i) => {
          const depIdx = (subtasks[i].depends_on ?? []).filter((j) => Number.isInteger(j) && j >= 0 && j < created.length && j !== i);
          const depIds = Array.from(new Set(depIdx.map((j) => created[j].id)));
          const status: TaskStatus = depIds.length ? "blocked" : "ready";
          repo.tasks.update(child.id, { depends_on: depIds, status });
          bus.record({ type: "system", task_id: child.id, message: `subtask created (${status}, L${child.level})`, payload: { parent_id: task.id, depends_on: depIds, index: i } });
          bus.emit("task.changed", { task_id: child.id, status });
        });
        const patch: Partial<Task> = {
          plan,
          acceptance_criteria: task.acceptance_criteria.length ? task.acceptance_criteria : (plan.acceptance_criteria ?? []),
        };
        const nextContext = { ...task.context };
        delete nextContext.plan_retry_at;
        delete nextContext.plan_failures;
        if (created.length) {
          transitionTask(repo, bus, task.id, "blocked", {
            reason: `waiting for ${created.length} subtasks`,
            patch: { ...patch, depends_on: created.map((c) => c.id), context: { ...nextContext, phase: "integrate", subtask_ids: created.map((c) => c.id) } },
          });
        } else {
          transitionTask(repo, bus, task.id, "ready", { reason: "planned", patch: { ...patch, context: nextContext } });
        }
        bus.record({
          type: "plan",
          task_id: task.id,
          message: `plan: ${plan.steps?.length ?? 0} steps, ${created.length} subtasks, ${plan.risks?.length ?? 0} risks`,
          payload: {
            goal: plan.goal,
            steps: (plan.steps ?? []).map((s) => s.title),
            subtasks: created.map((c) => ({ id: c.id, title: c.title, level: c.level })),
            risks: plan.risks ?? [],
            required_capabilities: plan.required_capabilities ?? [],
            estimated_cost_usd: plan.estimated_cost_usd ?? null,
            costUsd,
          },
        });
        return repo.tasks.get(task.id)!;
      });
      bus.wake("plan");
      logger.info(`planned ${task.id}: ${result.status}, ${subtasks?.length ?? 0} subtasks`);
      return result;
    } catch (e) {
      const msg = errMsg(e);
      const failures = Number(task.context?.plan_failures ?? 0) + 1;
      bus.record({ type: "error", level: "error", task_id: task.id, message: `planning failed (${failures}/${MAX_PLAN_FAILURES}): ${msg}` });
      logger.error(`planning ${task.id} failed: ${msg}`);
      if (failures >= MAX_PLAN_FAILURES) {
        return transitionTask(repo, bus, task.id, "ready", {
          reason: "planning failed repeatedly; executing without a plan",
          patch: { context: { ...task.context, plan_failures: failures } },
        });
      }
      return transitionTask(repo, bus, task.id, "todo", {
        reason: `planning failed, retry later`,
        patch: { context: { ...task.context, plan_failures: failures, plan_retry_at: isoPlus(5 * MINUTE * failures) } },
      });
    }
  }

  async function planPending(): Promise<{ planned: number; errors: string[] }> {
    if (running) return { planned: 0, errors: ["already running"] };
    running = true;
    const out = { planned: 0, errors: [] as string[] };
    try {
      const now = nowIso();
      const todo = repo.tasks.list({ status: "todo", limit: 100 }).filter((t) => t.owner === "ai");
      for (const t of todo) {
        const retryAt = t.context?.plan_retry_at as string | undefined;
        if (retryAt && retryAt > now) continue;
        try {
          if (t.level <= 2) {
            transitionTask(repo, bus, t.id, "ready", { reason: "L1/L2: analysis mode, no planning" });
            out.planned++;
            continue;
          }
          await planTask(t.id);
          out.planned++;
        } catch (e) {
          out.errors.push(`${t.id}: ${errMsg(e)}`);
        }
      }
      if (out.planned) bus.wake("plan");
      return out;
    } finally {
      running = false;
    }
  }

  return { planTask, planPending };
}
