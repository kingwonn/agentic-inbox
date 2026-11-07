/**
 * Deterministic Runner for tests and `provider: dry`. Scripted via task.context.dry:
 *   { fail: true }                      → result failed
 *   { needsApproval: "Bash git push origin main" } → calls the gate with that tool call
 *   { status: "partial" | "blocked" | "needs_human" | "done" }
 *   { summary, artifacts, learned, followUps, writeFile: "name.txt" }
 *   { delayMs: 50 }
 *   { sessionMissing: true }            → a resume run reports sessionNotFound (session parked elsewhere)
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentOutput } from "../core/types.js";
import type { RunEvent, RunInput, Runner, RunResult } from "./types.js";

interface DryScript {
  fail?: boolean;
  error?: string;
  needsApproval?: string;
  status?: AgentOutput["status"];
  summary?: string;
  artifacts?: AgentOutput["artifacts"];
  learned?: string[];
  followUps?: string[];
  writeFile?: string;
  delayMs?: number;
  sessionMissing?: boolean;
}

export class DryRunner implements Runner {
  readonly name = "dry";

  async available(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }

  async *run(input: RunInput): AsyncIterable<RunEvent> {
    const started = Date.now();
    const script = ((input.task.context?.dry as DryScript | undefined) ?? {}) as DryScript;
    if (script.sessionMissing && input.resumeSessionId) {
      const error = `No conversation found with session ID: ${input.resumeSessionId}`;
      yield { type: "progress", message: `session ${input.resumeSessionId} not found on this machine` };
      yield { type: "result", result: { ...base("", started, { status: "failed", text: "", error, sessionNotFound: true }), sessionId: undefined, inputTokens: 0, outputTokens: 0, numTurns: 0 } };
      return;
    }
    const sessionId = `dry-${input.run.id}`;
    yield { type: "started", sessionId, model: input.model };
    if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
    yield { type: "assistant", text: `Dry run of "${input.task.title}" at L${input.level}` };

    if (script.fail) {
      yield { type: "error", error: script.error ?? "dry failure" };
      yield { type: "result", result: base(sessionId, started, { status: "failed", text: "", error: script.error ?? "dry failure" }) };
      return;
    }

    // A read-only call that every level allows.
    const readCall = { tool: "Read", input: { file_path: resolve(input.workspace, "README-task.md") }, toolUseId: "dry-1" };
    yield { type: "tool_call", ...readCall };
    const readGate = await input.gate(readCall);
    yield { type: "tool_result", tool: "Read", toolUseId: "dry-1", output: readGate.action === "allow" ? "(contents of README-task.md)" : readGate.reason, isError: readGate.action !== "allow" };

    let pendingApprovalId: string | undefined;
    let status: AgentOutput["status"] = script.status ?? "done";
    const artifacts: AgentOutput["artifacts"] = [...(script.artifacts ?? [])];
    const notes: string[] = [];

    if (script.writeFile) {
      const call = { tool: "Write", input: { file_path: resolve(input.workspace, script.writeFile), content: "hi\n" }, toolUseId: "dry-2" };
      yield { type: "tool_call", ...call };
      const g = await input.gate(call);
      if (g.action === "allow") {
        try {
          writeFileSync(call.input.file_path, "hi\n");
          artifacts.push({ type: "file", title: script.writeFile, path: call.input.file_path });
          yield { type: "tool_result", tool: "Write", toolUseId: "dry-2", output: `wrote ${call.input.file_path}` };
        } catch (e) {
          yield { type: "tool_result", tool: "Write", toolUseId: "dry-2", output: String(e), isError: true };
        }
      } else {
        yield { type: "tool_result", tool: "Write", toolUseId: "dry-2", output: g.reason, isError: true };
        notes.push(g.reason);
        if (g.pendingApprovalId) pendingApprovalId = g.pendingApprovalId;
        status = g.pendingApprovalId ? "needs_human" : "blocked";
      }
    }

    if (script.needsApproval) {
      const [tool, ...rest] = script.needsApproval.split(" ");
      const callInput = tool === "Bash" ? { command: rest.join(" ") } : { arg: rest.join(" ") };
      const call = { tool, input: callInput, toolUseId: "dry-3" };
      yield { type: "tool_call", ...call };
      const g = await input.gate(call);
      if (g.action === "allow") {
        yield { type: "tool_result", tool, toolUseId: "dry-3", output: `(dry) executed ${script.needsApproval}` };
        notes.push(`executed ${script.needsApproval}`);
      } else {
        yield { type: "tool_result", tool, toolUseId: "dry-3", output: g.reason, isError: true };
        notes.push(g.reason);
        if (g.pendingApprovalId) {
          pendingApprovalId = g.pendingApprovalId;
          status = "needs_human";
        } else if (status === "done") status = "blocked";
      }
    }

    const structured: AgentOutput = {
      summary: script.summary ?? `Dry run finished with status ${status}${notes.length ? `: ${notes.join(" | ")}` : ""}`,
      status,
      artifacts,
      verification: { passed: status === "done", details: status === "done" ? "dry runner: no real checks executed" : notes.join(" | ") || "not verified" },
      follow_ups: script.followUps ?? [],
      needs_human: status === "needs_human" ? { question: notes[0] ?? "Approval pending" } : null,
      ...(script.learned?.length ? { learned: script.learned } : {}),
    };
    yield { type: "cost", costUsd: 0, inputTokens: 10, outputTokens: 5 };
    yield {
      type: "result",
      result: base(sessionId, started, {
        status: pendingApprovalId || status === "needs_human" ? "waiting_human" : "succeeded",
        text: JSON.stringify(structured),
        structured,
        pendingApprovalId,
      }),
    };
  }
}

function base(sessionId: string, started: number, partial: Partial<RunResult> & Pick<RunResult, "status" | "text">): RunResult {
  return { sessionId, costUsd: 0, inputTokens: 10, outputTokens: 5, numTurns: 2, durationMs: Date.now() - started, ...partial };
}

export function createDryRunner(): Runner {
  return new DryRunner();
}
