import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../core/app.js";
import { transitionTask } from "../../core/state.js";
import { CATEGORIES, INBOX_KINDS, PRIORITIES, TASK_STATUSES, type Task } from "../../core/types.js";
import { LevelSchema, badRequest, intParam, listParam, notFound, oneOf, pageOf, parseBody, strParam, unavailable } from "../util.js";

const CreateBody = z.object({
  title: z.string().min(1).max(500),
  description: z.string().default(""),
  kind: z.enum(INBOX_KINDS).optional(),
  level: LevelSchema.optional(),
  category: z.enum(CATEGORIES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  parent_id: z.string().nullable().optional(),
  depends_on: z.array(z.string()).optional(),
  status: z.enum(["todo", "ready"]).optional(),
  deadline: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  acceptance_criteria: z.array(z.string()).optional(),
  owner: z.enum(["ai", "human"]).optional(),
  budget_usd: z.number().min(0).optional(),
});

const PatchBody = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  level: LevelSchema.optional(),
  priority: z.enum(PRIORITIES).optional(),
  category: z.enum(CATEGORIES).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  follow_up_at: z.string().nullable().optional(),
  deadline: z.string().nullable().optional(),
  owner: z.enum(["ai", "human"]).optional(),
  labels: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

const NoteBody = z.object({ message: z.string().min(1).max(10_000) });
const CancelBody = z.object({ reason: z.string().optional() });

export function tasksRoutes(ctx: AppContext) {
  const app = new Hono();
  const { repo, bus } = ctx;

  const mustGet = (id: string): Task => {
    const t = repo.tasks.get(id);
    if (!t) throw notFound("task not found");
    return t;
  };

  app.get("/tasks", (c) => {
    const status = oneOf(listParam(c, "status"), TASK_STATUSES, "status");
    const limit = intParam(c, "limit", 200, 1000, 1);
    const offset = intParam(c, "offset", 0);
    const parentRaw = c.req.query("parent_id");
    const parent_id = parentRaw === undefined ? undefined : parentRaw === "" || parentRaw === "null" ? null : parentRaw;
    const items = repo.tasks.list({ status, parent_id, limit, offset });
    return c.json(pageOf(items, limit, offset));
  });

  app.post("/tasks", async (c) => {
    const body = await parseBody(c, CreateBody);
    if (body.parent_id && !repo.tasks.get(body.parent_id)) throw badRequest(`parent task not found: ${body.parent_id}`);
    for (const dep of body.depends_on ?? []) if (!repo.tasks.get(dep)) throw badRequest(`dependency not found: ${dep}`);
    const task = repo.tasks.create({
      title: body.title,
      description: body.description,
      kind: body.kind ?? "todo",
      level: body.level ?? (ctx.policy.cfg.levels.default_level as Task["level"]),
      category: body.category ?? "other",
      priority: body.priority ?? "P2",
      parent_id: body.parent_id ?? null,
      depends_on: body.depends_on ?? [],
      status: body.status ?? "todo",
      deadline: body.deadline ?? null,
      labels: body.labels ?? [],
      acceptance_criteria: body.acceptance_criteria ?? [],
      owner: body.owner ?? "ai",
      budget_usd: body.budget_usd ?? ctx.config.brain.budget_usd_per_run,
      max_attempts: ctx.config.executor.max_attempts,
    });
    bus.record({ type: "system", task_id: task.id, message: "task created from dashboard", payload: { by: "human", source: "dashboard" } });
    bus.emit("task.changed", { task_id: task.id, status: task.status });
    if (task.status === "ready") bus.wake("manual_task");
    return c.json({ task }, 201);
  });

  app.get("/tasks/:id", (c) => {
    const task = mustGet(c.req.param("id"));
    const children = repo.tasks.children(task.id);
    const runs = repo.runs.listByTask(task.id);
    const approvals = repo.approvals.list({ task_id: task.id, limit: 100 });
    const artifacts = repo.artifacts.listByTask(task.id);
    const events = repo.events.list({ task_id: task.id, limit: 50 });
    const parent = task.parent_id ? repo.tasks.get(task.parent_id) ?? null : null;
    const dependencies = task.depends_on.map((id) => repo.tasks.get(id)).filter((t): t is Task => Boolean(t));
    const inbox_item = task.inbox_item_id ? repo.inbox.get(task.inbox_item_id) ?? null : null;
    return c.json({ task, parent, children, dependencies, runs, approvals, artifacts, events, inbox_item });
  });

  app.patch("/tasks/:id", async (c) => {
    const task = mustGet(c.req.param("id"));
    const body = await parseBody(c, PatchBody);
    const { status, reason, ...rest } = body;
    const patch: Partial<Task> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
    let updated = task;
    if (Object.keys(patch).length) {
      updated = repo.tasks.update(task.id, patch)!;
      bus.record({ type: "system", task_id: task.id, message: `task edited: ${Object.keys(patch).join(", ")}`, payload: { by: "human", patch } });
    }
    if (status && status !== task.status) {
      updated = transitionTask(repo, bus, task.id, status, { force: true, reason: reason ?? "human intervention (dashboard)" });
      if (status === "ready") bus.wake("manual_status");
    }
    return c.json({ task: updated });
  });

  app.post("/tasks/:id/retry", async (c) => {
    const ex = ctx.services.executor;
    if (!ex) throw unavailable();
    const task = mustGet(c.req.param("id"));
    return c.json({ task: await ex.retryTask(task.id) });
  });

  app.post("/tasks/:id/cancel", async (c) => {
    const ex = ctx.services.executor;
    if (!ex) throw unavailable();
    const task = mustGet(c.req.param("id"));
    const body = await parseBody(c, CancelBody);
    return c.json({ task: await ex.cancelTask(task.id, body.reason) });
  });

  app.post("/tasks/:id/run", async (c) => {
    const ex = ctx.services.executor;
    if (!ex) throw unavailable();
    const task = mustGet(c.req.param("id"));
    return c.json({ task: await ex.runTaskNow(task.id) });
  });

  app.post("/tasks/:id/plan", async (c) => {
    const planner = ctx.services.planner;
    if (!planner) throw unavailable();
    const task = mustGet(c.req.param("id"));
    return c.json({ task: await planner.planTask(task.id) });
  });

  /** Human note on a task, recorded as a `system` event with payload.by = "human". */
  app.post("/tasks/:id/events", async (c) => {
    const task = mustGet(c.req.param("id"));
    const body = await parseBody(c, NoteBody);
    const event = bus.record({ type: "system", task_id: task.id, message: body.message, payload: { by: "human", source: "dashboard", note: true } });
    return c.json({ event }, 201);
  });

  app.get("/tasks/:id/events", (c) => {
    const task = mustGet(c.req.param("id"));
    const limit = intParam(c, "limit", 200, 2000, 1);
    const type = listParam(c, "type");
    const run_id = strParam(c, "run_id");
    return c.json({ items: repo.events.list({ task_id: task.id, run_id, type, limit, after_id: strParam(c, "after_id") }) });
  });

  return app;
}
