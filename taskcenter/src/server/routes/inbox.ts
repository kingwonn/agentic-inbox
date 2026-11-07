import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../core/app.js";
import { INBOX_STATUSES, PRIORITIES, CATEGORIES } from "../../core/types.js";
import { LevelSchema, badRequest, intParam, listParam, notFound, oneOf, pageOf, parseBody, unavailable } from "../util.js";

const PromoteBody = z.object({
  overrides: z
    .object({
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      level: LevelSchema.optional(),
      priority: z.enum(PRIORITIES).optional(),
      category: z.enum(CATEGORIES).optional(),
      status: z.enum(["todo", "ready"]).optional(),
    })
    .optional(),
});

const DismissBody = z.object({ reason: z.string().optional() });
const SnoozeBody = z.object({ until: z.string().min(1) });

export function inboxRoutes(ctx: AppContext) {
  const app = new Hono();
  const { repo } = ctx;

  app.get("/inbox", (c) => {
    const status = oneOf(listParam(c, "status"), INBOX_STATUSES, "status");
    const limit = intParam(c, "limit", 100, 500, 1);
    const offset = intParam(c, "offset", 0);
    const items = repo.inbox.list({ status, limit, offset });
    return c.json(pageOf(items, limit, offset));
  });

  app.get("/inbox/:id", (c) => {
    const item = repo.inbox.get(c.req.param("id"));
    if (!item) throw notFound("inbox item not found");
    const signals = repo.signals.getMany(item.source_signal_ids);
    const task = item.task_id ? repo.tasks.get(item.task_id) ?? null : null;
    return c.json({ item, signals, task });
  });

  app.post("/inbox/:id/promote", async (c) => {
    const svc = ctx.services.inbox;
    if (!svc) throw unavailable();
    const id = c.req.param("id");
    if (!repo.inbox.get(id)) throw notFound("inbox item not found");
    const body = await parseBody(c, PromoteBody);
    const task = svc.promote(id, body.overrides);
    return c.json({ task, item: repo.inbox.get(id) });
  });

  app.post("/inbox/:id/dismiss", async (c) => {
    const svc = ctx.services.inbox;
    if (!svc) throw unavailable();
    const id = c.req.param("id");
    if (!repo.inbox.get(id)) throw notFound("inbox item not found");
    const body = await parseBody(c, DismissBody);
    return c.json({ item: svc.dismiss(id, body.reason) });
  });

  app.post("/inbox/:id/snooze", async (c) => {
    const svc = ctx.services.inbox;
    if (!svc) throw unavailable();
    const id = c.req.param("id");
    if (!repo.inbox.get(id)) throw notFound("inbox item not found");
    const body = await parseBody(c, SnoozeBody);
    const until = new Date(body.until);
    if (Number.isNaN(until.getTime())) throw badRequest("invalid until (expected ISO date)");
    return c.json({ item: svc.snooze(id, until.toISOString()) });
  });

  app.post("/inbox/:id/done", (c) => {
    const svc = ctx.services.inbox;
    if (!svc) throw unavailable();
    const id = c.req.param("id");
    if (!repo.inbox.get(id)) throw notFound("inbox item not found");
    return c.json({ item: svc.done(id) });
  });

  return app;
}
