import { describe, expect, it, beforeEach } from "vitest";
import { openDb } from "../src/core/db.js";
import { Repo } from "../src/core/repo.js";
import { Bus } from "../src/core/events.js";
import { transitionTask, transitionRun, InvalidTransition } from "../src/core/state.js";
import { Policy } from "../src/core/policy.js";
import { Budget } from "../src/core/budget.js";
import { loadConfig, substituteEnv } from "../src/config/load.js";
import { resolve } from "node:path";

function mem() {
  const db = openDb(":memory:");
  const repo = new Repo(db);
  const bus = new Bus(repo);
  return { db, repo, bus };
}

describe("db + repo", () => {
  let ctx: ReturnType<typeof mem>;
  beforeEach(() => {
    ctx = mem();
  });

  it("migrates and upserts signals idempotently", () => {
    const { repo } = ctx;
    const a = repo.signals.upsert({ source: "t", external_id: "1", kind: "x", title: "hello", body: "world" });
    expect(a.isNew).toBe(true);
    const b = repo.signals.upsert({ source: "t", external_id: "1", kind: "x", title: "hello", body: "world" });
    expect(b.isNew).toBe(false);
    expect(b.changed).toBe(false);
    const c = repo.signals.upsert({ source: "t", external_id: "1", kind: "x", title: "hello", body: "changed" });
    expect(c.changed).toBe(true);
    expect(c.signal.triaged).toBe(0);
    expect(repo.signals.count()).toBe(1);
    expect(repo.signals.list({ q: "changed" }).length).toBe(1);
  });

  it("creates tasks with json columns and dependency checks", () => {
    const { repo } = ctx;
    const t1 = repo.tasks.create({ title: "A", status: "done" });
    const t2 = repo.tasks.create({ title: "B", status: "ready", depends_on: [t1.id], labels: ["x"] });
    expect(repo.tasks.get(t2.id)?.depends_on).toEqual([t1.id]);
    expect(repo.tasks.runnable().map((t) => t.id)).toEqual([t2.id]);
    const t3 = repo.tasks.create({ title: "C", status: "ready", depends_on: [t2.id] });
    expect(repo.tasks.runnable().map((t) => t.id)).not.toContain(t3.id);
  });

  it("enforces one active run per task", () => {
    const { repo } = ctx;
    const t = repo.tasks.create({ title: "A" });
    repo.runs.create({ task_id: t.id, runner: "dry", model: "x" });
    expect(() => repo.runs.create({ task_id: t.id, runner: "dry", model: "x" })).toThrow();
  });

  it("decides approvals atomically", () => {
    const { repo } = ctx;
    const a = repo.approvals.create({ kind: "action", title: "send" });
    expect(repo.approvals.decide(a.id, { status: "approved", decision: "approve" })).toBe(true);
    expect(repo.approvals.decide(a.id, { status: "rejected", decision: "reject" })).toBe(false);
    expect(repo.approvals.get(a.id)?.status).toBe("approved");
  });

  it("transactions roll back", () => {
    const { repo, db } = ctx;
    expect(() =>
      db.transaction(() => {
        repo.tasks.create({ title: "x" });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(repo.tasks.list().length).toBe(0);
  });
});

describe("state machine", () => {
  it("transitions tasks and records events", () => {
    const { repo, bus } = mem();
    const t = repo.tasks.create({ title: "A" });
    transitionTask(repo, bus, t.id, "ready");
    transitionTask(repo, bus, t.id, "running");
    expect(() => transitionTask(repo, bus, t.id, "todo")).toThrow(InvalidTransition);
    transitionTask(repo, bus, t.id, "done");
    const events = repo.events.list({ task_id: t.id, type: "status_change" });
    expect(events.length).toBe(3);
    expect(repo.tasks.get(t.id)?.finished_at).toBeTruthy();
  });

  it("unblocks dependents when a dependency completes", () => {
    const { repo, bus } = mem();
    const a = repo.tasks.create({ title: "A", status: "running" });
    const b = repo.tasks.create({ title: "B", status: "blocked", depends_on: [a.id] });
    transitionTask(repo, bus, a.id, "done");
    expect(repo.tasks.get(b.id)?.status).toBe("ready");
  });

  it("transitions runs", () => {
    const { repo, bus } = mem();
    const t = repo.tasks.create({ title: "A" });
    const r = repo.runs.create({ task_id: t.id, runner: "dry", model: "m" });
    transitionRun(repo, bus, r.id, "running");
    transitionRun(repo, bus, r.id, "succeeded", { cost_usd: 0.5 });
    expect(repo.runs.get(r.id)?.status).toBe("succeeded");
    expect(repo.runs.get(r.id)?.ended_at).toBeTruthy();
  });
});

describe("policy", () => {
  const policy = Policy.load(resolve(import.meta.dirname, "../config/policy.yaml"));

  it("clamps levels by category, confidence and capabilities", () => {
    const d1 = policy.decideLevel({ proposed: 5, category: "finance", priority: "P1", confidence: 0.9 });
    expect(d1.level).toBe(2);
    const d2 = policy.decideLevel({ proposed: 5, category: "code", priority: "P1", confidence: 0.3 });
    expect(d2.level).toBe(4);
    const d3 = policy.decideLevel({ proposed: 5, category: "code", priority: "P1", confidence: 0.9, requiredCapabilities: ["email_send"], availableCapabilities: [] });
    expect(d3.level).toBe(2);
    const d4 = policy.decideLevel({ proposed: 4, category: "code", priority: "P1", confidence: 0.9, text: "please pay the invoice" });
    expect(d4.level).toBe(2);
    expect(d4.category).toBe("finance");
    const d5 = policy.decideLevel({ proposed: 4, category: "code", priority: "P1", confidence: 0.9 });
    expect(d5.autoPromote).toBe(true);
    const d6 = policy.decideLevel({ proposed: 2, category: "code", priority: "P1", confidence: 0.9 });
    expect(d6.autoPromote).toBe(false);
  });

  it("gates tools", () => {
    expect(policy.evaluateToolUse({ level: 2, toolName: "Write", input: { file_path: "/x" } }).action).toBe("deny");
    expect(policy.evaluateToolUse({ level: 3, toolName: "Bash", input: { command: "git push origin main" } }).action).toBe("approve");
    expect(policy.evaluateToolUse({ level: 5, toolName: "Bash", input: { command: "git push -u origin tc/fix" } }).action).toBe("allow");
    expect(policy.evaluateToolUse({ level: 5, toolName: "Bash", input: { command: "git push origin main" } }).action).toBe("approve");
    expect(policy.evaluateToolUse({ level: 5, toolName: "Bash", input: { command: "rm -rf /" } }).action).toBe("approve");
    expect(policy.evaluateToolUse({ level: 5, toolName: "Bash", input: { command: "mkfs.ext4 /dev/sda" } }).action).toBe("deny");
    expect(policy.evaluateToolUse({ level: 4, toolName: "mcp__taskcenter__send_email", input: {} }).action).toBe("approve");
    expect(policy.evaluateToolUse({ level: 3, toolName: "Read", input: { file_path: "/etc/hosts" } }).action).toBe("allow");
    expect(policy.evaluateToolUse({ level: 3, toolName: "Write", input: { file_path: "/tmp/other" }, workspace: "/ws/t1" }).action).toBe("approve");
    expect(policy.evaluateToolUse({ level: 3, toolName: "Write", input: { file_path: "/ws/t1/a.ts" }, workspace: "/ws/t1" }).action).toBe("allow");
  });
});

describe("budget + config", () => {
  it("tracks daily spend", () => {
    const { repo } = mem();
    const b = new Budget(repo, 10);
    b.record(8.5);
    expect(b.status().warn).toBe(true);
    expect(b.status().exhausted).toBe(false);
    b.record(2);
    expect(b.status().exhausted).toBe(true);
    expect(b.canSpend(0)).toBe(false);
  });

  it("substitutes env and loads example config", () => {
    expect(substituteEnv("a=${X:-dflt} b=${Y}", { X: "", Y: "yy" })).toBe("a=dflt b=yy");
    const { config } = loadConfig({ cwd: resolve(import.meta.dirname, ".."), env: { TC_CONFIG: resolve(import.meta.dirname, "../config/taskcenter.example.yaml") } });
    expect(config.server.port).toBe(4800);
    expect(config.sensors.github.repos).toContain("kingwonn/agentic-inbox");
  });
});
