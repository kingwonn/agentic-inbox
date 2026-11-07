import type { Logger } from "../core/logger.js";
import type { GateDecision } from "../core/policy.js";
import type { AgentOutput, Level, Run, Task } from "../core/types.js";

/**
 * The runner contract. A Runner executes one Run of a Task using some agent
 * backend (Claude Agent SDK, raw claude CLI, Codex CLI, or a dry stub) and
 * streams RunEvents back to the executor, which persists them.
 */

export type RunEvent =
  | { type: "started"; sessionId?: string; model?: string }
  | { type: "assistant"; text: string }
  | { type: "tool_call"; tool: string; input: unknown; toolUseId?: string }
  | { type: "tool_result"; tool: string; output: unknown; toolUseId?: string; isError?: boolean }
  | { type: "approval_requested"; approvalId: string; tool: string }
  | { type: "approval_decided"; approvalId: string; decision: string }
  | { type: "progress"; message: string }
  | { type: "cost"; costUsd: number; inputTokens?: number; outputTokens?: number }
  | { type: "result"; result: RunResult }
  | { type: "error"; error: string };

export interface RunResult {
  status: "succeeded" | "failed" | "waiting_human";
  sessionId?: string;
  text: string;
  structured?: AgentOutput;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  durationMs: number;
  error?: string;
  /** Set when the agent stopped because an approval is pending. */
  pendingApprovalId?: string;
}

/**
 * The gate the executor hands to a runner. The runner calls it for every tool
 * use (via hooks / canUseTool). The gate applies policy and, when approval is
 * needed, creates an Outbox item and waits (up to approval.wait_seconds) for a
 * decision. On timeout it returns {action:'deny', pendingApprovalId} so the
 * agent can stop cleanly and the run is parked as waiting_human.
 */
export interface ToolGate {
  (call: { tool: string; input: Record<string, unknown>; toolUseId?: string }): Promise<ToolGateResult>;
}

export type ToolGateResult =
  | { action: "allow"; input?: Record<string, unknown>; reason: string }
  | { action: "deny"; reason: string; pendingApprovalId?: string; interrupt?: boolean };

export interface RunInput {
  task: Task;
  run: Run;
  level: Level;
  /** The full prompt (task brief + context) for the agent. */
  prompt: string;
  /** Text appended to the agent's system prompt (rules, output contract). */
  systemPromptAppend: string;
  /** Working directory for the agent (isolated workspace). */
  workspace: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns: number;
  timeoutMs: number;
  budgetUsd: number;
  allowedTools: string[];
  disallowedTools: string[];
  /** JSON schema the agent must satisfy in its final structured output (AgentOutput). */
  outputSchema: Record<string, unknown>;
  /** Resume an earlier session (after approval) with this message. */
  resumeSessionId?: string;
  resumeMessage?: string;
  /** Extra MCP servers (e.g. the in-process taskcenter tools) keyed by server name. */
  mcpServers?: Record<string, unknown>;
  gate: ToolGate;
  signal: AbortSignal;
  logger: Logger;
  /** Optional policy decision helper for the runner to pre-classify (informational). */
  describeGate?: (tool: string, input: Record<string, unknown>) => GateDecision;
}

export interface Runner {
  readonly name: string;
  /** Whether this runner can run on this machine (binary present, auth ok). */
  available(): Promise<{ ok: boolean; reason?: string }>;
  run(input: RunInput): AsyncIterable<RunEvent>;
}
