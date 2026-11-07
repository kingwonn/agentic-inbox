import type { Config } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import type { LlmProvider } from "../llm.js";
import { createAnthropicApiProvider } from "./anthropic-api.js";
import { createClaudeCliProvider } from "./claude-cli.js";
import { createDryLlmProvider } from "./dry.js";

export { ClaudeCliProvider, createClaudeCliProvider, buildClaudeCliArgs } from "./claude-cli.js";
export { AnthropicApiProvider, createAnthropicApiProvider, MODEL_ALIASES, PRICE_TABLE, estimateCostUsd, resolveModelId } from "./anthropic-api.js";
export { DryLlmProvider, createDryLlmProvider, dryTriageFor } from "./dry.js";

/**
 * Pick the single-shot LLM provider from config.brain.provider:
 *  - claude-sdk | claude-cli → ClaudeCliProvider (headless `claude -p`, user login)
 *  - anthropic-api → AnthropicApiProvider (ANTHROPIC_API_KEY)
 *  - dry → DryLlmProvider
 * TC_LLM_PROVIDER env overrides the config value (handy for tests).
 */
export function createLlmProvider(config: Config, logger: Logger): LlmProvider {
  const name = process.env.TC_LLM_PROVIDER || config.brain.provider;
  const log = logger.child("llm");
  switch (name) {
    case "dry":
      return createDryLlmProvider();
    case "anthropic-api":
      return createAnthropicApiProvider({ logger: log, defaultTimeoutMs: Math.min(config.brain.timeout_seconds * 1000, 300_000) });
    case "claude-cli":
    case "claude-sdk":
    default:
      return createClaudeCliProvider({ logger: log, defaultTimeoutMs: Math.min(config.brain.timeout_seconds * 1000, 300_000) });
  }
}
