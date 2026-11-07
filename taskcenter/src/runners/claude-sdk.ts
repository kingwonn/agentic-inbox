/**
 * Primary Runner: Claude Agent SDK `query()` with
 *  - a PreToolUse hook (no matcher) that logs every tool call and runs the
 *    policy gate (this is the universal interception point: `canUseTool` is
 *    bypassed for tools in allowedTools),
 *  - `canUseTool` as the safety net for calls that still reach the permission
 *    prompt (e.g. `permission_policy: always_ask` MCP tools, subagent paths),
 *  - PostToolUse / PostToolUseFailure hooks that log results,
 *  - structured output via `outputFormat: { type: 'json_schema' }`.
 */
import { randomUUID } from "node:crypto";
import type { CanUseTool, HookCallback, HookInput, Options, PostToolUseFailureHookInput, PostToolUseHookInput, PreToolUseHookInput, Query, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../core/logger.js";
import { silentLogger } from "../core/logger.js";
import type { AgentOutput } from "../core/types.js";
import { extractAgentOutputFromText, parseAgentOutput } from "./result.js";
import type { RunEvent, RunInput, Runner, RunResult, ToolGateResult } from "./types.js";
import { AsyncQueue, UNGATED_TOOLS, agentEnv, errorMessage, isSessionNotFoundError, truncateOutput } from "./util.js";

export interface ClaudeSdkRunnerOptions {
  logger?: Logger;
  /** Override the bundled CLI binary (e.g. `which claude`). */
  pathToClaudeCodeExecutable?: string;
}

type Sdk = typeof import("@anthropic-ai/claude-agent-sdk");

let sdkPromise: Promise<Sdk> | undefined;
function loadSdk(): Promise<Sdk> {
  if (!sdkPromise) sdkPromise = import("@anthropic-ai/claude-agent-sdk");
  return sdkPromise;
}

export class ClaudeSdkRunner implements Runner {
  readonly name = "claude-sdk";
  private logger: Logger;
  private exe?: string;

  constructor(opts: ClaudeSdkRunnerOptions = {}) {
    this.logger = opts.logger ?? silentLogger;
    this.exe = opts.pathToClaudeCodeExecutable ?? process.env.TC_CLAUDE_BIN;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const sdk = await loadSdk();
      if (typeof sdk.query !== "function") return { ok: false, reason: "SDK export query() missing" };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `@anthropic-ai/claude-agent-sdk not loadable: ${errorMessage(e)}` };
    }
  }

  async *run(input: RunInput): AsyncIterable<RunEvent> {
    const log = input.logger ?? this.logger;
    const sdk = await loadSdk();
    const q = new AsyncQueue<RunEvent>();
    const emit = (e: RunEvent) => q.push(e);
    const started = Date.now();

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (input.signal.aborted) ac.abort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      log.warn(`run ${input.run.id} timed out after ${input.timeoutMs}ms; aborting`);
      ac.abort();
    }, input.timeoutMs);
    timer.unref?.();

    let pendingApprovalId: string | undefined;
    let sessionId: string | undefined = input.resumeSessionId;
    let initSeen = false;
    let stderrTail = "";
    const seenToolUse = new Set<string>();

    const runGate = async (tool: string, rawInput: unknown, toolUseId?: string): Promise<ToolGateResult> => {
      const inputObj = rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
      const r = await input.gate({ tool, input: inputObj, toolUseId });
      if (r.action === "deny" && r.pendingApprovalId) {
        pendingApprovalId = r.pendingApprovalId;
        emit({ type: "approval_requested", approvalId: r.pendingApprovalId, tool });
      }
      return r;
    };

    const preToolUse: HookCallback = async (hookInput: HookInput, toolUseID) => {
      const h = hookInput as PreToolUseHookInput;
      const tool = h.tool_name;
      const id = toolUseID ?? h.tool_use_id;
      if (tool === "StructuredOutput") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
      if (!seenToolUse.has(id)) {
        seenToolUse.add(id);
        emit({ type: "tool_call", tool, input: truncateOutput(h.tool_input, 8000), toolUseId: id });
      }
      if (UNGATED_TOOLS.has(tool)) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
      try {
        const r = await runGate(tool, h.tool_input, id);
        if (r.action === "allow") {
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: r.reason, ...(r.input && r.input !== h.tool_input ? { updatedInput: r.input } : {}) } };
        }
        // A hook deny never reaches PostToolUse/PostToolUseFailure, so log the outcome here.
        emit({ type: "tool_result", tool, toolUseId: id, output: r.reason, isError: true });
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.reason } };
      } catch (e) {
        log.error(`gate error for ${tool}: ${errorMessage(e)}`);
        emit({ type: "tool_result", tool, toolUseId: id, output: `gate error: ${errorMessage(e)}`, isError: true });
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `gate error: ${errorMessage(e)}` } };
      }
    };

    const postToolUse: HookCallback = async (hookInput: HookInput, toolUseID) => {
      const h = hookInput as PostToolUseHookInput;
      if (h.tool_name !== "StructuredOutput") emit({ type: "tool_result", tool: h.tool_name, toolUseId: toolUseID ?? h.tool_use_id, output: truncateOutput(h.tool_response) });
      return {};
    };

    const postToolUseFailure: HookCallback = async (hookInput: HookInput, toolUseID) => {
      const h = hookInput as PostToolUseFailureHookInput;
      emit({ type: "tool_result", tool: h.tool_name, toolUseId: toolUseID ?? h.tool_use_id, output: truncateOutput(h.error), isError: true });
      return {};
    };

    const canUseTool: CanUseTool = async (toolName, toolInput, { toolUseID }) => {
      if (toolName === "StructuredOutput" || UNGATED_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: toolInput };
      const r = await runGate(toolName, toolInput, toolUseID);
      if (r.action === "allow") return { behavior: "allow", updatedInput: r.input ?? toolInput };
      emit({ type: "tool_result", tool: toolName, toolUseId: toolUseID, output: r.reason, isError: true });
      return { behavior: "deny", message: r.reason, interrupt: !!r.interrupt };
    };

    const hookTimeoutSec = Math.ceil(input.timeoutMs / 1000) + 60;
    const mcpServers = { ...((input.mcpServers ?? {}) as Options["mcpServers"]) };
    const options: Options = {
      cwd: input.workspace,
      model: input.model,
      ...(input.effort ? { effort: input.effort } : {}),
      maxTurns: input.maxTurns,
      maxBudgetUsd: input.budgetUsd,
      systemPrompt: { type: "preset", preset: "claude_code", append: input.systemPromptAppend, excludeDynamicSections: true },
      settingSources: [],
      strictMcpConfig: true,
      mcpServers,
      // Bare tool names in allowedTools would auto-approve calls before any gate runs (and make the
      // SDK warn CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). The PreToolUse hook decides allow/deny for every
      // call, so only scoped rules such as "Bash(npm test *)" are forwarded; everything else reaches
      // the hook and, as a fallback, canUseTool.
      allowedTools: input.allowedTools.filter((t) => t.includes("(")),
      disallowedTools: input.disallowedTools,
      permissionMode: "default",
      canUseTool,
      hooks: {
        PreToolUse: [{ hooks: [preToolUse], timeout: hookTimeoutSec }],
        PostToolUse: [{ hooks: [postToolUse], timeout: 30 }],
        PostToolUseFailure: [{ hooks: [postToolUseFailure], timeout: 30 }],
      },
      outputFormat: { type: "json_schema", schema: input.outputSchema },
      abortController: ac,
      env: agentEnv(),
      stderr: (line: string) => {
        stderrTail = (stderrTail + line).slice(-4000);
        log.debug(`[claude stderr] ${line.trimEnd()}`);
      },
      ...(this.exe ? { pathToClaudeCodeExecutable: this.exe } : {}),
      // Nested Claude Code sessions inherit the outer session id unless one is given explicitly;
      // a fresh UUID per run keeps transcripts separate and makes resume target the right one.
      ...(input.resumeSessionId ? { resume: input.resumeSessionId } : { sessionId: randomUUID() }),
    };

    const prompt = input.resumeSessionId && input.resumeMessage ? input.resumeMessage : input.prompt;
    let query: Query | undefined;
    let last: SDKResultMessage | undefined;
    let lastAssistantText = "";
    let thrown: unknown;

    const producer = (async () => {
      try {
        query = sdk.query({ prompt, options });
        for await (const m of query as AsyncIterable<SDKMessage>) {
          if (m.type === "system" && m.subtype === "init") {
            initSeen = true;
            sessionId = m.session_id;
            emit({ type: "started", sessionId, model: m.model });
            continue;
          }
          if (m.type === "assistant") {
            const content = Array.isArray(m.message?.content) ? m.message.content : [];
            for (const block of content as Array<{ type: string; text?: string }>) {
              if (block.type === "text" && block.text?.trim()) {
                lastAssistantText = block.text;
                emit({ type: "assistant", text: block.text });
              }
            }
            continue;
          }
          if (m.type === "result") {
            last = m;
            emit({ type: "cost", costUsd: m.total_cost_usd ?? 0, inputTokens: usageIn(m), outputTokens: m.usage?.output_tokens ?? 0 });
            continue;
          }
          if (m.type === "system" && (m as { subtype?: string }).subtype === "permission_denied") {
            const pd = m as unknown as { tool_name?: string };
            emit({ type: "progress", message: `permission denied for ${pd.tool_name ?? "tool"}` });
          }
        }
      } catch (e) {
        thrown = e;
      } finally {
        try {
          query?.close();
        } catch {
          /* ignore */
        }
        q.close();
      }
    })();

    try {
      for await (const ev of q) yield ev;
      await producer;
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
    }

    if (!sessionId && !last && thrown) {
      emit({ type: "error", error: errorMessage(thrown) });
    }
    let result = this.mapResult({ last, thrown, sessionId, started, lastAssistantText, pendingApprovalId, aborted: ac.signal.aborted, timedOut: ac.signal.aborted && !input.signal.aborted });
    // Resuming a session this machine never saw: the CLI answers with an error result before any
    // init message. Report it so the executor can fall back instead of counting a failed attempt.
    if (input.resumeSessionId && result.status === "failed" && !initSeen && isSessionNotFoundError(result.error, thrown ? errorMessage(thrown) : undefined, stderrTail)) {
      result = { ...result, sessionId: undefined, sessionNotFound: true };
      yield { type: "progress", message: `session ${input.resumeSessionId} not found on this machine` };
    } else if (result.status === "failed" && result.error) yield { type: "error", error: result.error };
    yield { type: "result", result };
  }

  private mapResult(x: { last?: SDKResultMessage; thrown?: unknown; sessionId?: string; started: number; lastAssistantText: string; pendingApprovalId?: string; aborted: boolean; timedOut: boolean }): RunResult {
    const { last, thrown, sessionId, started, lastAssistantText, pendingApprovalId } = x;
    const durationMs = last?.duration_ms ?? Date.now() - started;
    const base = {
      sessionId,
      costUsd: last?.total_cost_usd ?? 0,
      inputTokens: last ? usageIn(last) : 0,
      outputTokens: last?.usage?.output_tokens ?? 0,
      numTurns: last?.num_turns ?? 0,
      durationMs,
      pendingApprovalId,
    };
    if (!last) {
      const error = x.timedOut ? "run timed out" : x.aborted ? "run aborted" : thrown ? errorMessage(thrown) : "no result from agent";
      return { ...base, status: pendingApprovalId ? "waiting_human" : "failed", text: lastAssistantText, error };
    }
    if (last.subtype === "success") {
      const text = last.result ?? "";
      const structured: AgentOutput | undefined = parseAgentOutput(last.structured_output) ?? extractAgentOutputFromText(text) ?? extractAgentOutputFromText(lastAssistantText);
      const wantsHuman = !!pendingApprovalId || structured?.status === "needs_human";
      if (wantsHuman) return { ...base, status: "waiting_human", text, structured };
      if (last.is_error) return { ...base, status: "failed", text, structured, error: `agent ended with is_error (stop_reason=${last.stop_reason ?? "?"}, terminal=${(last as { terminal_reason?: string }).terminal_reason ?? "?"})` };
      return { ...base, status: "succeeded", text, structured };
    }
    const errs = (last as { errors?: string[] }).errors ?? [];
    const error = `${last.subtype}${errs.length ? `: ${errs.join("; ")}` : ""}`;
    const structured = extractAgentOutputFromText(lastAssistantText);
    if (pendingApprovalId) return { ...base, status: "waiting_human", text: lastAssistantText, structured, error };
    return { ...base, status: "failed", text: lastAssistantText, structured, error };
  }
}

function usageIn(m: SDKResultMessage): number {
  const u = m.usage as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

export function createClaudeSdkRunner(opts: ClaudeSdkRunnerOptions = {}): Runner {
  return new ClaudeSdkRunner(opts);
}
