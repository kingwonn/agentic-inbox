/**
 * Fallback Runner: spawn `claude -p --output-format stream-json --verbose` and
 * parse NDJSON into RunEvents.
 *
 * LIMITATION: this runner cannot gate tool calls in-process. It runs with
 * `--permission-mode default --permission-prompts none`, so any tool that is
 * not pre-allowed is denied automatically. Sensitive Bash commands (git push,
 * rm -rf, sudo, publishing, …) are therefore simply unavailable here: we never
 * allow bare `Bash`; instead a conservative set of command prefixes is
 * allowed and known-dangerous prefixes are explicitly disallowed. In-process
 * (sdk-type) MCP servers such as the taskcenter tools cannot be attached to a
 * child process; only stdio/http/sse server configs are forwarded.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Logger } from "../core/logger.js";
import { silentLogger } from "../core/logger.js";
import { extractAgentOutputFromText, parseAgentOutput } from "./result.js";
import type { RunEvent, RunInput, Runner, RunResult } from "./types.js";
import { AsyncQueue, agentEnv, errorMessage, isSessionNotFoundError, truncateOutput } from "./util.js";

export interface ClaudeCliRunnerOptions {
  bin?: string;
  logger?: Logger;
}

/** Bash command prefixes that are safe enough to pre-allow without a gate. */
export const CLI_SAFE_BASH = [
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(wc *)",
  "Bash(find *)",
  "Bash(grep *)",
  "Bash(rg *)",
  "Bash(pwd)",
  "Bash(echo *)",
  "Bash(mkdir *)",
  "Bash(touch *)",
  "Bash(cp *)",
  "Bash(mv *)",
  "Bash(diff *)",
  "Bash(git status*)",
  "Bash(git diff*)",
  "Bash(git log*)",
  "Bash(git show*)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git checkout -b tc/*)",
  "Bash(git switch -c tc/*)",
  "Bash(git branch --show-current)",
  "Bash(npm test*)",
  "Bash(npm run *)",
  "Bash(npx vitest*)",
  "Bash(npx tsc*)",
  "Bash(npx eslint*)",
  "Bash(node *)",
  "Bash(python3 *)",
  "Bash(pytest*)",
  "Bash(cargo test*)",
  "Bash(go test*)",
  "Bash(make test*)",
];

/** Always denied at this runner (no human can approve inline). */
export const CLI_DENY_BASH = [
  "Bash(git push*)",
  "Bash(git reset --hard*)",
  "Bash(git branch -D*)",
  "Bash(git branch -d*)",
  "Bash(gh pr create*)",
  "Bash(gh pr merge*)",
  "Bash(gh pr close*)",
  "Bash(gh issue create*)",
  "Bash(gh release*)",
  "Bash(rm -rf*)",
  "Bash(rm -fr*)",
  "Bash(rm -r*)",
  "Bash(sudo*)",
  "Bash(npm publish*)",
  "Bash(curl*)",
  "Bash(wget*)",
  "Bash(mail*)",
  "Bash(sendmail*)",
  "Bash(docker rm*)",
  "Bash(docker rmi*)",
  "Bash(kubectl delete*)",
  "Bash(kubectl apply*)",
  "Bash(terraform apply*)",
  "Bash(terraform destroy*)",
  "Bash(wrangler deploy*)",
  "Bash(wrangler publish*)",
  "Bash(mkfs*)",
  "Bash(dd *)",
  "Bash(shutdown*)",
  "Bash(reboot*)",
];

export function buildCliRunnerArgs(input: RunInput): { args: string[]; allowed: string[]; disallowed: string[] } {
  const allowed = input.allowedTools.flatMap((t) => (t === "Bash" ? CLI_SAFE_BASH : [t]));
  const disallowed = [...new Set([...input.disallowedTools, ...(input.allowedTools.includes("Bash") ? CLI_DENY_BASH : [])])];
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    input.model,
    "--max-turns",
    String(input.maxTurns),
    "--max-budget-usd",
    String(input.budgetUsd),
    "--permission-mode",
    "default",
    "--permission-prompts",
    "none",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--append-system-prompt",
    input.systemPromptAppend,
    "--json-schema",
    JSON.stringify(input.outputSchema),
  ];
  if (input.effort) args.push("--effort", input.effort);
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  if (disallowed.length) args.push("--disallowedTools", disallowed.join(","));
  const external = Object.fromEntries(Object.entries(input.mcpServers ?? {}).filter(([, v]) => v && typeof v === "object" && (v as { type?: string }).type !== "sdk" && !("instance" in (v as object))));
  if (Object.keys(external).length) args.push("--mcp-config", JSON.stringify({ mcpServers: external }));
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  else args.push("--session-id", randomUUID());
  return { args, allowed, disallowed };
}

interface StreamMsg {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: { content?: Array<Record<string, unknown>> };
  result?: string;
  structured_output?: unknown;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  num_turns?: number;
  duration_ms?: number;
  errors?: string[];
  stop_reason?: string | null;
}

export class ClaudeCliRunner implements Runner {
  readonly name = "claude-cli";
  private bin: string;
  private logger: Logger;

  constructor(opts: ClaudeCliRunnerOptions = {}) {
    this.bin = opts.bin ?? process.env.TC_CLAUDE_BIN ?? "claude";
    this.logger = opts.logger ?? silentLogger;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.bin, ["--version"], { env: agentEnv(), stdio: ["ignore", "pipe", "ignore"] });
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
    const q = new AsyncQueue<RunEvent>();
    const started = Date.now();
    const { args, allowed, disallowed } = buildCliRunnerArgs(input);
    log.debug(`claude-cli runner: allowed=${allowed.length} disallowed=${disallowed.length}`);
    const prompt = input.resumeSessionId && input.resumeMessage ? input.resumeMessage : input.prompt;

    let child: ChildProcess;
    try {
      child = spawn(this.bin, args, { cwd: input.workspace, env: agentEnv(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      yield { type: "error", error: errorMessage(e) };
      yield { type: "result", result: { status: "failed", text: "", costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0, durationMs: 0, error: errorMessage(e) } };
      return;
    }

    let sessionId: string | undefined = input.resumeSessionId;
    let initSeen = false;
    let last: StreamMsg | undefined;
    let lastAssistantText = "";
    let stderr = "";
    let killedBy: "timeout" | "abort" | undefined;
    const kill = (why: "timeout" | "abort") => {
      killedBy = why;
      try {
        child.kill("SIGINT");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 10_000).unref();
    };
    const timer = setTimeout(() => kill("timeout"), input.timeoutMs);
    timer.unref?.();
    const onAbort = () => kill("abort");
    if (input.signal.aborted) kill("abort");
    else input.signal.addEventListener("abort", onAbort, { once: true });

    child.stderr?.on("data", (d) => {
      const s = String(d);
      stderr += s;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
      log.debug(`[claude stderr] ${s.trimEnd()}`);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let m: StreamMsg;
      try {
        m = JSON.parse(line) as StreamMsg;
      } catch {
        return;
      }
      if (m.type === "system" && m.subtype === "init") {
        initSeen = true;
        sessionId = m.session_id;
        q.push({ type: "started", sessionId, model: m.model });
      } else if (m.type === "assistant") {
        for (const block of m.message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            lastAssistantText = block.text;
            q.push({ type: "assistant", text: block.text });
          } else if (block.type === "tool_use" && block.name !== "StructuredOutput") {
            q.push({ type: "tool_call", tool: String(block.name), input: truncateOutput(block.input, 8000), toolUseId: typeof block.id === "string" ? block.id : undefined });
          }
        }
      } else if (m.type === "user") {
        for (const block of m.message?.content ?? []) {
          if (block.type === "tool_result") {
            q.push({ type: "tool_result", tool: "", toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined, output: truncateOutput(block.content), isError: !!block.is_error });
          }
        }
      } else if (m.type === "result") {
        last = m;
        q.push({ type: "cost", costUsd: m.total_cost_usd ?? 0, inputTokens: usageIn(m), outputTokens: m.usage?.output_tokens ?? 0 });
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
    const durationMs = last?.duration_ms ?? Date.now() - started;
    const base = { sessionId, costUsd: last?.total_cost_usd ?? 0, inputTokens: last ? usageIn(last) : 0, outputTokens: last?.usage?.output_tokens ?? 0, numTurns: last?.num_turns ?? 0, durationMs };
    let result: RunResult;
    if (!last) {
      const error = err ? err.message : killedBy === "timeout" ? "run timed out" : killedBy === "abort" ? "run aborted" : `claude exited ${code}: ${stderr.trim().slice(-500)}`;
      result = { ...base, status: "failed", text: lastAssistantText, error };
    } else if (last.subtype === "success") {
      const text = last.result ?? "";
      const structured = parseAgentOutput(last.structured_output) ?? extractAgentOutputFromText(text) ?? extractAgentOutputFromText(lastAssistantText);
      if (structured?.status === "needs_human") result = { ...base, status: "waiting_human", text, structured };
      else if (last.is_error) result = { ...base, status: "failed", text, structured, error: `agent ended with is_error (stop_reason=${last.stop_reason ?? "?"})` };
      else result = { ...base, status: "succeeded", text, structured };
    } else {
      const error = `${last.subtype}${last.errors?.length ? `: ${last.errors.join("; ")}` : ""}`;
      result = { ...base, status: "failed", text: lastAssistantText, structured: extractAgentOutputFromText(lastAssistantText), error };
    }
    // `--resume <id>` for a session this machine never saw: error result, no init, exit 1.
    if (input.resumeSessionId && result.status === "failed" && !initSeen && isSessionNotFoundError(result.error, stderr)) {
      result = { ...result, sessionId: undefined, sessionNotFound: true };
      yield { type: "progress", message: `session ${input.resumeSessionId} not found on this machine` };
    } else if (result.status === "failed" && result.error) yield { type: "error", error: result.error };
    yield { type: "result", result };
  }
}

function usageIn(m: StreamMsg): number {
  const u = m.usage;
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

export function createClaudeCliRunner(opts: ClaudeCliRunnerOptions = {}): Runner {
  return new ClaudeCliRunner(opts);
}
