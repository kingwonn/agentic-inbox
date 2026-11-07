import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server/app.js";
import { createMemoryContext, seedDemo } from "../src/server/seed.js";

type Ctx = ReturnType<typeof createMemoryContext>;

function build(opts: Parameters<typeof createMemoryContext>[0] = {}) {
  const ctx = createMemoryContext({ ...opts, rootDir: opts.rootDir ?? mkdtempSync(join(tmpdir(), "tc-root-")) });
  const seeded = seedDemo(ctx.repo, ctx.bus);
  const server = createServer(ctx, { heartbeatMs: 50 });
  return { ctx, seeded, server, app: server.app };
}

const json = (body: unknown, method = "POST", headers: Record<string, string> = {}) => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("server: reads", () => {
  let t: ReturnType<typeof build>;
  beforeEach(() => {
    t = build();
  });
  afterEach(async () => {
    await t.server.stop();
    await t.ctx.shutdown();
  });

  it("GET /api/status summarises config without secrets and counts", async () => {
    const res = await t.app.request("/api/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBeTypeOf("string");
    expect(body.config.provider).toBe("claude-sdk");
    expect(body.config.models.classify).toBe("haiku");
    expect(JSON.stringify(body.config)).not.toMatch(/token|password/i);
    expect(body.counts.inbox.new).toBe(3);
    expect(body.counts.tasks.running).toBe(1);
    expect(body.counts.approvals.pending).toBe(2);
    expect(body.counts.runs.succeeded).toBe(1);
    expect(body.budget.limitUsd).toBe(20);
    expect(body.executor.running.length).toBe(1);
    expect(body.schedules.length).toBe(4);
    expect(body.sensors.github.cursors).toBe(2);
  });

  it("GET /api/inbox filters by status and GET /api/inbox/:id includes signals", async () => {
    const list = await (await t.app.request("/api/inbox?status=new&limit=10")).json();
    expect(list.items.length).toBe(3);
    expect(list.items.every((i: { status: string }) => i.status === "new")).toBe(true);
    const bad = await t.app.request("/api/inbox?status=bogus");
    expect(bad.status).toBe(400);
    const detail = await (await t.app.request(`/api/inbox/${t.seeded.inbox[1].id}`)).json();
    expect(detail.item.id).toBe(t.seeded.inbox[1].id);
    expect(detail.signals.length).toBe(2);
    expect(detail.task.id).toBe(t.seeded.inbox[1].task_id);
    expect((await t.app.request("/api/inbox/inb_nope")).status).toBe(404);
  });

  it("GET /api/tasks/:id returns children, runs, approvals, artifacts and events", async () => {
    const running = t.seeded.tasks.find((x) => x.status === "running")!;
    const res = await t.app.request(`/api/tasks/${running.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.id).toBe(running.id);
    expect(body.children.length).toBe(2);
    expect(body.runs.length).toBe(1);
    expect(body.approvals.length).toBe(1);
    expect(body.artifacts.length).toBe(1);
    expect(body.events.length).toBeGreaterThan(5);
    expect(body.events.some((e: { type: string }) => e.type === "tool_call")).toBe(true);
    expect(body.inbox_item.id).toBe(running.inbox_item_id);
    const list = await (await t.app.request("/api/tasks?status=running,failed")).json();
    expect(list.items.length).toBe(2);
    const roots = await (await t.app.request("/api/tasks?parent_id=null")).json();
    expect(roots.items.every((x: { parent_id: string | null }) => x.parent_id === null)).toBe(true);
  });

  it("GET /api/runs/:id returns chronological events; /api/events filters", async () => {
    const run = t.seeded.runs[0];
    const body = await (await t.app.request(`/api/runs/${run.id}`)).json();
    expect(body.run.id).toBe(run.id);
    expect(body.task.id).toBe(run.task_id);
    const types = body.events.map((e: { type: string }) => e.type);
    expect(types[0]).toBe("run_started");
    expect(types.indexOf("run_finished")).toBeGreaterThan(types.indexOf("tool_call"));
    const ev = await (await t.app.request("/api/events?type=tool_call&limit=5")).json();
    expect(ev.items.length).toBe(5);
    expect(ev.more).toBe(true);
    const errs = await (await t.app.request("/api/events?level=error")).json();
    expect(errs.items.length).toBeGreaterThan(0);
    const runs = await (await t.app.request("/api/runs?status=failed")).json();
    expect(runs.items.length).toBe(1);
    expect(runs.items[0].task_title).toBeTypeOf("string");
  });

  it("GET /api/approvals, /api/artifacts, /api/signals, /api/memories, /api/context, /api/budget", async () => {
    const ap = await (await t.app.request("/api/approvals?status=pending")).json();
    expect(ap.items.length).toBe(2);
    const art = await (await t.app.request("/api/artifacts")).json();
    expect(art.items.length).toBe(3);
    const sig = await (await t.app.request("/api/signals?source=imap")).json();
    expect(sig.items.length).toBe(2);
    expect((await (await t.app.request("/api/signals?source=github")).json()).items.length).toBe(2);
    const q = await (await t.app.request("/api/signals?q=IDLE")).json();
    expect(q.items.length).toBe(1);
    const mem = await (await t.app.request("/api/memories")).json();
    expect(mem.items.length).toBe(4);
    const cx = await (await t.app.request("/api/context")).json();
    expect(cx.memories.length).toBe(4);
    expect(cx.profileExists).toBe(false);
    const b = await (await t.app.request("/api/budget")).json();
    expect(b.status.day).toBeTypeOf("string");
    expect(b.history.length).toBeGreaterThan(3);
    const n = await (await t.app.request("/api/notifications?limit=5")).json();
    expect(n.items.length).toBe(2);
    expect((await t.app.request("/api/nope")).status).toBe(404);
  });

  it("GET /api/context reads the profile yaml when present", async () => {
    const dir = t.ctx.loaded.rootDir;
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "profile.yaml"), "identity:\n  name: Tester\n");
    const cx = await (await t.app.request("/api/context")).json();
    expect(cx.profileExists).toBe(true);
    expect(cx.profile.identity.name).toBe("Tester");
    expect(cx.profileText).toContain("Tester");
  });
});

describe("server: actions call services", () => {
  let t: ReturnType<typeof build>;
  beforeEach(() => {
    t = build();
  });
  afterEach(async () => {
    await t.server.stop();
    await t.ctx.shutdown();
  });

  it("POST /api/inbox/:id/promote calls inbox.promote with overrides", async () => {
    const item = t.seeded.inbox[2];
    const res = await t.app.request(`/api/inbox/${item.id}/promote`, json({ overrides: { level: 4, priority: "P1" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.level).toBe(4);
    expect(body.task.priority).toBe("P1");
    expect(body.item.status).toBe("promoted");
    expect(t.ctx.calls.find((c) => c.service === "inbox.promote")?.args).toEqual([item.id, { level: 4, priority: "P1" }]);
    const bad = await t.app.request(`/api/inbox/${item.id}/promote`, json({ overrides: { level: 9 } }));
    expect(bad.status).toBe(400);
  });

  it("POST /api/inbox/:id/dismiss|snooze|done", async () => {
    const [a, b] = t.seeded.inbox;
    expect((await (await t.app.request(`/api/inbox/${a.id}/dismiss`, json({ reason: "noise" }))).json()).item.status).toBe("dismissed");
    const until = new Date(Date.now() + 86400000).toISOString();
    expect((await (await t.app.request(`/api/inbox/${b.id}/snooze`, json({ until }))).json()).item.snoozed_until).toBe(until);
    expect((await t.app.request(`/api/inbox/${b.id}/snooze`, json({ until: "garbage" }))).status).toBe(400);
    expect((await (await t.app.request(`/api/inbox/${b.id}/done`, { method: "POST" })).json()).item.status).toBe("done");
    expect(t.ctx.calls.map((c) => c.service)).toEqual(["inbox.dismiss", "inbox.snooze", "inbox.done"]);
  });

  it("POST /api/approvals/:id/decide calls approvals.decide as dashboard", async () => {
    const a = t.seeded.approvals[0];
    const res = await t.app.request(`/api/approvals/${a.id}/decide`, json({ decision: "approve", note: "ok" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.status).toBe("approved");
    expect(body.approval.decided_by).toBe("dashboard");
    const call = t.ctx.calls.find((c) => c.service === "approvals.decide")!;
    expect(call.args[0]).toMatchObject({ approvalId: a.id, decision: "approve", note: "ok", decidedBy: "dashboard" });
    // second decision on a non-pending approval -> 409
    expect((await t.app.request(`/api/approvals/${a.id}/decide`, json({ decision: "reject" }))).status).toBe(409);
    // custom option value is accepted; unknown value rejected; edit needs payload
    const b = t.seeded.approvals[1];
    expect((await t.app.request(`/api/approvals/${b.id}/decide`, json({ decision: "nonsense" }))).status).toBe(400);
    expect((await t.app.request(`/api/approvals/${b.id}/decide`, json({ decision: "edit" }))).status).toBe(400);
    const edited = await t.app.request(`/api/approvals/${b.id}/decide`, json({ decision: "edit", editedPayload: { tool: "Bash", input: { command: "npm ci" } } }));
    expect(edited.status).toBe(200);
    expect((await edited.json()).approval.edited_payload.input.command).toBe("npm ci");
  });

  it("POST /api/tasks creates; PATCH forces status; notes are system events", async () => {
    const created = await t.app.request("/api/tasks", json({ title: "手动任务", level: 3, priority: "P1", category: "writing" }));
    expect(created.status).toBe(201);
    const { task } = await created.json();
    expect(task.status).toBe("todo");
    expect(task.level).toBe(3);
    const patched = await t.app.request(`/api/tasks/${task.id}`, json({ status: "done", title: "改名" }, "PATCH"));
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.task.status).toBe("done");
    expect(patchedBody.task.title).toBe("改名");
    const note = await t.app.request(`/api/tasks/${task.id}/events`, json({ message: "人工备注" }));
    expect(note.status).toBe(201);
    const detail = await (await t.app.request(`/api/tasks/${task.id}`)).json();
    const types = detail.events.map((e: { type: string }) => e.type);
    expect(types).toContain("status_change");
    expect(detail.events.find((e: { message: string }) => e.message === "人工备注").payload.by).toBe("human");
    expect((await t.app.request("/api/tasks", json({ title: "" }))).status).toBe(400);
    expect((await t.app.request("/api/tasks", json({ title: "x", parent_id: "tsk_missing" }))).status).toBe(400);
  });

  it("POST /api/tasks/:id/retry|cancel|run|plan call the executor/planner", async () => {
    const failed = t.seeded.tasks.find((x) => x.status === "failed")!;
    expect((await (await t.app.request(`/api/tasks/${failed.id}/retry`, { method: "POST" })).json()).task.status).toBe("ready");
    expect((await (await t.app.request(`/api/tasks/${failed.id}/cancel`, json({ reason: "nah" }))).json()).task.status).toBe("cancelled");
    expect((await (await t.app.request(`/api/tasks/${failed.id}/run`, { method: "POST" })).json()).task.status).toBe("ready");
    expect((await (await t.app.request(`/api/tasks/${failed.id}/plan`, { method: "POST" })).json()).task.plan).toBeTruthy();
    expect(t.ctx.calls.map((c) => c.service)).toEqual(["executor.retryTask", "executor.cancelTask", "executor.runTaskNow", "planner.planTask"]);
    expect((await t.app.request("/api/tasks/tsk_missing/retry", { method: "POST" })).status).toBe(404);
  });

  it("ops routes: sensors/poll, triage/run, executor pause/resume, capture, memories", async () => {
    const poll = await t.app.request("/api/sensors/poll", json({ sensors: ["github"] }));
    expect(poll.status).toBe(200);
    expect((await poll.json()).report.sensors[0].name).toBe("github");
    expect((await t.app.request("/api/triage/run", { method: "POST" })).status).toBe(200);
    expect((await (await t.app.request("/api/executor/pause", json({ reason: "lunch" }))).json()).executor.paused).toBe(true);
    expect((await (await t.app.request("/api/executor/resume", { method: "POST" })).json()).executor.paused).toBe(false);
    const cap = await t.app.request("/api/capture", json({ text: "记得给李雷回邮件", url: "https://x" }));
    expect(cap.status).toBe(201);
    expect((await cap.json()).signal.source).toBe("manual");
    const mem = await t.app.request("/api/memories", json({ kind: "fact", content: "测试记忆" }));
    expect(mem.status).toBe(201);
    const { memory } = await mem.json();
    const del = await t.app.request(`/api/memories/${memory.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()).memory.valid_to).toBeTruthy();
    expect((await (await t.app.request("/api/memories")).json()).items.find((m: { id: string }) => m.id === memory.id)).toBeUndefined();
  });

  it("returns 503 when a needed service is missing", async () => {
    const ctx = createMemoryContext({ stubServices: false, rootDir: mkdtempSync(join(tmpdir(), "tc-root-")) });
    const seeded = seedDemo(ctx.repo, ctx.bus);
    const { app } = createServer(ctx);
    const r1 = await app.request(`/api/inbox/${seeded.inbox[0].id}/promote`, json({}));
    expect(r1.status).toBe(503);
    expect((await r1.json()).error).toBe("service unavailable");
    expect((await app.request(`/api/approvals/${seeded.approvals[0].id}/decide`, json({ decision: "approve" }))).status).toBe(503);
    expect((await app.request("/api/sensors/poll", json({}))).status).toBe(503);
    expect((await app.request("/api/capture", json({ text: "x" }))).status).toBe(503);
    // reads keep working; executor is null in status
    expect((await (await app.request("/api/status")).json()).executor).toBeNull();
    await ctx.shutdown();
  });
});

describe("server: SSE", () => {
  it("streams hello, heartbeats and bus events with the right headers", async () => {
    const t = build();
    const ac = new AbortController();
    const res = await t.app.request("/api/events/stream", { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readUntil = async (needle: string) => {
      for (let i = 0; i < 50 && !buf.includes(needle); i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
      return buf.includes(needle);
    };
    expect(await readUntil("event: hello")).toBe(true);
    t.ctx.bus.record({ type: "system", message: "ping from test" });
    expect(await readUntil("ping from test")).toBe(true);
    expect(buf).toMatch(/event: event\ndata: \{"id":"evt_/);
    t.ctx.bus.emit("task.changed", { task_id: "tsk_x", status: "done" });
    expect(await readUntil("event: task.changed")).toBe(true);
    expect(await readUntil("event: heartbeat")).toBe(true);
    ac.abort();
    await reader.cancel().catch(() => {});
    await t.server.stop();
    await t.ctx.shutdown();
  });
});

describe("server: auth", () => {
  it("requires a bearer token for writes and the stream when configured", async () => {
    const t = build({ config: { server: { token: "s3cret" } } });
    expect((await t.app.request("/api/status")).status).toBe(200); // GET open
    const item = t.seeded.inbox[0].id;
    const denied = await t.app.request(`/api/inbox/${item}/done`, { method: "POST" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Bearer");
    expect((await t.app.request(`/api/inbox/${item}/done`, { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await t.app.request(`/api/inbox/${item}/done`, { method: "POST", headers: { authorization: "Bearer s3cret" } })).status).toBe(200);
    const ac = new AbortController();
    expect((await t.app.request("/api/events/stream", { signal: ac.signal })).status).toBe(401);
    const ok = await t.app.request("/api/events/stream?token=s3cret", { signal: ac.signal });
    expect(ok.status).toBe(200);
    ac.abort();
    await ok.body?.cancel().catch(() => {});
    await t.server.stop();
    await t.ctx.shutdown();
  });
});

describe("server: artifacts + static", () => {
  let root: string;
  let t: ReturnType<typeof build>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tc-art-"));
    t = build({ rootDir: root, dataDir: join(root, "data") });
    mkdirSync(join(root, "data"), { recursive: true });
  });
  afterEach(async () => {
    await t.server.stop();
    await t.ctx.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  it("serves inline content and files inside the data dir, refuses traversal", async () => {
    const task = t.seeded.tasks[0];
    // inline content artifact
    const inline = t.seeded.artifacts[0];
    const r0 = await t.app.request(`/api/artifacts/${inline.id}?download=1`);
    expect(r0.status).toBe(200);
    expect(await r0.text()).toContain("Agent SDK hooks");
    // file inside dataDir
    writeFileSync(join(root, "data", "report.txt"), "hello file");
    const ok = t.ctx.repo.artifacts.create({ task_id: task.id, type: "file", title: "report.txt", path: join(root, "data", "report.txt") });
    const r1 = await t.app.request(`/api/artifacts/${ok.id}?download=1`);
    expect(r1.status).toBe(200);
    expect(await r1.text()).toBe("hello file");
    expect((await (await t.app.request(`/api/artifacts/${ok.id}`)).json()).downloadable).toBe(true);
    // relative path resolves against dataDir
    const rel = t.ctx.repo.artifacts.create({ task_id: task.id, type: "file", title: "rel", path: "report.txt" });
    expect((await t.app.request(`/api/artifacts/${rel.id}?download=1`)).status).toBe(200);
    // traversal / outside roots
    writeFileSync(join(root, "secret.txt"), "nope");
    const bad = t.ctx.repo.artifacts.create({ task_id: task.id, type: "file", title: "secret", path: join(root, "data", "..", "secret.txt") });
    expect((await t.app.request(`/api/artifacts/${bad.id}?download=1`)).status).toBe(403);
    const abs = t.ctx.repo.artifacts.create({ task_id: task.id, type: "file", title: "passwd", path: "/etc/passwd" });
    expect((await t.app.request(`/api/artifacts/${abs.id}?download=1`)).status).toBe(403);
    expect((await (await t.app.request(`/api/artifacts/${abs.id}`)).json()).downloadable).toBe(false);
    const missing = t.ctx.repo.artifacts.create({ task_id: task.id, type: "file", title: "missing", path: join(root, "data", "missing.txt") });
    expect((await t.app.request(`/api/artifacts/${missing.id}?download=1`)).status).toBe(404);
  });

  it("serves the inline help page when web/dist is missing, and the SPA when present", async () => {
    const r0 = await t.app.request("/");
    expect(r0.status).toBe(200);
    expect(await r0.text()).toContain("npm run build:web");
    mkdirSync(join(root, "web", "dist", "assets"), { recursive: true });
    writeFileSync(join(root, "web", "dist", "index.html"), "<!doctype html><title>TC</title>");
    writeFileSync(join(root, "web", "dist", "assets", "app.js"), "console.log(1)");
    expect(await (await t.app.request("/")).text()).toContain("<title>TC</title>");
    expect(await (await t.app.request("/tasks/tsk_123")).text()).toContain("<title>TC</title>"); // SPA fallback
    const js = await t.app.request("/assets/app.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect((await t.app.request("/assets/nope.js")).status).toBe(404);
    expect((await t.app.request("/../package.json")).status).not.toBe(200);
    expect((await t.app.request("/assets/%2e%2e/%2e%2e/package.json")).status).toBe(404);
  });
});

describe("server: lifecycle", () => {
  it("start() binds a free port and stop() closes it", async () => {
    const t = build({ config: { server: { host: "127.0.0.1", port: 0 } } });
    const { host, port } = await t.server.start();
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://${host}:${port}/api/status`);
    expect(res.status).toBe(200);
    await t.server.stop();
    await expect(fetch(`http://${host}:${port}/api/status`)).rejects.toThrow();
    await t.ctx.shutdown();
  });
});
