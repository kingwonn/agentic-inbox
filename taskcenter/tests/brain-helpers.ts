import { resolve } from "node:path";
import { ConfigSchema, type Config } from "../src/config/schema.js";
import type { LoadedConfig } from "../src/config/load.js";
import { openDb } from "../src/core/db.js";
import { Bus } from "../src/core/events.js";
import { silentLogger } from "../src/core/logger.js";
import { Policy } from "../src/core/policy.js";
import { Repo } from "../src/core/repo.js";
import type { Approval, InboundDecision, NewApproval, Signal, Task } from "../src/core/types.js";
import type { ApprovalService } from "../src/hitl/types.js";

export const ROOT = resolve(import.meta.dirname, "..");

export function mem() {
  const db = openDb(":memory:");
  const repo = new Repo(db);
  const bus = new Bus(repo);
  return { db, repo, bus, logger: silentLogger };
}

export function cfg(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ locale: "en", timezone: "UTC", brain: { provider: "dry" }, ...overrides });
}

export function loaded(config: Config, rootDir = ROOT): LoadedConfig {
  return { config, configPath: null, rootDir, resolve: (p: string) => (p.startsWith("/") ? p : resolve(rootDir, p)) };
}

export function policy(): Policy {
  return Policy.load(resolve(ROOT, "config/policy.yaml"));
}

export function sig(over: Partial<Signal> & { id: string }): Signal {
  const now = "2026-11-05T09:00:00.000Z";
  return {
    source: "github",
    external_id: over.id,
    kind: "pull_request",
    title: "PR",
    body: "",
    url: null,
    actor: null,
    occurred_at: now,
    observed_at: now,
    updated_at: now,
    fingerprint: "f",
    metadata: {},
    inbox_item_id: null,
    triaged: 0,
    ...over,
  };
}

export function task(over: Partial<Task> = {}): Task {
  const now = "2026-11-05T10:00:00.000Z";
  return {
    id: "tsk_test000000000001",
    parent_id: null,
    title: "Write a hello file",
    description: "Create hello.txt containing hi",
    kind: "todo",
    category: "other",
    priority: "P2",
    level: 3,
    status: "running",
    owner: "ai",
    runner: null,
    model: null,
    plan: null,
    depends_on: [],
    acceptance_criteria: ["hello.txt exists"],
    deadline: null,
    follow_up_at: null,
    attempts: 1,
    max_attempts: 3,
    budget_usd: 1,
    cost_usd: 0,
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

export type FakeMode = "approve" | "edit" | "reject" | "pending" | "respond" | "expired";

/** ApprovalService stub: decides immediately in waitForDecision according to `mode`. */
export class FakeApprovals implements ApprovalService {
  mode: FakeMode = "approve";
  note?: string;
  editedPayload?: Record<string, unknown>;
  requested: Approval[] = [];
  waits = 0;
  constructor(private repo: Repo) {}

  async request(input: NewApproval): Promise<Approval> {
    const a = this.repo.approvals.create(input);
    this.requested.push(a);
    return a;
  }

  async waitForDecision(approvalId: string): Promise<Approval> {
    this.waits++;
    const a = this.repo.approvals.get(approvalId)!;
    if (a.status !== "pending") return a;
    switch (this.mode) {
      case "pending":
        return a;
      case "approve":
        this.repo.approvals.decide(approvalId, { status: "approved", decision: "approve", decision_note: this.note });
        break;
      case "edit":
        this.repo.approvals.decide(approvalId, { status: "edited", decision: "edit", edited_payload: this.editedPayload ?? { tool: "Bash", input: { command: "git push origin tc/edited" } } });
        break;
      case "reject":
        this.repo.approvals.decide(approvalId, { status: "rejected", decision: "reject", decision_note: this.note ?? "not now" });
        break;
      case "respond":
        this.repo.approvals.decide(approvalId, { status: "approved", decision: "respond", decision_note: this.note ?? "use the other branch" });
        break;
      case "expired":
        this.repo.approvals.update(approvalId, { status: "expired" });
        break;
    }
    return this.repo.approvals.get(approvalId)!;
  }

  async decide(d: InboundDecision): Promise<Approval> {
    this.repo.approvals.decide(d.approvalId, { status: d.decision === "reject" ? "rejected" : d.decision === "edit" ? "edited" : "approved", decision: d.decision, decision_note: d.note, edited_payload: d.editedPayload, decided_by: d.decidedBy });
    return this.repo.approvals.get(d.approvalId)!;
  }

  pending(): Approval[] {
    return this.repo.approvals.pending();
  }
}
