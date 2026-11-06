/**
 * Deterministic LlmProvider for tests and `provider: dry` installs.
 * Returns canned JSON by `purpose`:
 *  - classify: a plausible TriageResult per signal using keyword heuristics
 *    (signals are read from the first ```json block in the prompt)
 *  - plan: a simple 2-3 step plan with no subtasks
 *  - anything else: an echo-like text response
 * Zero cost.
 */
import type { LlmProvider, LlmRequest, LlmResponse } from "../llm.js";
import { extractFirstJson } from "./util.js";

interface SignalDigest {
  id: string;
  source?: string;
  kind?: string;
  title?: string;
  body?: string;
  actor?: string;
}

export function dryTriageFor(sig: SignalDigest): Record<string, unknown> {
  const text = `${sig.title ?? ""} ${sig.body ?? ""} ${sig.kind ?? ""}`.toLowerCase();
  const title = sig.title ?? sig.id;
  let kind = "info";
  let category = "other";
  let priority = "P3";
  let level = 1;
  let dismiss = false;
  let suggested = "Review";
  if (/newsletter|digest|unsubscribe|promotion|sale|webinar/.test(text)) {
    dismiss = true;
    suggested = "Dismiss (noise)";
  } else if (/pull request|pull_request|\bpr\b|review requested|merge/.test(text)) {
    kind = "todo";
    category = "code";
    priority = "P1";
    level = 3;
    suggested = "Review the PR and leave comments";
  } else if (/\bbug\b|error|fail|crash|broken|incident|outage/.test(text)) {
    kind = "problem";
    category = "code";
    priority = "P1";
    level = 3;
    suggested = "Investigate and propose a fix";
  } else if (/invoice|payment|refund|wire|transfer/.test(text)) {
    kind = "decision";
    category = "finance";
    priority = "P2";
    level = 2;
    suggested = "Check and decide";
  } else if (/meeting|calendar|event|invite|schedule/.test(text) || sig.kind === "event") {
    kind = "todo";
    category = "scheduling";
    priority = "P2";
    level = 2;
    suggested = "Prepare for the meeting";
  } else if (/\?|could you|can you|please|would you/.test(text) && (sig.kind === "email" || sig.source === "imap")) {
    kind = "todo";
    category = "communication";
    priority = "P1";
    level = 2;
    suggested = "Draft a reply";
  } else if (/uncommitted|stale branch|dirty/.test(text)) {
    kind = "todo";
    category = "code";
    priority = "P2";
    level = 3;
    suggested = "Commit or discard the pending changes";
  } else if (/opportunity|offer|grant|invite to speak|collaborat/.test(text)) {
    kind = "opportunity";
    category = "research";
    priority = "P2";
    level = 2;
    suggested = "Evaluate";
  }
  return {
    signal_ids: [sig.id],
    kind,
    title: title.slice(0, 120),
    summary: (sig.body ?? title).slice(0, 200) || title,
    category,
    priority,
    level,
    level_reason: dismiss ? "noise" : `dry heuristic (${kind}/${category})`,
    confidence: dismiss ? 0.9 : 0.75,
    suggested_action: suggested,
    tags: [sig.source ?? "unknown", sig.kind ?? "signal"].filter(Boolean),
    dismiss,
    learned: [],
  };
}

export class DryLlmProvider implements LlmProvider {
  readonly name = "dry";
  calls: LlmRequest[] = [];
  /** Optional override hook for tests: return a value to use as the JSON response. */
  respond?: (req: LlmRequest) => unknown;

  async available(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const started = Date.now();
    let json: unknown;
    if (this.respond) json = this.respond(req);
    if (json === undefined) json = this.canned(req);
    const text = typeof json === "string" ? json : JSON.stringify(json, null, 2);
    return { text, json: typeof json === "string" ? undefined : json, costUsd: 0, inputTokens: Math.ceil(req.prompt.length / 4), outputTokens: Math.ceil(text.length / 4), durationMs: Date.now() - started, model: req.model };
  }

  private canned(req: LlmRequest): unknown {
    const purpose = req.purpose ?? "";
    if (purpose === "classify" || purpose === "classify-repair") {
      const data = extractFirstJson(req.prompt);
      const signals: SignalDigest[] = Array.isArray(data) ? (data as SignalDigest[]) : [];
      return { items: signals.filter((s) => s && typeof s.id === "string").map(dryTriageFor) };
    }
    if (purpose === "plan" || purpose === "plan-repair") {
      const data = extractFirstJson(req.prompt) as { title?: string; acceptance_criteria?: string[]; level?: number; category?: string } | undefined;
      const title = data?.title ?? "task";
      return {
        plan: {
          goal: `Complete: ${title}`,
          steps: [
            { title: "Understand the context and constraints", description: "Read the task brief, linked material and the workspace.", needs_approval: false, tools: ["Read", "Grep"] },
            { title: "Do the work", description: `Carry out "${title}" inside the workspace.`, needs_approval: false, tools: ["Write", "Edit", "Bash"] },
            { title: "Verify and report", description: "Run checks/tests, then deliver artifacts and a summary.", needs_approval: false, tools: ["Bash", "mcp__taskcenter__deliver_artifact"] },
          ],
          required_capabilities: [],
          risks: [],
          acceptance_criteria: data?.acceptance_criteria?.length ? data.acceptance_criteria : ["The deliverable matches the task description", "Verification evidence is included in the summary"],
          estimated_cost_usd: 0.2,
          notes: "dry plan",
        },
        subtasks: [],
      };
    }
    if (purpose === "digest") return `(dry polish — unchanged)\n${req.prompt}`;
    if (purpose === "profile-suggestions") return "- (dry) no profile changes suggested";
    return req.jsonSchema ? {} : `dry response for ${purpose || "prompt"}`;
  }
}

export function createDryLlmProvider(): DryLlmProvider {
  return new DryLlmProvider();
}
