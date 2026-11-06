import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../core/app.js";
import { APPROVAL_STATUSES, DECISIONS, type Decision } from "../../core/types.js";
import { HttpError, badRequest, intParam, listParam, notFound, oneOf, pageOf, parseBody, unavailable } from "../util.js";

const DecideBody = z.object({
  decision: z.string().min(1).max(100),
  note: z.string().max(10_000).optional(),
  editedPayload: z.record(z.string(), z.unknown()).optional(),
});

export function approvalsRoutes(ctx: AppContext) {
  const app = new Hono();
  const { repo } = ctx;

  app.get("/approvals", (c) => {
    const status = oneOf(listParam(c, "status"), APPROVAL_STATUSES, "status");
    const limit = intParam(c, "limit", 100, 500, 1);
    const offset = intParam(c, "offset", 0);
    const task_id = c.req.query("task_id") || undefined;
    const items = repo.approvals.list({ status, task_id, limit, offset }).map((a) => ({ ...a, task_title: a.task_id ? repo.tasks.get(a.task_id)?.title ?? null : null }));
    return c.json(pageOf(items, limit, offset));
  });

  app.get("/approvals/:id", (c) => {
    const approval = repo.approvals.get(c.req.param("id"));
    if (!approval) throw notFound("approval not found");
    const task = approval.task_id ? repo.tasks.get(approval.task_id) ?? null : null;
    const run = approval.run_id ? repo.runs.get(approval.run_id) ?? null : null;
    return c.json({ approval, task, run });
  });

  /**
   * Decide a pending approval. `decision` is one of approve|edit|reject|respond or a
   * custom option value listed in approval.options. Decided by "dashboard".
   */
  app.post("/approvals/:id/decide", async (c) => {
    const svc = ctx.services.approvals;
    if (!svc) throw unavailable();
    const approval = repo.approvals.get(c.req.param("id"));
    if (!approval) throw notFound("approval not found");
    const body = await parseBody(c, DecideBody);
    const allowed = new Set<string>([...DECISIONS, ...approval.options.map((o) => o.value)]);
    if (!allowed.has(body.decision)) throw badRequest(`invalid decision: ${body.decision}`, { allowed: [...allowed] });
    if (body.decision === "edit" && !body.editedPayload) throw badRequest("editedPayload is required for decision=edit");
    if (approval.status !== "pending") throw new HttpError(409, `approval is ${approval.status}, not pending`);
    const decided = await svc.decide({
      approvalId: approval.id,
      decision: body.decision as Decision,
      note: body.note,
      editedPayload: body.editedPayload,
      decidedBy: "dashboard",
    });
    return c.json({ approval: decided });
  });

  return app;
}
