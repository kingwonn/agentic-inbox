/**
 * Codex CLI Runner: `codex exec --json` (OpenAI Codex). Best-effort mapping of
 * its JSONL event stream (thread.started / item.* / turn.completed / turn.failed)
 * into RunEvents. `available()` is false when `codex` is not on PATH.
 *
 * LIMITATIONS: no in-process tool gate (Codex runs its own sandbox; we pass
 * `--sandbox workspace-write` for L3+ and `read-only` below), no taskcenter
 * MCP tools, approvals are not interactive (sensitive actions are blocked by
 * the sandbox rather than routed to the Outbox). Structured output uses
 * `--output-schema` with the AgentOutput schema and `--output-last-message`.
 * Flag names follow Codex CLI 0.4x; adjust via TC_CODEX_ARGS if yours differ.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Logger } from "../core/logger.js";
import { silentLogger } from "../core/logger.js";
import { extractAgentOutputFromText, parseAgentOutput } from "./result.js";
import type { RunEvent, RunInput, Runner, RunResult } from "./types.js";
import { AsyncQueue, agentEnv, errorMessage, truncateOutput } from "./util.js";

export interface CodexRunnerOptions {
  bin?: string;
  logger?: Logger;
}

export function buildCodexArgs(input: RunInput, paths: { schema: string; lastMessage: string }): string[] {
  const args = ["exec", "--json", "-C", input.workspace, "--sandbox", input.level >= 3 ? "workspace-write" : "read-only", "--output-schema", paths.schema, "--output-last-message", paths.lastMessage, "--skip-git-repo-check"];
  if (input.model && !/^(haiku|sonnet|opus|fable)$/.test(input.model)) args.push("-m", input.model);
  if (input.effort) args.push("-c", `model_reasoning_effort="${input.effort === "xhigh" || input.effort === "max" ? "high" : input.effort}"`);
  if (input.resumeSessionId) args.unshift("resume", input.resumeSessionId);
  const extra = process.env.TC_CODEX_ARGS;
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));
  return args;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: { id?: string; type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number; status?: string; changes?: unknown; server?: string; tool?: string; arguments?: unknown; result?: unknown; error?: unknown; message?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string } | string;
  message?: string;
}

export class CodexRunner implements Runner {
  readonly name = "codex";
  private bin: string;
  private logger: Logger;

  constructor(opts: CodexRunnerOptions = {}) {
    this.bin = opts.bin ?? process.env.TC_CODEX_BIN ?? "codex";
    this.logger = opts.logger ?? silentLogger;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
      } catch (e) {
        resolve({ ok: false, reason: errorMessage(e) });
        return;
      }
      child.on("error", (e) => resolve({ ok: false, reason: `${this.bin} not found: ${e.message}` }));
      child.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, reason: `${this.bin} --version exited ${code}` }));
    });
  }

  async *run(input: RunInput): AsyncIterable<RunEvent> {
    const log = input.logger ?? this.logger;
    const started = Date.now();
    const tmp = mkdtempSync(join(tmpdir(), "tc-codex-"));
    const paths = { schema: join(tmp, "schema.json"), lastMessage: join(tmp, "last.md") };
    writeFileSync(paths.schema, JSON.stringify(input.outputSchema));
    const args = buildCodexArgs(input, paths);
    const prompt = `${input.systemPromptAppend}\n\n---\n\n${input.resumeSessionId && input.resumeMessage ? input.resumeMessage : input.prompt}`;
    const q = new AsyncQueue<RunEvent>();

    let child: ChildProcess;
    try {
      child = spawn(this.bin, args, { cwd: input.workspace, env: agentEnv(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      yield { type: "error", error: errorMessage(e) };
      yield { type: "result", result: { status: "failed", text: "", costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0, durationMs: 0, error: errorMessage(e) } };
      return;
    }
    let sessionId: string | undefined = input.resumeSessionId;
    let lastText = "";
    let failure: string | undefined;
    let usage = { input: 0, output: 0 };
    let turns = 0;
    let stderr = "";
    let killedBy: string | undefined;
    const kill = (why: string) => {
      killedBy = why;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 5000).unref();
    };
    const timer = setTimeout(() => kill("timeout"), input.timeoutMs);
    timer.unref?.();
    const onAbort = () => kill("abort");
    if (input.signal.aborted) kill("abort");
    else input.signal.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let ev: CodexEvent;
      try {
        ev = JSON.parse(line) as CodexEvent;
      } catch {
        return;
      }
      const t = ev.type ?? "";
      if (t === "thread.started") {
        sessionId = ev.thread_id ?? sessionId;
        q.push({ type: "started", sessionId, model: input.model });
      } else if (t === "turn.started") {
        turns++;
      } else if (t === "item.started" || t === "item.completed" || t === "item.updated") {
        const it = ev.item ?? {};
        const id = it.id;
        if (it.type === "agent_message" && t === "item.completed" && it.text) {
          lastText = it.text;
          q.push({ type: "assistant", text: it.text });
        } else if (it.type === "command_execution") {
          if (t === "item.started") q.push({ type: "tool_call", tool: "Bash", input: { command: it.command }, toolUseId: id });
          if (t === "item.completed") q.push({ type: "tool_result", tool: "Bash", toolUseId: id, output: truncateOutput(it.aggregated_output ?? ""), isError: (it.exit_code ?? 0) !== 0 });
        } else if (it.type === "file_change" && t === "item.completed") {
          q.push({ type: "tool_call", tool: "Edit", input: { changes: truncateOutput(it.changes, 2000) }, toolUseId: id });
          q.push({ type: "tool_result", tool: "Edit", toolUseId: id, output: it.status ?? "completed" });
        } else if (it.type === "mcp_tool_call") {
          const tool = `mcp__${it.server ?? "mcp"}__${it.tool ?? "tool"}`;
          if (t === "item.started") q.push({ type: "tool_call", tool, input: it.arguments, toolUseId: id });
          if (t === "item.completed") q.push({ type: "tool_result", tool, toolUseId: id, output: truncateOutput(it.result ?? it.error), isError: !!it.error });
        } else if (it.type === "error") {
          q.push({ type: "error", error: String(it.message ?? "codex error") });
        }
      } else if (t === "turn.completed") {
        usage = { input: (ev.usage?.input_tokens ?? 0) + (ev.usage?.cached_input_tokens ?? 0), output: ev.usage?.output_tokens ?? 0 };
        q.push({ type: "cost", costUsd: 0, inputTokens: usage.input, outputTokens: usage.output });
      } else if (t === "turn.failed" || t === "error") {
        failure = typeof ev.error === "string" ? ev.error : ev.error?.message ?? ev.message ?? "codex turn failed";
        q.push({ type: "error", error: failure });
      }
    });
    const exit = new Promise<{ code: number | null; err?: Error }>((resolve) => {
      child.on("error", (err) => resolve({ code: null, err }));
      child.on("close", (code) => resolve({ code }));
    });
    exit.then(() => {
      rl.close();
      q.close();
    });
    try {
      for await (const ev of q) yield ev;
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
    }
    const { code, err } = await exit;
    let finalText = lastText;
    try {
      finalText = readFileSync(paths.lastMessage, "utf8") || lastText;
    } catch {
      /* no file */
    }
    rmSync(tmp, { recursive: true, force: true });
    const structured = extractAgentOutputFromText(finalText) ?? parseAgentOutput(safeJson(finalText));
    const base = { sessionId, costUsd: 0, inputTokens: usage.input, outputTokens: usage.output, numTurns: turns, durationMs: Date.now() - started };
    let result: RunResult;
    if (err) result = { ...base, status: "failed", text: finalText, error: err.message };
    else if (killedBy) result = { ...base, status: "failed", text: finalText, structured, error: `run ${killedBy}` };
    else if (failure || code !== 0) result = { ...base, status: "failed", text: finalText, structured, error: failure ?? `codex exited ${code}: ${stderr.trim().slice(-500)}` };
    else if (structured?.status === "needs_human") result = { ...base, status: "waiting_human", text: finalText, structured };
    else result = { ...base, status: "succeeded", text: finalText, structured };
    log.debug(`codex run finished: ${result.status}`);
    yield { type: "result", result };
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function createCodexRunner(opts: CodexRunnerOptions = {}): Runner {
  return new CodexRunner(opts);
}
