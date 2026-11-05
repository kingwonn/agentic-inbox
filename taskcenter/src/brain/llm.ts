import type { Logger } from "../core/logger.js";

/**
 * Single-shot structured LLM calls (classification, planning, summaries).
 * Implementations: claude-cli (default; uses `claude -p --output-format json`),
 * anthropic-api (direct API with ANTHROPIC_API_KEY), dry (deterministic stub for tests).
 */
export interface LlmRequest {
  model: string; // alias (haiku|sonnet|opus) or full id
  system?: string;
  prompt: string;
  /** When provided, the provider must return JSON matching this schema (draft-07). */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  timeoutMs?: number;
  effort?: "low" | "medium" | "high";
  signal?: AbortSignal;
  logger?: Logger;
  /** Tag for cost attribution (e.g. "classify", "plan", "digest"). */
  purpose?: string;
}

export interface LlmResponse {
  text: string;
  json?: unknown;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  model: string;
  raw?: unknown;
}

export interface LlmProvider {
  readonly name: string;
  available(): Promise<{ ok: boolean; reason?: string }>;
  complete(req: LlmRequest): Promise<LlmResponse>;
}
