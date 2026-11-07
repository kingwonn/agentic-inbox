import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../core/app.js";
import { intParam, notFound, pageOf, parseBody, strParam, unavailable } from "../util.js";

const CaptureBody = z.object({
  text: z.string().min(1).max(50_000),
  title: z.string().max(500).optional(),
  url: z.string().max(2000).optional(),
});

export function signalsRoutes(ctx: AppContext) {
  const app = new Hono();
  const { repo } = ctx;

  app.get("/signals", (c) => {
    const limit = intParam(c, "limit", 50, 500, 1);
    const offset = intParam(c, "offset", 0);
    const items = repo.signals.list({ source: strParam(c, "source"), q: strParam(c, "q"), limit, offset });
    return c.json(pageOf(items, limit, offset));
  });

  app.get("/signals/:id", (c) => {
    const signal = repo.signals.get(c.req.param("id"));
    if (!signal) throw notFound("signal not found");
    const inbox_item = signal.inbox_item_id ? repo.inbox.get(signal.inbox_item_id) ?? null : null;
    return c.json({ signal, inbox_item });
  });

  /** Free-text capture into the inbox pipeline (manual sensor). */
  app.post("/capture", async (c) => {
    const capture = ctx.services.capture;
    if (!capture) throw unavailable();
    const body = await parseBody(c, CaptureBody);
    const signal = await capture(body.text, "dashboard", { title: body.title, url: body.url });
    return c.json({ signal }, 201);
  });

  return app;
}
