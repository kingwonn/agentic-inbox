import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type Config } from "../src/config/schema.js";
import { openDb } from "../src/core/db.js";
import { Bus } from "../src/core/events.js";
import { silentLogger } from "../src/core/logger.js";
import { Repo } from "../src/core/repo.js";
import type { Approval, Task } from "../src/core/types.js";
import type { Channel, NotifyMessage } from "../src/hitl/types.js";

export function mem() {
  const db = openDb(":memory:");
  const repo = new Repo(db);
  const bus = new Bus(repo);
  return { db, repo, bus, logger: silentLogger };
}

export function cfg(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ locale: "en", timezone: "UTC", ...overrides });
}

export function tmp(): string {
  return mkdtempSync(join(process.env.SCRATCH_DIR ?? tmpdir(), "tc-hitl-"));
}

/** In-memory channel that records what it was asked to send. */
export class FakeChannel implements Channel {
  sent: NotifyMessage[] = [];
  decided: Approval[] = [];
  started = false;
  stopped = false;
  fail = false;
  constructor(
    readonly name: string,
    private readonly isConfigured = true,
  ) {}
  configured() {
    return this.isConfigured;
  }
  async send(msg: NotifyMessage) {
    if (this.fail) throw new Error("boom");
    this.sent.push(msg);
    return { ok: true, externalRef: `${this.name}-${this.sent.length}` };
  }
  async onDecided(a: Approval) {
    this.decided.push(a);
  }
  async start() {
    this.started = true;
  }
  async stop() {
    this.stopped = true;
  }
}

export function fakeTask(over: Partial<Task> = {}): Task {
  const now = "2026-11-05T10:00:00.000Z";
  return {
    id: "tsk_000000000abcdefgh",
    parent_id: null,
    title: "Reply to Alice about the invoice",
    description: "",
    kind: "todo",
    category: "communication",
    priority: "P1",
    level: 3,
    status: "running",
    owner: "ai",
    runner: null,
    model: null,
    plan: null,
    depends_on: [],
    acceptance_criteria: [],
    deadline: null,
    follow_up_at: null,
    attempts: 1,
    max_attempts: 3,
    budget_usd: 2,
    cost_usd: 0.42,
    result_summary: null,
    last_error: null,
    inbox_item_id: null,
    workspace: null,
    labels: [],
    context: {},
    created_at: now,
    updated_at: now,
    started_at: now,
    finished_at: null,
    ...over,
  };
}

export function fakeApproval(over: Partial<Approval> = {}): Approval {
  const now = "2026-11-05T10:00:00.000Z";
  return {
    id: "apr_000000000abcdefgh",
    task_id: "tsk_000000000abcdefgh",
    run_id: null,
    kind: "action",
    title: "Send email to alice@example.com",
    context: "Alice asked for the invoice status on Monday.",
    recommendation: "Approve; the draft is factual and polite.",
    options: [
      { value: "approve", label: "Approve" },
      { value: "edit", label: "Edit & approve" },
      { value: "reject", label: "Reject" },
    ],
    payload: { tool: "mcp__taskcenter__send_email", input: { to: "alice@example.com", subject: "Re: Invoice #42", body: "Hi Alice, the invoice was paid on Nov 3." } },
    risk: "high",
    status: "pending",
    decision: null,
    decision_note: null,
    edited_payload: null,
    decided_by: null,
    decided_at: null,
    expires_at: "2026-11-08T10:00:00.000Z",
    channel_refs: {},
    created_at: now,
    updated_at: now,
    ...over,
  };
}

/** Build a fetch stub from a queue of responders keyed by URL substring. */
export type FetchCall = { url: string; init?: RequestInit; body?: any };
export function fetchStub(responder: (call: FetchCall) => unknown | Promise<unknown>) {
  const calls: FetchCall[] = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = init?.body;
    }
    const call = { url, init, body };
    calls.push(call);
    const out = await responder(call);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
