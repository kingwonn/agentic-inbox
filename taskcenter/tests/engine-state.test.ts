import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exportState, importState } from "../src/engine/state-export.js";
import { makeCtx, type TestCtx } from "./engine-helpers.js";

describe("engine/state-export", () => {
  const ctxs: TestCtx[] = [];
  afterEach(async () => {
    for (const c of ctxs.splice(0)) await c.cleanup();
  });

  it("round-trips every table, is idempotent, keeps newer rows and merges signals by (source, external_id)", async () => {
    const a = await makeCtx();
    const b = await makeCtx();
    ctxs.push(a, b);
    // b already knows the signal under its own id (older) → the import must merge by (source, external_id), newest wins
    const rb = b.ctx.repo;
    rb.signals.upsert({ source: "github", external_id: "pr-1", kind: "pr", title: "older", body: "old" });
    await new Promise((r) => setTimeout(r, 5));
    const ra = a.ctx.repo;
    const sig = ra.signals.upsert({ source: "github", external_id: "pr-1", kind: "pr", title: "PR 1", body: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }).signal;
    const item = ra.inbox.create({ kind: "todo", title: "i", summary: "s", category: "code", priority: "P1", level: 3, level_proposed: 3, level_reason: "", confidence: 0.9, suggested_action: "", source_signal_ids: [sig.id], tags: ["x"], status: "triaged" });
    const task = ra.tasks.create({ title: "t", level: 3, status: "ready", inbox_item_id: item.id, context: { k: 1 } });
    const run = ra.runs.create({ task_id: task.id, runner: "dry", model: "m", status: "succeeded" });
    ra.approvals.create({ kind: "review", title: "r", task_id: task.id, run_id: run.id });
    ra.artifacts.create({ task_id: task.id, run_id: run.id, type: "text", title: "art", content: "c" });
    ra.memories.create({ kind: "fact", content: "m", source: "test" });
    ra.cursors.set("github", "since", "2026-01-01");
    ra.budgets.add("2026-11-05", 1.5, 2);
    ra.meta.set("k", "v");
    a.ctx.bus.record({ type: "system", message: "hello" });

    const exp = exportState(a.ctx, join(a.dir, "out"));
    expect(exp.manifest.tables.signals.rows).toBe(1);
    expect(exp.manifest.tables.tasks.rows).toBe(1);
    expect(exp.manifest.tables.events.rows).toBeGreaterThan(0);
    const signalsFile = readFileSync(join(exp.dir, "signals.jsonl"), "utf8");
    expect(signalsFile).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789"); // redacted
    expect(JSON.parse(readFileSync(join(exp.dir, "manifest.json"), "utf8")).version).toBe(1);

    const imp = importState(b.ctx, exp.dir);
    expect(imp.tables.tasks.applied).toBe(1);
    expect(imp.tables.signals.applied).toBe(1);
    expect(rb.signals.count()).toBe(1);
    expect(rb.signals.getByExternal("github", "pr-1")?.title).toBe("PR 1");
    expect(rb.tasks.get(task.id)?.context).toEqual({ k: 1 });
    expect(rb.inbox.get(item.id)?.tags).toEqual(["x"]);
    expect(rb.runs.get(run.id)?.status).toBe("succeeded");
    expect(rb.approvals.list({ task_id: task.id }).length).toBe(1);
    expect(rb.artifacts.listByTask(task.id).length).toBe(1);
    expect(rb.memories.active().length).toBe(1);
    expect(rb.cursors.get("github", "since")).toBe("2026-01-01");
    expect(rb.budgets.get("2026-11-05")).toMatchObject({ cost_usd: 1.5, runs: 2 });
    expect(rb.meta.get("k")).toBe("v");
    expect(rb.events.list({ limit: 1000 }).some((e) => e.message === "hello")).toBe(true);

    // idempotent: second import applies nothing new for append-only tables, and does not duplicate
    const eventsBefore = rb.events.count();
    const imp2 = importState(b.ctx, exp.dir);
    expect(imp2.tables.events.applied).toBe(0);
    expect(rb.events.count()).toBe(eventsBefore + 1); // only the import's own "state imported" event
    expect(rb.tasks.list().length).toBe(1);

    // newer local change survives an import of older data
    rb.tasks.update(task.id, { title: "renamed locally" });
    importState(b.ctx, exp.dir);
    expect(rb.tasks.get(task.id)?.title).toBe("renamed locally");
    // budgets merge by max
    rb.budgets.add("2026-11-05", 1, 1);
    importState(b.ctx, exp.dir);
    expect(rb.budgets.get("2026-11-05").cost_usd).toBe(2.5);
  });

  it("exports only recent append-only rows with sinceDays", async () => {
    const a = await makeCtx();
    ctxs.push(a);
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    a.ctx.repo.db.run("INSERT INTO events (id, ts, level, type, message, payload) VALUES ('old', ?, 'info', 'system', 'old', '{}')", old);
    a.ctx.bus.record({ type: "system", message: "new" });
    const exp = exportState(a.ctx, join(a.dir, "recent"), { sinceDays: 7 });
    const lines = readFileSync(join(exp.dir, "events.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.some((l) => l.includes('"old"'))).toBe(false);
  });
});
