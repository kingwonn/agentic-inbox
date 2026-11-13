# Integration contracts (all modules implement exactly these names/signatures)

Shared context: `/home/user/agentic-inbox/taskcenter` — Node 22, TypeScript ESM (imports end with `.js`), zod 4, `node:sqlite` via `src/core/db.ts`, vitest.
Read first: `docs/architecture.md` (repo root), `src/core/{types,repo,policy,app,events,state,budget}.ts`, `src/config/{schema,load}.ts`, `src/sensors/types.ts`, `src/runners/types.ts`, `src/brain/llm.ts`, `src/hitl/types.ts`, `config/taskcenter.example.yaml`, `config/policy.yaml`, `config/profile.yaml`. Research: `docs/research/*.md` (repo root).

```ts
// sensors (agent S)
sensors/registry.ts:  export interface SensorEntry { sensor: Sensor; config: Record<string, unknown>; enabled: boolean }
                      export function createSensors(config: Config): SensorEntry[]
                      export function makeSensorContext(entry: SensorEntry, deps: { repo: Repo; logger: Logger; loaded: LoadedConfig }): SensorContext

// brain (agent B)
brain/providers/index.ts: export function createLlmProvider(config: Config, logger: Logger): LlmProvider   // claude-cli (default for provider claude-sdk|claude-cli), anthropic-api, dry
brain/context.ts:     export interface ContextSnapshot { profile: Record<string, unknown>; profileText: string; memoriesText: string; text: string; locale: string }
                      export function loadContext(loaded: LoadedConfig, repo: Repo): ContextSnapshot
brain/classifier.ts:  export async function triageSignals(signals: Signal[], deps: { llm: LlmProvider; policy: Policy; config: Config; context: ContextSnapshot; logger: Logger; availableCapabilities: string[] }): Promise<{ results: TriageResult[]; costUsd: number }>
brain/planner.ts:     export interface PlannedSubtask { title: string; description: string; level: Level; category: Category; priority: Priority; depends_on: number[]; acceptance_criteria: string[] }
                      export async function planTask(task: Task, deps: { llm: LlmProvider; policy: Policy; config: Config; context: ContextSnapshot; logger: Logger }): Promise<{ plan: TaskPlan; subtasks: PlannedSubtask[]; costUsd: number }>
brain/prompts/execute.ts: export function buildExecutionPrompt(task: Task, context: ContextSnapshot, opts: { level: Level; workspace: string; locale: string; resume?: { approvalId: string; decision: string; note?: string; editedPayload?: Record<string, unknown> } }): { prompt: string; systemPromptAppend: string }
brain/memory.ts:      export function recordLearned(repo: Repo, learned: string[], source: string, bus?: Bus): number
                      export async function refreshContext(deps: { repo: Repo; config: Config; loaded: LoadedConfig; llm?: LlmProvider; logger: Logger }): Promise<{ memoriesAdded: number }>
brain/digest.ts:      export async function buildDigest(deps: { repo: Repo; config: Config; context: ContextSnapshot; llm?: LlmProvider; logger: Logger }): Promise<string>

// runners (agent B)
runners/registry.ts:  export function createRunner(name: string, deps: { config: Config; logger: Logger }): Runner
                      export async function selectRunner(config: Config, logger: Logger, override?: string | null): Promise<Runner>
runners/gate.ts:      export function createToolGate(opts: { policy: Policy; level: Level; task: Task; run: Run; workspace: string; approvals: ApprovalService; bus: Bus; waitMs: number; expiresHours: number; signal: AbortSignal; logger: Logger }): ToolGate
runners/workspace.ts: export async function prepareWorkspace(task: Task, deps: { config: Config; rootDir: string; logger: Logger }): Promise<{ path: string; kind: "worktree" | "dir"; cleanup(): Promise<void> }>
runners/result.ts:    export const AGENT_OUTPUT_JSON_SCHEMA: Record<string, unknown>
                      export function parseAgentOutput(x: unknown): AgentOutput | undefined
                      export function extractAgentOutputFromText(text: string): AgentOutput | undefined
runners/taskcenter-tools.ts: export function createTaskCenterMcp(deps: { repo: Repo; bus: Bus; task: Task; run: Run; approvals: ApprovalService; logger: Logger; workspace: string }): { name: string; server: unknown }

// hitl (agent H)
hitl/approvals.ts:    export function createApprovalService(deps: { repo: Repo; bus: Bus; notifier: NotifierLike; config: Config; logger: Logger; publicUrl?: string }): ApprovalService
hitl/notifier.ts:     export class Notifier implements NotifierLike { ... }
                      export function createNotifier(deps: { config: Config; repo: Repo; bus: Bus; logger: Logger }): Notifier
hitl/render.ts:       export function renderApproval(a: Approval, task: Task | undefined, locale: string, publicUrl?: string): { title: string; body: string }
                      export function renderTaskEvent(kind: NotifyMessage["kind"], task: Task, locale: string, extra?: Record<string, unknown>): { title: string; body: string }

// server (agent D)
server/app.ts:        export function createServer(ctx: AppContext): { app: Hono; start(): Promise<{ host: string; port: number }>; stop(): Promise<void> }

// engine (agent E)
engine/app.ts:        export async function createApp(opts?: { configPath?: string; cwd?: string; logger?: Logger; overrides?: Partial<AppServices> }): Promise<AppContext>
engine/daemon.ts:     export async function startDaemon(ctx: AppContext, opts?: { serve?: boolean }): Promise<{ stop(): Promise<void> }>
```

Rules for every agent: only edit your own directories; core files (`src/core/*`, `src/config/*`, the `types.ts` interface files) may receive **small additive** changes only (report them). Do not run `git commit`/`git checkout`. Before finishing: `npx vitest run tests/<yours>*.test.ts` passes and `npx tsc -p tsconfig.json --noEmit` reports no errors in your files. Write `docs/modules/<module>.md`. User-facing text honors `config.locale` (`zh-CN` default; also provide `en`). Keep live `claude -p` calls few and on haiku.

## Change log (additive changes made during the parallel build and integration)

| Where | Change | By |
|---|---|---|
| `src/core/types.ts` | `TriageResult.level_proposed?: Level` (LLM proposal before policy clamp) | brain |
| `src/core/budget.ts` | `Budget.addCost(usd, now?)` for non-run costs (triage, planning) | engine |
| `src/core/logger.ts` | `redact()` fix: single-group secret patterns were appended with `***` instead of replaced | engine |
| `src/core/repo.ts` | `EventRepo.list` orders by `ts DESC, rowid DESC` (stable within a millisecond) | orchestrator |
| `src/hitl/types.ts` | `InboundDecision.decision: Decision \| (string & {})` (custom option values); `Channel.onDecided?(approval)` | hitl |
| `src/sensors/registry.ts` | `makeSensorContext(..., { now? })`; `SensorEntry.config` adds `locale`, `timezone`, `capture_dir`, `repo_root` | sensors |
| `src/runners/gate.ts` | returns `ToolGateWithState` (`pendingApprovalId?`, `approvalIds[]`) | runners |
| `src/runners/taskcenter-tools.ts` | returns `{ name, server, state, tools }` | runners |
| `src/runners/workspace.ts` | result adds `branch?` | runners |
| `src/brain/providers/claude-cli.ts` | structured calls use text JSON + zod by default (`TC_CLI_JSON_SCHEMA=1` opts into `--json-schema`); nested-session env vars stripped (`STRIPPED_ENV`) | integration |
| `src/runners/claude-sdk.ts`, `claude-cli.ts` | explicit per-run session id (`sessionId` / `--session-id`) so nested runs never inherit the outer Claude Code session id | integration |
| `src/server/app.ts` | `createServer(ctx, { heartbeatMs?, distDir? })`; extra routes `POST /api/tasks/:id/events`, `GET /api/context`, `GET /api/executor` | server |
| `src/engine/app.ts`, `daemon.ts` | optional fields (`dry`, `isolated`, `dbPath`, `sensors`, `logLevel`, `logToStderr`, `handleSignals`, `initialPatrolDelayMs`) | engine |
