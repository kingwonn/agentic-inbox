/**
 * wireServices: the ONLY engine file that imports the sibling modules
 * (sensors/registry, brain/*, runners/*, hitl/*, server/*). Everything is loaded
 * lazily; a module that is missing or fails to import is replaced by the engine's
 * own fallback so `tc --dry`, `tc doctor` and tests keep working.
 *
 * Names here follow docs/CONTRACTS.md exactly.
 */
import type { AppContext, AppServices, NotifierLike } from "../core/app.js";
import { availableCapabilities } from "../config/load.js";
import type { Logger } from "../core/logger.js";
import type { LlmProvider } from "../brain/llm.js";
import type { ApprovalService, InboundHandler } from "../hitl/types.js";
import { createConsoleNotifier, createDryLlm, createDryRunner, createMemoryApprovalService } from "./dry.js";
import { createDigestService, createContextRefresh, type ContextRefreshService, type DigestService } from "./digest.js";
import { createExecutor, type ExecutorService } from "./executor.js";
import {
  FALLBACK_OUTPUT_SCHEMA,
  createFallbackGate,
  fallbackBuildDigest,
  fallbackBuildPrompt,
  fallbackExtractAgentOutputFromText,
  fallbackLoadContext,
  fallbackParseAgentOutput,
  fallbackPlan,
  fallbackPrepareWorkspace,
  fallbackRecordLearned,
  fallbackRefreshContext,
  fallbackTriage,
} from "./fallbacks.js";
import { createInboxService } from "./inbox.js";
import { runMaintenance } from "./maintenance.js";
import { createPatrol, type PatrolService } from "./patrol.js";
import { createPlanner, type PlannerService } from "./plan.js";
import { createScheduler, type SchedulerService } from "./scheduler.js";
import { collectStatus, statusLine } from "./status.js";
import { createTriage, type TriageService } from "./triage.js";
import type { BuildPromptFn, ExecutorDeps, GateFactory, InboxService, LoadContextFn, PlanFn, PrepareWorkspaceFn, RecordLearnedFn, SelectRunnerFn, SensorEntry, TriageFn } from "./types.js";
import { errMsg } from "./util.js";

export type ModuleState = "ok" | "fallback" | "skipped" | `error: ${string}`;

export interface ServerLike {
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

export interface Wired {
  dry: boolean;
  isolated: boolean;
  modules: Record<string, ModuleState>;
  sensors: SensorEntry[];
  llm: LlmProvider;
  notifier: NotifierLike;
  approvals: ApprovalService & { expireDue?(now?: Date): unknown[] };
  patrol: PatrolService;
  triage: TriageService;
  planner: PlannerService;
  inbox: InboxService;
  executor: ExecutorService;
  digest: DigestService;
  contextRefresh: ContextRefreshService;
  scheduler: SchedulerService;
  createServer?: (ctx: AppContext) => ServerLike;
  createInboundHandler: () => InboundHandler;
  seedDemo?: () => unknown;
}

export interface WireDeps {
  overrides?: Partial<AppServices>;
  /** Replace LLM provider and runner with dry stubs (also set by config.brain.provider = "dry"). */
  dry?: boolean;
  /** Skip every sibling-module import (tests): fallbacks + dry stubs only. */
  isolated?: boolean;
  /** Explicit sensor list (tests / cloud mode). */
  sensors?: SensorEntry[];
}

const registry = new WeakMap<AppContext, Wired>();

export function getWired(ctx: AppContext): Wired | undefined {
  return registry.get(ctx);
}

async function tryImport<T>(name: string, load: () => Promise<T>, logger: Logger, modules: Record<string, ModuleState>, isolated: boolean): Promise<T | undefined> {
  if (isolated) {
    modules[name] = "skipped";
    return undefined;
  }
  try {
    const m = await load();
    modules[name] = "ok";
    return m;
  } catch (e) {
    modules[name] = `error: ${errMsg(e)}`;
    logger.warn(`module ${name} unavailable, using fallback: ${errMsg(e)}`);
    return undefined;
  }
}

/** Import every sibling module once and report which ones load (for `tc doctor`). */
export async function probeModules(logger: Logger): Promise<Record<string, ModuleState>> {
  const modules: Record<string, ModuleState> = {};
  await Promise.all([
    tryImport("sensors/registry", () => import("../sensors/registry.js"), logger, modules, false),
    tryImport("brain/providers", () => import("../brain/providers/index.js"), logger, modules, false),
    tryImport("brain/context", () => import("../brain/context.js"), logger, modules, false),
    tryImport("brain/classifier", () => import("../brain/classifier.js"), logger, modules, false),
    tryImport("brain/planner", () => import("../brain/planner.js"), logger, modules, false),
    tryImport("brain/prompts/execute", () => import("../brain/prompts/execute.js"), logger, modules, false),
    tryImport("brain/memory", () => import("../brain/memory.js"), logger, modules, false),
    tryImport("brain/digest", () => import("../brain/digest.js"), logger, modules, false),
    tryImport("runners/registry", () => import("../runners/registry.js"), logger, modules, false),
    tryImport("runners/gate", () => import("../runners/gate.js"), logger, modules, false),
    tryImport("runners/workspace", () => import("../runners/workspace.js"), logger, modules, false),
    tryImport("runners/result", () => import("../runners/result.js"), logger, modules, false),
    tryImport("runners/taskcenter-tools", () => import("../runners/taskcenter-tools.js"), logger, modules, false),
    tryImport("hitl/approvals", () => import("../hitl/approvals.js"), logger, modules, false),
    tryImport("hitl/notifier", () => import("../hitl/notifier.js"), logger, modules, false),
    tryImport("server/app", () => import("../server/app.js"), logger, modules, false),
    tryImport("server/seed", () => import("../server/seed.js"), logger, modules, false),
  ]);
  return modules;
}

export async function wireServices(ctx: AppContext, deps: WireDeps = {}): Promise<Wired> {
  const { config, loaded, repo, bus, logger: baseLogger } = ctx;
  const logger = baseLogger.child("wiring");
  const overrides = deps.overrides ?? {};
  const isolated = deps.isolated ?? false;
  const dry = deps.dry ?? config.brain.provider === "dry";
  const modules: Record<string, ModuleState> = {};
  const imp = <T>(name: string, load: () => Promise<T>) => tryImport(name, load, logger, modules, isolated);

  // ── sibling modules (lazy) ────────────────────────────────────────
  const [sensorsMod, providersMod, contextMod, classifierMod, plannerMod, promptsMod, memoryMod, digestMod, runnersMod, gateMod, wsMod, resultMod, mcpMod, approvalsMod, notifierMod, serverMod, seedMod] =
    await Promise.all([
      imp("sensors/registry", () => import("../sensors/registry.js")),
      imp("brain/providers", () => import("../brain/providers/index.js")),
      imp("brain/context", () => import("../brain/context.js")),
      imp("brain/classifier", () => import("../brain/classifier.js")),
      imp("brain/planner", () => import("../brain/planner.js")),
      imp("brain/prompts/execute", () => import("../brain/prompts/execute.js")),
      imp("brain/memory", () => import("../brain/memory.js")),
      imp("brain/digest", () => import("../brain/digest.js")),
      imp("runners/registry", () => import("../runners/registry.js")),
      imp("runners/gate", () => import("../runners/gate.js")),
      imp("runners/workspace", () => import("../runners/workspace.js")),
      imp("runners/result", () => import("../runners/result.js")),
      imp("runners/taskcenter-tools", () => import("../runners/taskcenter-tools.js")),
      imp("hitl/approvals", () => import("../hitl/approvals.js")),
      imp("hitl/notifier", () => import("../hitl/notifier.js")),
      imp("server/app", () => import("../server/app.js")),
      imp("server/seed", () => import("../server/seed.js")),
    ]);
  const mark = (name: string) => {
    if (modules[name] !== "ok") modules[name] = modules[name]?.startsWith("error") ? modules[name] : "fallback";
  };

  // ── notifier + approvals (hitl) ───────────────────────────────────
  const publicUrl = config.server.public_url || undefined;
  let notifier: NotifierLike;
  let notifierIsFallback = false;
  if (overrides.notifier) notifier = overrides.notifier;
  else if (notifierMod) notifier = notifierMod.createNotifier({ config, repo, bus, logger: baseLogger, rootDir: loaded.rootDir, dataDir: ctx.dataDir, publicUrl });
  else {
    notifier = createConsoleNotifier(baseLogger, repo, { print: !isolated });
    notifierIsFallback = true;
    mark("hitl/notifier");
  }
  let approvals: Wired["approvals"];
  if (overrides.approvals) approvals = overrides.approvals;
  else if (approvalsMod) approvals = approvalsMod.createApprovalService({ repo, bus, notifier, config, logger: baseLogger, publicUrl });
  else {
    approvals = createMemoryApprovalService(repo, bus, { expireHours: config.approval.expire_hours, notifier, logger: baseLogger });
    mark("hitl/approvals");
  }

  // ── brain ─────────────────────────────────────────────────────────
  let llm: LlmProvider;
  if (overrides.llm) llm = overrides.llm;
  else if (providersMod) llm = providersMod.createLlmProvider(dry ? { ...config, brain: { ...config.brain, provider: "dry" } } : config, baseLogger);
  else {
    llm = createDryLlm();
    mark("brain/providers");
  }
  const loadContext: LoadContextFn = contextMod ? () => contextMod.loadContext(loaded, repo) : () => fallbackLoadContext(loaded, repo);
  if (!contextMod) mark("brain/context");
  const triageFn: TriageFn = classifierMod ? classifierMod.triageSignals : fallbackTriage;
  if (!classifierMod) mark("brain/classifier");
  const planFn: PlanFn = plannerMod ? plannerMod.planTask : fallbackPlan;
  if (!plannerMod) mark("brain/planner");
  const buildPrompt: BuildPromptFn = promptsMod ? promptsMod.buildExecutionPrompt : fallbackBuildPrompt;
  if (!promptsMod) mark("brain/prompts/execute");
  const recordLearned: RecordLearnedFn = memoryMod ? (l, s) => memoryMod.recordLearned(repo, l, s, bus) : (l, s) => fallbackRecordLearned(repo, l, s, bus);
  if (!memoryMod) mark("brain/memory");
  const refreshContext = memoryMod ? memoryMod.refreshContext : fallbackRefreshContext;
  const buildDigest = digestMod ? digestMod.buildDigest : fallbackBuildDigest;
  if (!digestMod) mark("brain/digest");

  // ── runners ───────────────────────────────────────────────────────
  const dryRunner = createDryRunner();
  let selectRunner: SelectRunnerFn;
  if (runnersMod) {
    const runnerConfig = dry ? { ...config, brain: { ...config.brain, provider: "dry" as const } } : config;
    selectRunner = (override) => runnersMod.selectRunner(runnerConfig, baseLogger, dry ? "dry" : override);
  } else {
    selectRunner = async () => dryRunner;
    mark("runners/registry");
  }
  const gateFactory: GateFactory = gateMod ? gateMod.createToolGate : createFallbackGate;
  if (!gateMod) mark("runners/gate");
  const prepareWorkspace: PrepareWorkspaceFn = wsMod
    ? (task) => wsMod.prepareWorkspace(task, { config, rootDir: loaded.rootDir, logger: baseLogger })
    : (task) => fallbackPrepareWorkspace(task, { config, rootDir: loaded.rootDir, logger: baseLogger });
  if (!wsMod) mark("runners/workspace");
  const outputSchema = resultMod?.AGENT_OUTPUT_JSON_SCHEMA ?? FALLBACK_OUTPUT_SCHEMA;
  const parseAgentOutput = resultMod?.parseAgentOutput ?? fallbackParseAgentOutput;
  const extractAgentOutputFromText = resultMod?.extractAgentOutputFromText ?? fallbackExtractAgentOutputFromText;
  if (!resultMod) mark("runners/result");
  const mcpServers: ExecutorDeps["mcpServers"] = mcpMod
    ? ({ task, run, workspace }) => {
        const { name, server } = mcpMod.createTaskCenterMcp({ repo, bus, task, run, approvals, logger: baseLogger, workspace, expiresHours: config.approval.expire_hours });
        return { [name]: server };
      }
    : undefined;
  if (!mcpMod) mark("runners/taskcenter-tools");

  // ── sensors ───────────────────────────────────────────────────────
  let sensors: SensorEntry[] = deps.sensors ?? [];
  let makeSensorContext: ((entry: SensorEntry) => import("../sensors/types.js").SensorContext) | undefined;
  if (!deps.sensors && sensorsMod) {
    sensors = sensorsMod.createSensors(config);
    makeSensorContext = (entry) => sensorsMod.makeSensorContext(entry, { repo, logger: baseLogger, loaded });
  } else if (!sensorsMod) mark("sensors/registry");

  // ── engine services ───────────────────────────────────────────────
  const caps = availableCapabilities(config);
  const inbox: InboxService = (overrides.inbox && overrides.capture ? { ...overrides.inbox, capture: overrides.capture } : undefined) ?? createInboxService(ctx);
  const patrol = createPatrol(ctx, sensors, { makeSensorContext });
  const triage = createTriage(ctx, { llm, triageSignals: triageFn, loadContext, availableCapabilities: caps, recordLearned, inbox });
  const planner = createPlanner(ctx, { llm, planTask: planFn, loadContext });
  const executor = createExecutor(ctx, {
    selectRunner,
    gateFactory,
    prepareWorkspace,
    buildExecutionPrompt: buildPrompt,
    loadContext,
    outputSchema,
    parseAgentOutput,
    extractAgentOutputFromText,
    recordLearned,
    approvals,
    notifier,
    mcpServers,
    notifyTaskEvents: notifierIsFallback,
  });
  const digest = createDigestService(ctx, { buildDigest, loadContext, llm });
  const contextRefresh = createContextRefresh(ctx, { refreshContext, llm });
  const scheduler = createScheduler(ctx, {
    executor,
    planner,
    maintenance: () => runMaintenance(ctx),
    expireApprovals: approvals.expireDue ? (now?: Date) => approvals.expireDue!(now) as import("../core/types.js").Approval[] : undefined,
  });

  // ── publish on ctx.services (overrides win) ───────────────────────
  ctx.services.llm = llm;
  ctx.services.notifier = notifier;
  ctx.services.approvals = approvals;
  ctx.services.executor = overrides.executor ?? executor;
  ctx.services.patrol = overrides.patrol ?? patrol;
  ctx.services.triage = overrides.triage ?? triage;
  ctx.services.planner = overrides.planner ?? planner;
  ctx.services.inbox = overrides.inbox ?? inbox;
  ctx.services.capture = overrides.capture ?? inbox.capture;
  ctx.services.digest = overrides.digest ?? digest;
  ctx.services.contextRefresh = overrides.contextRefresh ?? contextRefresh;

  const createInboundHandler = (): InboundHandler => {
    const capture = async (text: string, by: string) => {
      const s = await inbox.capture(text, by);
      return { ok: true, message: `captured ${s.id}: ${s.title}` };
    };
    const status = async () => statusLine(collectStatus(ctx, { sensors: patrol.sensors() }), config.locale);
    if (approvalsMod) return approvalsMod.createInboundHandler({ approvals, repo, locale: config.locale, capture, status });
    return {
      async decide(d) {
        try {
          const a = await approvals.decide(d);
          return { ok: true, message: `recorded ${a.id}: ${a.status}` };
        } catch (e) {
          return { ok: false, message: errMsg(e) };
        }
      },
      capture,
      status,
    };
  };

  const wired: Wired = {
    dry,
    isolated,
    modules,
    sensors,
    llm,
    notifier,
    approvals,
    patrol,
    triage,
    planner,
    inbox,
    executor: (overrides.executor as ExecutorService | undefined) ?? executor,
    digest,
    contextRefresh,
    scheduler,
    createServer: serverMod ? (c) => serverMod.createServer(c) : undefined,
    createInboundHandler,
    seedDemo: seedMod ? () => seedMod.seedDemo(repo, bus) : undefined,
  };
  registry.set(ctx, wired);
  logger.debug(`wired services (dry=${dry}, isolated=${isolated})`, modules);
  return wired;
}
