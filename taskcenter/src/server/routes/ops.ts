import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../core/app.js";
import { parseBody, unavailable } from "../util.js";

const PollBody = z.object({ sensors: z.array(z.string().min(1)).optional() });
const PauseBody = z.object({ reason: z.string().max(500).optional() });

/** Operational actions: sensors poll, triage run, executor control. */
export function opsRoutes(ctx: AppContext) {
  const app = new Hono();

  app.post("/sensors/poll", async (c) => {
    const patrol = ctx.services.patrol;
    if (!patrol) throw unavailable();
    const body = await parseBody(c, PollBody);
    const report = await patrol.runOnce(body.sensors);
    return c.json({ report });
  });

  app.post("/triage/run", async (c) => {
    const triage = ctx.services.triage;
    if (!triage) throw unavailable();
    const report = await triage.runOnce();
    return c.json({ report });
  });

  app.post("/executor/pause", async (c) => {
    const ex = ctx.services.executor;
    if (!ex) throw unavailable();
    const body = await parseBody(c, PauseBody);
    ex.pause(body.reason ?? "paused from dashboard");
    ctx.bus.record({ type: "system", message: `executor paused: ${body.reason ?? "dashboard"}`, payload: { by: "human", action: "pause" } });
    return c.json({ executor: ex.status() });
  });

  app.post("/executor/resume", (c) => {
    const ex = ctx.services.executor;
    if (!ex) throw unavailable();
    ex.resume();
    ctx.bus.record({ type: "system", message: "executor resumed", payload: { by: "human", action: "resume" } });
    return c.json({ executor: ex.status() });
  });

  app.post("/executor/wake", (c) => {
    const ex = ctx.services.executor;
    if (!ex) throw unavailable();
    ex.wake("dashboard");
    return c.json({ executor: ex.status() });
  });

  app.get("/executor", (c) => c.json({ executor: ctx.services.executor?.status() ?? null }));

  return app;
}
