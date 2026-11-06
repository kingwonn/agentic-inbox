import type { Config } from "../config/schema.js";
import type { Logger } from "../core/logger.js";
import { ClaudeCliRunner } from "./claude-cli.js";
import { ClaudeSdkRunner } from "./claude-sdk.js";
import { CodexRunner } from "./codex.js";
import { DryRunner } from "./dry.js";
import type { Runner } from "./types.js";

export const RUNNER_NAMES = ["claude-sdk", "claude-cli", "codex", "dry"] as const;
export type RunnerName = (typeof RUNNER_NAMES)[number];

export function createRunner(name: string, deps: { config: Config; logger: Logger }): Runner {
  const log = deps.logger.child(`runner:${name}`);
  switch (name) {
    case "claude-sdk":
      return new ClaudeSdkRunner({ logger: log });
    case "claude-cli":
      return new ClaudeCliRunner({ logger: log });
    case "codex":
      return new CodexRunner({ logger: log });
    case "dry":
      return new DryRunner();
    default:
      throw new Error(`unknown runner: ${name}`);
  }
}

/** Map config.brain.provider to the default runner name. */
export function defaultRunnerName(config: Config): RunnerName {
  switch (config.brain.provider) {
    case "claude-cli":
      return "claude-cli";
    case "dry":
      return "dry";
    case "anthropic-api": // no agent backend for the raw API: use the SDK (user login or ANTHROPIC_API_KEY)
    case "claude-sdk":
    default:
      return "claude-sdk";
  }
}

const FALLBACK_CHAIN: RunnerName[] = ["claude-sdk", "claude-cli", "dry"];

/**
 * Pick a runner: `override` (task.runner / CLI flag) wins, otherwise the
 * config default. If the chosen runner is unavailable, fall back along
 * claude-sdk → claude-cli → dry with a warning.
 */
export async function selectRunner(config: Config, logger: Logger, override?: string | null): Promise<Runner> {
  const wanted = (override && override.trim()) || defaultRunnerName(config);
  const chain = [wanted, ...FALLBACK_CHAIN.filter((n) => n !== wanted)];
  if (wanted === "dry") return createRunner("dry", { config, logger });
  for (const name of chain) {
    let runner: Runner;
    try {
      runner = createRunner(name, { config, logger });
    } catch (e) {
      logger.warn(`runner ${name} cannot be created: ${(e as Error).message}`);
      continue;
    }
    const a = await runner.available();
    if (a.ok) {
      if (name !== wanted) logger.warn(`runner ${wanted} unavailable; falling back to ${name}`);
      return runner;
    }
    logger.warn(`runner ${name} unavailable: ${a.reason ?? "unknown"}`);
  }
  logger.warn("no runner available; using dry runner");
  return createRunner("dry", { config, logger });
}
