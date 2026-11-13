import { existsSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { AppContext } from "../../core/app.js";
import { MEMORY_KINDS } from "../../core/types.js";
import { intParam, notFound, parseBody } from "../util.js";

const CreateBody = z.object({
  kind: z.enum(MEMORY_KINDS),
  content: z.string().min(1).max(5000),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

/** Read the profile YAML (config.profile_path) as text + parsed object; never throws. */
export function readProfile(ctx: AppContext): { path: string; exists: boolean; text: string; profile: Record<string, unknown> } {
  const path = ctx.loaded.resolve(ctx.config.profile_path);
  if (!existsSync(path)) return { path, exists: false, text: "", profile: {} };
  try {
    const text = readFileSync(path, "utf8");
    const parsed = parseYaml(text);
    return { path, exists: true, text, profile: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {} };
  } catch (e) {
    ctx.logger.warn(`profile unreadable: ${(e as Error).message}`);
    return { path, exists: true, text: "", profile: {} };
  }
}

export function memoriesRoutes(ctx: AppContext) {
  const app = new Hono();
  const { repo, bus } = ctx;

  app.get("/memories", (c) => {
    const kind = c.req.query("kind") || undefined;
    const limit = intParam(c, "limit", 200, 1000, 1);
    const includeRetired = c.req.query("all") === "1";
    const items = includeRetired
      ? repo.db.all("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?", limit).map((r) => ({ ...r, tags: safeJson(r.tags) }))
      : repo.memories.active({ kind, limit });
    return c.json({ items });
  });

  app.post("/memories", async (c) => {
    const body = await parseBody(c, CreateBody);
    const { memory, isNew } = repo.memories.upsertByContent({ kind: body.kind, content: body.content, source: "user", confidence: body.confidence ?? 0.9, tags: body.tags ?? [] });
    if (isNew) bus.record({ type: "memory", message: `memory added by user: ${body.content.slice(0, 60)}`, payload: { memory_id: memory.id, kind: memory.kind, by: "human" } });
    return c.json({ memory, isNew }, isNew ? 201 : 200);
  });

  app.delete("/memories/:id", (c) => {
    const id = c.req.param("id");
    const m = repo.memories.get(id);
    if (!m) throw notFound("memory not found");
    repo.memories.retire(id);
    bus.record({ type: "memory", message: `memory retired: ${m.content.slice(0, 60)}`, payload: { memory_id: id, by: "human", retired: true } });
    return c.json({ memory: repo.memories.get(id) });
  });

  /** Profile text + active memories: what the brain sees as "context". */
  app.get("/context", (c) => {
    const prof = readProfile(ctx);
    return c.json({
      profilePath: prof.path,
      profileExists: prof.exists,
      profileText: prof.text,
      profile: prof.profile,
      memories: repo.memories.active({ limit: 500 }),
      locale: ctx.config.locale,
      timezone: ctx.config.timezone,
    });
  });

  return app;
}

function safeJson(v: unknown): unknown {
  if (typeof v !== "string") return v ?? [];
  try {
    return JSON.parse(v);
  } catch {
    return [];
  }
}
