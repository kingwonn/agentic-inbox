/**
 * Tool gate: policy evaluation for every tool call, with inline human
 * approval (Outbox) for sensitive actions.
 */
import type { Bus } from "../core/events.js";
import type { Logger } from "../core/logger.js";
import type { Policy } from "../core/policy.js";
import { isoPlus } from "../core/time.js";
import type { Approval, Level, Run, Task } from "../core/types.js";
import type { ApprovalService } from "../hitl/types.js";
import { truncateChars } from "../brain/providers/util.js";
import type { ToolGate, ToolGateResult } from "./types.js";

export interface ToolGateOpts {
  policy: Policy;
  level: Level;
  task: Task;
  run: Run;
  workspace: string;
  approvals: ApprovalService;
  bus: Bus;
  waitMs: number;
  expiresHours: number;
  signal: AbortSignal;
  logger: Logger;
}

/** A ToolGate plus introspection used by runners. */
export interface ToolGateWithState extends ToolGate {
  /** Set when a deny was issued because an approval is still pending. */
  pendingApprovalId?: string;
  /** All approvals this gate created during the run. */
  approvalIds: string[];
}

function describeCall(tool: string, input: Record<string, unknown>): { what: string; why: string } {
  if (tool === "Bash") return { what: `Run shell command: ${truncateChars(String(input.command ?? ""), 500)}`, why: typeof input.description === "string" ? input.description : "" };
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) return { what: `${tool} ${String(input.file_path ?? input.path ?? "")}`, why: "" };
  if (tool.startsWith("mcp__")) {
    const parts = tool.split("__");
    return { what: `${parts[2] ?? tool} via ${parts[1] ?? "mcp"}: ${truncateChars(JSON.stringify(input), 500)}`, why: "" };
  }
  return { what: `${tool} ${truncateChars(JSON.stringify(input), 500)}`, why: "" };
}

export function pendingMessage(id: string): string {
  return `Approval ${id} is pending human review. Stop working on this step, record what you have done so far, and finish with status needs_human.`;
}

export function createToolGate(opts: ToolGateOpts): ToolGateWithState {
  const { policy, level, task, run, workspace, approvals, bus, waitMs, expiresHours, signal, logger } = opts;
  const cache = new Map<string, ToolGateResult>();
  const inflight = new Map<string, Promise<ToolGateResult>>();

  const decideFromApproval = (a: Approval, tool: string, input: Record<string, unknown>): ToolGateResult => {
    const note = a.decision_note ? ` Note: ${a.decision_note}` : "";
    switch (a.status) {
      case "approved":
      case "edited": {
        const edited = a.edited_payload && typeof a.edited_payload === "object" ? (a.edited_payload as Record<string, unknown>) : null;
        const editedInput = edited && edited.input && typeof edited.input === "object" ? (edited.input as Record<string, unknown>) : edited && !("tool" in edited) && Object.keys(edited).length ? edited : null;
        if (a.decision === "respond") {
          return { action: "deny", reason: `The human responded instead of approving: ${a.decision_note ?? "(no text)"}. Follow their response; do not retry this exact action unless they asked for it.` };
        }
        return { action: "allow", input: editedInput ?? input, reason: `approved by ${a.decided_by ?? "human"}${a.status === "edited" ? " (edited)" : ""}${note}` };
      }
      case "rejected":
        return { action: "deny", reason: `The human rejected this action: ${a.decision_note ?? "no reason given"}. Do not retry it; continue with an alternative or wrap up.` };
      case "expired":
      case "cancelled":
        return { action: "deny", reason: `Approval ${a.id} was ${a.status}. Do not retry this action; record it as blocked.` };
      case "pending":
      default:
        return { action: "deny", reason: pendingMessage(a.id), pendingApprovalId: a.id };
    }
  };

  const evaluate = async (tool: string, input: Record<string, unknown>, toolUseId?: string): Promise<ToolGateResult> => {
    const decision = policy.evaluateToolUse({ level, toolName: tool, input, workspace });
    if (decision.action === "allow") return { action: "allow", reason: decision.reason };
    if (decision.action === "deny") {
      logger.info(`gate deny ${tool}: ${decision.reason}`, { task_id: task.id, run_id: run.id });
      return { action: "deny", reason: `Denied by policy: ${decision.reason}` };
    }
    // approve → Outbox
    const { what, why } = describeCall(tool, input);
    const approval = await approvals.request({
      task_id: task.id,
      run_id: run.id,
      kind: "action",
      title: truncateChars(what, 140),
      context: `${why ? `${why}\n\n` : ""}Task: ${task.title} (L${level})\nReason: ${decision.reason}\nTool: ${tool}\nInput: ${truncateChars(JSON.stringify(input, null, 1), 2000)}`,
      recommendation: decision.risk === "high" ? "Review carefully; this action is high risk." : "Approve if the action matches the task intent.",
      payload: { tool, input, tool_use_id: toolUseId ?? null },
      risk: decision.risk,
      options: [
        { value: "approve", label: "Approve" },
        { value: "edit", label: "Edit & approve", description: "Change the input before it runs" },
        { value: "reject", label: "Reject" },
      ],
      expires_at: isoPlus(expiresHours * 3_600_000),
    });
    gate.approvalIds.push(approval.id);
    // The approval service records the user-facing approval_requested event; this one is the gate's audit trail.
    bus.record({ type: "approval_requested", level: "debug", task_id: task.id, run_id: run.id, message: `gate: waiting for approval ${approval.id} (${tool})`, payload: { approval_id: approval.id, tool, risk: decision.risk, reason: decision.reason, source: "gate" } });
    logger.info(`gate approval ${approval.id} requested for ${tool}`, { task_id: task.id, run_id: run.id });
    let decided: Approval;
    try {
      decided = await approvals.waitForDecision(approval.id, waitMs, signal);
    } catch (e) {
      logger.warn(`waitForDecision failed: ${(e as Error).message}`);
      decided = approval;
    }
    const result = decideFromApproval(decided, tool, input);
    if (result.action === "deny" && result.pendingApprovalId) gate.pendingApprovalId = result.pendingApprovalId;
    logger.info(`gate ${tool}: ${result.action} (approval ${approval.id} ${decided.status})`, { task_id: task.id, run_id: run.id });
    return result;
  };

  const gate = (async (call: { tool: string; input: Record<string, unknown>; toolUseId?: string }): Promise<ToolGateResult> => {
    const input = call.input && typeof call.input === "object" ? call.input : {};
    let key: string;
    try {
      key = `${call.tool}:${JSON.stringify(input)}`;
    } catch {
      key = `${call.tool}:${String(input)}`;
    }
    const cached = cache.get(key);
    if (cached) return cached;
    const running = inflight.get(key);
    if (running) return running;
    const p = evaluate(call.tool, input, call.toolUseId)
      .then((r) => {
        // Cache everything except transient policy allows (cheap to recompute) — we cache those too for consistency.
        cache.set(key, r);
        return r;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }) as ToolGateWithState;
  gate.approvalIds = [];
  return gate;
}
