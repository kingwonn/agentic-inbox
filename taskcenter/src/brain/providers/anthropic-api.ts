/**
 * LlmProvider using the Anthropic Messages API directly over fetch.
 * Requires ANTHROPIC_API_KEY. Structured output via `output_config.format`
 * (json_schema); falls back to prompt-instructed JSON + extraction if the API
 * rejects the format parameter.
 */
import type { LlmProvider, LlmRequest, LlmResponse } from "../llm.js";
import type { Logger } from "../../core/logger.js";
import { silentLogger } from "../../core/logger.js";
import { extractFirstJson } from "./util.js";

export const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
};

/** USD per million tokens: [input, output, cache_read, cache_write]. */
export const PRICE_TABLE: Record<string, [number, number, number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
  "claude-haiku-4-5": [1, 5, 0.1, 1.25],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-sonnet-4-6": [3, 15, 0.3, 3.75],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
  "claude-fable-5-1": [10, 50, 1, 12.5],
};

export function resolveModelId(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

export interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function estimateCostUsd(model: string, usage: ApiUsage): number {
  const id = resolveModelId(model);
  const key = Object.keys(PRICE_TABLE).find((k) => id.startsWith(k)) ?? (id.includes("haiku") ? "claude-haiku-5-5" : id.includes("opus") ? "claude-opus-5-5" : "claude-sonnet-5-5");
  const [inp, out, cr, cw] = PRICE_TABLE[key];
  return ((usage.input_tokens ?? 0) * inp + (usage.output_tokens ?? 0) * out + (usage.cache_read_input_tokens ?? 0) * cr + (usage.cache_creation_input_tokens ?? 0) * cw) / 1_000_000;
}

export interface AnthropicApiProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  logger?: Logger;
  defaultTimeoutMs?: number;
}

/** Build the request body (exported for tests). */
export function buildMessagesRequest(req: LlmRequest, opts: { useOutputFormat: boolean }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: resolveModelId(req.model),
    max_tokens: req.maxTokens ?? 4096,
    messages: [{ role: "user", content: req.jsonSchema && !opts.useOutputFormat ? `${req.prompt}\n\nRespond with a single JSON object only (no prose) matching this JSON schema:\n${JSON.stringify(req.jsonSchema)}` : req.prompt }],
  };
  if (req.system) body.system = req.system;
  const outputConfig: Record<string, unknown> = {};
  if (req.effort) outputConfig.effort = req.effort;
  if (req.jsonSchema && opts.useOutputFormat) outputConfig.format = { type: "json_schema", schema: req.jsonSchema };
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  return body;
}

export class AnthropicApiProvider implements LlmProvider {
  readonly name = "anthropic-api";
  private apiKey: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private logger: Logger;
  private defaultTimeoutMs: number;
  private outputFormatSupported = true;

  constructor(opts: AnthropicApiProviderOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.baseUrl = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger ?? silentLogger;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.apiKey) return { ok: false, reason: "ANTHROPIC_API_KEY not set" };
    return { ok: true };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.apiKey) throw new Error("anthropic-api provider: ANTHROPIC_API_KEY not set");
    const started = Date.now();
    let useOutputFormat = this.outputFormatSupported && !!req.jsonSchema;
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = buildMessagesRequest(req, { useOutputFormat });
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), req.timeoutMs ?? this.defaultTimeoutMs);
      const onAbort = () => ac.abort();
      req.signal?.addEventListener("abort", onAbort, { once: true });
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
      }
      const text = await res.text();
      if (!res.ok) {
        // Unknown output_config.format → retry once with prompt-instructed JSON.
        if (res.status === 400 && useOutputFormat && /output_config|format/i.test(text)) {
          this.outputFormatSupported = false;
          useOutputFormat = false;
          this.logger.warn("anthropic-api: output_config.format rejected; falling back to prompt JSON", { body: text.slice(0, 200) });
          continue;
        }
        throw new Error(`anthropic-api ${res.status}: ${text.slice(0, 500)}`);
      }
      const data = JSON.parse(text) as { content?: Array<{ type: string; text?: string }>; usage?: ApiUsage; model?: string; stop_reason?: string; parsed_output?: unknown };
      const outText = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      const usage = data.usage ?? {};
      let json: unknown = data.parsed_output;
      if (json === undefined && req.jsonSchema) json = extractFirstJson(outText);
      return {
        text: outText,
        json,
        costUsd: estimateCostUsd(req.model, usage),
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        outputTokens: usage.output_tokens ?? 0,
        durationMs: Date.now() - started,
        model: data.model ?? resolveModelId(req.model),
        raw: data,
      };
    }
    throw new Error("anthropic-api: request failed");
  }
}

export function createAnthropicApiProvider(opts: AnthropicApiProviderOptions = {}): LlmProvider {
  return new AnthropicApiProvider(opts);
}
