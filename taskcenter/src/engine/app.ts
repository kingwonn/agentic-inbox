/**
 * createApp: build the AppContext (config, db, repo, bus, policy, budget, logger)
 * and wire every service. The CLI, the daemon and tests all start here.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import type { AppContext, AppServices } from "../core/app.js";
import { Budget } from "../core/budget.js";
import { openDb } from "../core/db.js";
import { Bus } from "../core/events.js";
import { createLogger, type LogLevel, type Logger } from "../core/logger.js";
import { Policy } from "../core/policy.js";
import { Repo } from "../core/repo.js";
import { nowIso } from "../core/time.js";
import { registerSchedules } from "./scheduler.js";
import type { SensorEntry } from "./types.js";
import { getWired, wireServices } from "./wiring.js";

export interface CreateAppOptions {
  configPath?: string;
  cwd?: string;
  logger?: Logger;
  overrides?: Partial<AppServices>;
  /** Replace LLM provider and runner by dry stubs. */
  dry?: boolean;
  /** Tests: skip sibling-module imports entirely. */
  isolated?: boolean;
  /** Tests: database path (":memory:"). */
  dbPath?: string;
  /** Tests: explicit sensors. */
  sensors?: SensorEntry[];
  logLevel?: LogLevel;
  logToStderr?: boolean;
}

export async function createApp(opts: CreateAppOptions = {}): Promise<AppContext> {
  const loaded = loadConfig({ configPath: opts.configPath, cwd: opts.cwd });
  const config = loaded.config;
  if (opts.dry) config.brain.provider = "dry";
  const dataDir = loaded.resolve(config.data_dir);
  for (const d of ["", "logs", "workspaces", "artifacts", "exports"]) mkdirSync(join(dataDir, d), { recursive: true });
  const logger =
    opts.logger ??
    createLogger({
      file: join(dataDir, "logs", "taskcenter.jsonl"),
      level: opts.logLevel ?? ((process.env.TC_LOG_LEVEL as LogLevel) || "info"),
      stderr: opts.logToStderr ?? true,
    });
  const db = openDb(opts.dbPath ?? join(dataDir, "taskcenter.db"));
  const repo = new Repo(db);
  const bus = new Bus(repo);
  const policyPath = loaded.resolve(config.policy_path);
  let policy: Policy;
  if (existsSync(policyPath)) policy = Policy.load(policyPath);
  else {
    logger.warn(`policy file not found at ${policyPath}; using built-in defaults`);
    policy = Policy.default();
  }
  const budget = new Budget(repo, config.brain.daily_budget_usd, config.timezone);
  let closed = false;
  const ctx: AppContext = {
    config,
    loaded,
    repo,
    bus,
    policy,
    logger,
    budget,
    services: {},
    dataDir,
    startedAt: nowIso(),
    async shutdown() {
      if (closed) return;
      closed = true;
      const w = getWired(ctx);
      try {
        w?.scheduler.stop();
        await w?.executor.stop?.();
        await w?.notifier.stop?.();
      } catch (e) {
        logger.warn(`shutdown: ${(e as Error).message}`);
      }
      db.close();
    },
  };
  await wireServices(ctx, { overrides: opts.overrides, dry: opts.dry, isolated: opts.isolated, sensors: opts.sensors });
  registerSchedules(ctx);
  logger.debug(`app created (config ${loaded.configPath ?? "defaults"}, data ${dataDir})`);
  return ctx;
}
