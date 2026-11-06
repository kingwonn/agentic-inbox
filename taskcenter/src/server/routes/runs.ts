import { Hono } from "hono";
import type { AppContext } from "../../core/app.js";
import { RUN_STATUSES } from "../../core/types.js";
import { intParam, listParam, notFound, oneOf, pageOf, strParam } from "../util.js";

export function runsRoutes(ctx: AppContext) {
  const app = new Hono();
  const { repo } = ctx;

  app.get("/runs", (c) => {
    const status = oneOf(listParam(c, "status"), RUN_STATUSES, "status");
    const limit = intParam(c, "limit", 100, 500, 1);
    const offset = intParam(c, "offset", 0);
    const task_id = strParam(c, "task_id");
    const runs = task_id ? repo.runs.listByTask(task_id).filter((r) => !status || status.includes(r.status)) : repo.runs.list({ status, limit, offset });
    const items = runs.map((r) => ({ ...r, task_title: repo.tasks.get(r.task_id)?.title ?? null }));
    return c.json(pageOf(items, limit, offset));
  });

  app.get("/runs/:id", (c) => {
    const run = repo.runs.get(c.req.param("id"));
    if (!run) throw notFound("run not found");
    const limit = intParam(c, "limit", 500, 5000, 1);
    const events = repo.events.list({ run_id: run.id, limit }).reverse(); // chronological
    const task = repo.tasks.get(run.task_id) ?? null;
    const approvals = repo.approvals.list({ task_id: run.task_id, limit: 100 }).filter((a) => a.run_id === run.id);
    const artifacts = repo.artifacts.listByTask(run.task_id).filter((a) => a.run_id === run.id);
    return c.json({ run, task, events, approvals, artifacts });
  });

  return app;
}
