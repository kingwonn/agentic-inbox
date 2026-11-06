/**
 * Dry / in-memory implementations of the pluggable contracts. Used by:
 *  - tests (deterministic, no network, no LLM),
 *  - `tc --dry` (provider/runner replaced by stubs),
 *  - wiring fallbacks while sibling modules are not yet available.
 */
import type { LlmProvider, LlmRequest, LlmResponse } from "../brain/llm.js";
import type { NotifierLike } from "../core/app.js";
import type { Bus } from "../core/events.js";
import type { Logger } from "../core/logger.js";
import type { Repo } from "../core/repo.js";
import { HOUR, isoPlus } from "../core/time.js";
import type { AgentOutput, Approval, ApprovalStatus } from "../core/types.js";
import type { ApprovalService, InboundDecision, NotifyMessage } from "../hitl/types.js";
import type { RunEvent, RunInput, RunResult, Runner } from "../runners/types.js";
import { sleep } from "./util.js";

// ── LLM ─────────────────────────────────────────────────────────────

export function createDryLlm(): LlmProvider {
  return {
    name: "dry",
    async available() {
      return { ok: true };
    },
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const text = req.jsonSchema ? "{}" : `[dry] ${req.prompt.slice(0, 80)}`;
      return { text, json: req.jsonSchema ? {} : undefined, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, model: req.model };
    },
  };
}

// ── Runner ──────────────────────────────────────────────────────────

/**
 * Outcome hints read from task.context.dry so demos/tests can script behaviour:
 *   { status: 'failed' | 'succeeded', agentStatus: 'done'|'partial'|'blocked'|'needs_human',
 *     verified: boolean, cost: number, delayMs: number, tool: 'Bash', toolInput: {...},
 *     summary, artifacts, learned, question, options, error }
 */
export interface DryOutcome {
  status?: "succeeded" | "failed";
  /** runners/dry.ts compatible keys */
  fail?: boolean;
  needsApproval?: string;
  agentStatus?: AgentOutput["status"];
  verified?: boolean;
  cost?: number;
  delayMs?: number;
  tool?: string;
  toolInput?: Record<string, unknown>;
  summary?: string;
  artifacts?: AgentOutput["artifacts"];
  learned?: string[];
  question?: string;
  options?: string[];
  error?: string;
  followUps?: string[];
}

export interface DryRunnerOptions {
  delayMs?: number;
  /** Fully scripted events (tests). */
  script?: (input: RunInput) => AsyncIterable<RunEvent> | Iterable<RunEvent>;
}

function failed(error: string, costUsd = 0, sessionId?: string): RunResult {
  return { status: "failed", sessionId, text: "", costUsd, inputTokens: 0, outputTokens: 0, numTurns: 0, durationMs: 0, error };
}

export function createDryRunner(opts: DryRunnerOptions = {}): Runner {
  return {
    name: "dry",
    async available() {
      return { ok: true };
    },
    async *run(input: RunInput): AsyncIterable<RunEvent> {
      if (opts.script) {
        yield* opts.script(input);
        return;
      }
      const started = Date.now();
      const raw = ((input.task.context ?? {}).dry ?? {}) as DryOutcome & { status?: string };
      // Accept runners/dry.ts style scripts too ({fail, needsApproval, status: AgentOutput status}).
      const d: DryOutcome = { ...raw };
      if (raw.fail) d.status = "failed";
      if (raw.status && !["succeeded", "failed"].includes(raw.status)) {
        d.agentStatus = raw.status as AgentOutput["status"];
        d.status = "succeeded";
      }
      if (raw.needsApproval && !d.tool) {
        const [tool, ...rest] = raw.needsApproval.split(" ");
        d.tool = tool;
        d.toolInput = tool === "Bash" ? { command: rest.join(" ") } : {};
      }
      const sessionId = input.resumeSessionId ?? `dry-${input.run.id}`;
      const cost = d.cost ?? 0.01;
      yield { type: "started", sessionId, model: input.model };
      yield { type: "assistant", text: input.resumeSessionId ? `Resuming after decision: ${input.resumeMessage ?? ""}`.slice(0, 500) : `Dry run of "${input.task.title}" at L${input.level}` };
      const delay = d.delayMs ?? opts.delayMs ?? 0;
      if (delay > 0) await sleep(delay, input.signal);
      if (input.signal.aborted) {
        yield { type: "error", error: "aborted" };
        yield { type: "result", result: failed("aborted", 0, sessionId) };
        return;
      }
      if (d.tool && !input.resumeSessionId) {
        const toolInput = d.toolInput ?? {};
        yield { type: "tool_call", tool: d.tool, input: toolInput };
        const g = await input.gate({ tool: d.tool, input: toolInput });
        if (g.action === "deny" && g.pendingApprovalId) {
          yield { type: "approval_requested", approvalId: g.pendingApprovalId, tool: d.tool };
          yield {
            type: "result",
            result: { status: "waiting_human", sessionId, text: "waiting for approval", costUsd: cost, inputTokens: 50, outputTokens: 20, numTurns: 1, durationMs: Date.now() - started, pendingApprovalId: g.pendingApprovalId },
          };
          return;
        }
        yield { type: "tool_result", tool: d.tool, output: g.action === "allow" ? "ok (dry)" : `denied: ${g.reason}`, isError: g.action !== "allow" };
      }
      yield { type: "tool_call", tool: "Read", input: { file_path: "README.md" } };
      yield { type: "tool_result", tool: "Read", output: "(dry) file contents" };
      yield { type: "cost", costUsd: cost, inputTokens: 100, outputTokens: 50 };
      if (d.status === "failed") {
        const err = d.error ?? "dry failure";
        yield { type: "error", error: err };
        yield { type: "result", result: failed(err, cost, sessionId) };
        return;
      }
      const agentStatus = d.agentStatus ?? "done";
      const structured: AgentOutput = {
        summary: d.summary ?? `Dry run completed: ${input.task.title}`,
        status: agentStatus,
        artifacts: d.artifacts ?? [{ type: "text", title: "Dry note", content: `Dry result for ${input.task.title}` }],
        verification: { passed: d.verified ?? true, details: "dry verification" },
        follow_ups: d.followUps ?? [],
        needs_human: agentStatus === "needs_human" ? { question: d.question ?? "Need your input to continue", options: d.options } : null,
        learned: d.learned ?? [],
      };
      yield {
        type: "result",
        result: { status: "succeeded", sessionId, text: JSON.stringify(structured), structured, costUsd: cost, inputTokens: 100, outputTokens: 50, numTurns: 2, durationMs: Date.now() - started },
      };
    },
  };
}

// ── Approvals (DB-backed, in-process) ───────────────────────────────

function statusFor(decision: InboundDecision["decision"]): ApprovalStatus {
  switch (decision) {
    case "approve":
      return "approved";
    case "reject":
      return "rejected";
    case "edit":
      return "edited";
    default:
      return "approved"; // respond: answered
  }
}

export function createMemoryApprovalService(
  repo: Repo,
  bus: Bus,
  opts: { expireHours?: number; notifier?: NotifierLike; pollMs?: number; logger?: Logger } = {},
): ApprovalService {
  const pollMs = opts.pollMs ?? 500;
  return {
    async request(input) {
      const a = repo.approvals.create({ expires_at: isoPlus((opts.expireHours ?? 72) * HOUR), ...input });
      bus.record({
        type: "approval_requested",
        task_id: a.task_id,
        run_id: a.run_id,
        message: `[${a.kind}] ${a.title}`,
        payload: { approval_id: a.id, kind: a.kind, risk: a.risk, options: a.options.map((o) => o.value) },
      });
      bus.emit("approval.requested", { approval_id: a.id, task_id: a.task_id });
      if (opts.notifier) {
        const task = a.task_id ? repo.tasks.get(a.task_id) : undefined;
        await opts.notifier.notify({ kind: "approval_requested", title: a.title, body: a.context, approval: a, task, priority: a.risk === "high" ? "high" : "normal" }).catch((e) => opts.logger?.warn("notify failed", e));
      }
      return a;
    },
    async waitForDecision(approvalId, timeoutMs, signal) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const a = repo.approvals.get(approvalId);
        if (!a) throw new Error(`approval not found: ${approvalId}`);
        if (a.status !== "pending") return a;
        const left = deadline - Date.now();
        if (left <= 0 || signal?.aborted) return a;
        await sleep(Math.min(pollMs, left), signal);
      }
    },
    async decide(d) {
      const ok = repo.approvals.decide(d.approvalId, {
        status: statusFor(d.decision),
        decision: d.decision,
        decision_note: d.note ?? null,
        edited_payload: d.editedPayload ?? null,
        decided_by: d.decidedBy,
      });
      if (!ok) {
        const cur = repo.approvals.get(d.approvalId);
        throw new Error(cur ? `approval ${d.approvalId} is ${cur.status}, not pending` : `approval not found: ${d.approvalId}`);
      }
      const a = repo.approvals.get(d.approvalId) as Approval;
      bus.record({
        type: "approval_decided",
        task_id: a.task_id,
        run_id: a.run_id,
        message: `${a.kind} ${a.decision} by ${a.decided_by}${d.note ? `: ${d.note}` : ""}`,
        payload: { approval_id: a.id, decision: a.decision, status: a.status, note: d.note ?? null },
      });
      bus.emit("approval.decided", { approval_id: a.id, task_id: a.task_id, decision: d.decision });
      return a;
    },
    pending() {
      return repo.approvals.pending();
    },
  };
}

// ── Notifier ────────────────────────────────────────────────────────

export function createConsoleNotifier(logger: Logger, repo?: Repo, opts: { print?: boolean } = {}): NotifierLike {
  return {
    async notify(msg: NotifyMessage) {
      logger.info(`[notify:${msg.kind}] ${msg.title}`, { body: msg.body.slice(0, 400) });
      if (opts.print) process.stderr.write(`\n=== ${msg.kind}: ${msg.title} ===\n${msg.body}\n\n`);
      repo?.notifications.create({
        channel: "console",
        target: null,
        approval_id: msg.approval?.id ?? null,
        task_id: msg.task?.id ?? null,
        title: msg.title,
        body: msg.body,
        status: "sent",
        external_ref: null,
        error: null,
      });
    },
  };
}
