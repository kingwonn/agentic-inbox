/**
 * LlmProvider backed by the headless `claude -p` CLI (uses the user's Claude
 * login; no API key needed). One cheap, deterministic, tool-less turn per call.
 */
import { spawn } from "node:child_process";
import type { LlmProvider, LlmRequest, LlmResponse } from "../llm.js";
import type { Logger } from "../../core/logger.js";
import { silentLogger } from "../../core/logger.js";
import { cleanClaudeEnv, extractFirstJson } from "./util.js";

export interface ClaudeCliProviderOptions {
  bin?: string; // default "claude"
  defaultTimeoutMs?: number;
  logger?: Logger;
}

/** Build the argv for a single-shot structured call (exported for tests). */
export function buildClaudeCliArgs(req: LlmRequest): string[] {
  const args = [
    "-p",
    "--model",
    req.model,
    "--output-format",
    "json",
    "--max-turns",
    "1",
    "--tools",
    "",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
  ];
  if (req.effort) args.push("--effort", req.effort);
  if (req.system) args.push("--system-prompt", req.system);
  if (req.jsonSchema) args.push("--json-schema", JSON.stringify(req.jsonSchema));
  return args;
}

interface CliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  errors?: string[];
  session_id?: string;
  modelUsage?: Record<string, unknown>;
}

export class ClaudeCliProvider implements LlmProvider {
  readonly name = "claude-cli";
  private bin: string;
  private defaultTimeoutMs: number;
  private logger: Logger;

  constructor(opts: ClaudeCliProviderOptions = {}) {
    this.bin = opts.bin ?? "claude";
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
    this.logger = opts.logger ?? silentLogger;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    return new Promise((resolve) => {
      let out = "";
      let child;
      try {
        child = spawn(this.bin, ["--version"], { env: cleanClaudeEnv(), stdio: ["ignore", "pipe", "ignore"] });
      } catch (e) {
        resolve({ ok: false, reason: `cannot spawn ${this.bin}: ${(e as Error).message}` });
        return;
      }
      child.stdout.on("data", (d) => (out += String(d)));
      child.on("error", (e) => resolve({ ok: false, reason: `${this.bin} not found: ${e.message}` }));
      child.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, reason: `${this.bin} --version exited ${code}: ${out.trim()}` }));
    });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const log = req.logger ?? this.logger;
    const started = Date.now();
    const args = buildClaudeCliArgs(req);
    // --json-schema enforces the shape; the trailing hint helps when the CLI falls back to text.
    const prompt = req.jsonSchema ? `${req.prompt}\n\nRespond with a single JSON object matching the required schema.` : req.prompt;
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;

    const { stdout, stderr, code, signal } = await runProcess(this.bin, args, prompt, { timeoutMs, signal: req.signal, env: cleanClaudeEnv({ DISABLE_TELEMETRY: "1" }) });
    const durationMs = Date.now() - started;
    if (signal === "timeout") throw new Error(`claude -p timed out after ${timeoutMs}ms (purpose=${req.purpose ?? "?"})`);
    if (signal === "aborted") throw new Error(`claude -p aborted (purpose=${req.purpose ?? "?"})`);

    let parsed: CliResult | undefined;
    try {
      parsed = JSON.parse(stdout.trim()) as CliResult;
    } catch {
      // Some CLI versions print extra lines; find the last JSON object line.
      const lines = stdout.trim().split("\n").reverse();
      for (const line of lines) {
        try {
          parsed = JSON.parse(line) as CliResult;
          break;
        } catch {
          /* keep looking */
        }
      }
    }
    if (!parsed) {
      throw new Error(`claude -p produced no JSON (exit ${code}): ${(stderr || stdout).slice(0, 500)}`);
    }
    if (parsed.is_error && parsed.subtype !== "success") {
      throw new Error(`claude -p error ${parsed.subtype ?? ""}: ${(parsed.errors ?? []).join("; ") || parsed.result || stderr.slice(0, 300)}`);
    }
    const text = typeof parsed.result === "string" ? parsed.result : "";
    let json: unknown = parsed.structured_output;
    if (json === undefined && req.jsonSchema) json = extractFirstJson(text);
    const usage = parsed.usage ?? {};
    const res: LlmResponse = {
      text,
      json,
      costUsd: Number(parsed.total_cost_usd ?? 0),
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
      durationMs,
      model: req.model,
      raw: parsed,
    };
    log.debug(`claude-cli ${req.purpose ?? "complete"} done`, { costUsd: res.costUsd, durationMs, inputTokens: res.inputTokens, outputTokens: res.outputTokens });
    return res;
  }
}

export function createClaudeCliProvider(opts: ClaudeCliProviderOptions = {}): LlmProvider {
  return new ClaudeCliProvider(opts);
}

interface ProcOut {
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: "timeout" | "aborted";
}

function runProcess(bin: string, args: string[], stdin: string, opts: { timeoutMs: number; signal?: AbortSignal; env: Record<string, string> }): Promise<ProcOut> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = "";
    let stderr = "";
    let ended: ProcOut["signal"];
    const kill = (why: ProcOut["signal"]) => {
      ended = why;
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
      }, 3000).unref();
    };
    const timer = setTimeout(() => kill("timeout"), opts.timeoutMs);
    const onAbort = () => kill("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code, signal: ended });
    });
    child.stdin.on("error", () => {
      /* EPIPE when the CLI exits early */
    });
    child.stdin.end(stdin);
  });
}
