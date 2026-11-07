/**
 * Executor: the worker pool. Picks runnable tasks (priority order), checks them out
 * atomically (task -> running + Run row in one transaction), runs them through a
 * Runner, persists every RunEvent, and applies the completion rules:
 *   waiting_human  -> task waiting_human (approval pending / question asked)
 *   succeeded      -> L5 verified: done · L3/L4: review (+ review approval) · L1/L2: done
 *   failed         -> retry with backoff (blocked + follow_up_at) or failed after max_attempts
 * The approval service (hitl) moves a waiting task back to ready and stores
 * task.context.pending_resume = { resume: {approvalId, kind, decision, note, editedPayload, decidedAt} };
 * the executor consumes that marker at checkout and resumes the parked agent session.
 */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { AppContext, ExecutorStatus, NotifierLike } from "../core/app.js";
import type { BudgetStatus } from "../core/budget.js";
import { TERMINAL_TASK_STATUSES, canTransitionTask, transitionRun, transitionTask } from "../core/state.js";
import { HOUR, isoPlus, nowIso } from "../core/time.js";
import type { AgentOutput, Approval, Artifact, Run, RunReason, Task } from "../core/types.js";
import { PRIORITY_RANK } from "../core/types.js";
import type { NotifyMessage } from "../hitl/types.js";
import type { RunEvent, RunInput, RunResult, Runner } from "../runners/types.js";
import type { ExecutorDeps, GateFactoryOpts, PendingResume, ResumeInfo } from "./types.js";
import { errMsg, sleep, trimPayload, trimText } from "./util.js";

export interface ExecutorService {
  wake(reason: string): void;
  retryTask(taskId: string): Promise<Task>;
  cancelTask(taskId: string, reason?: string): Promise<Task>;
  runTaskNow(taskId: string): Promise<Task>;
  pause(reason?: string): void;
  resume(): void;
  status(): ExecutorStatus;
  start(): void;
  stop(): Promise<void>;
  /** Move tasks whose follow_up_at elapsed (retry backoff, follow-ups) to ready. */
  retryDue(): number;
  /** Run one fill pass now (tests / one-shot CLI). */
  tick(): Promise<void>;
  /** Wait for all running tasks to finish (tests). */
  drain(): Promise<void>;
}

interface Running {
  task: Task;
  run: Run;
  ac: AbortController;
  startedAt: string;
  promise: Promise<void>;
  cancelled?: boolean;
  resume?: ResumeInfo;
  workspace?: { path: string; kind: string; branch?: string; startCommit?: string };
  delta?: { commits: string[]; dirty: number; stat: string };
}

/** Read the resume marker written by the approval service (nested) or an older flat form. */
export function readPendingResume(task: Task): PendingResume | undefined {
  const pr = task.context?.pending_resume as Record<string, unknown> | undefined;
  if (!pr || typeof pr !== "object") return undefined;
  const r = (pr.resume && typeof pr.resume === "object" ? pr.resume : pr) as Record<string, unknown>;
  if (typeof r.approvalId !== "string") return undefined;
  return {
    approvalId: r.approvalId,
    decision: String(r.decision ?? "approve"),
    note: typeof r.note === "string" ? r.note : undefined,
    editedPayload: r.editedPayload && typeof r.editedPayload === "object" ? (r.editedPayload as Record<string, unknown>) : undefined,
    kind: typeof r.kind === "string" ? r.kind : undefined,
    runId: typeof r.runId === "string" ? r.runId : null,
    sessionId: typeof r.sessionId === "string" ? r.sessionId : null,
    decidedAt: typeof r.decidedAt === "string" ? r.decidedAt : null,
  };
}

const execFileP = promisify(execFile);
const RESULT_TEXT_MAX = 64 * 1024;

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("git", args, { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Summary of what changed in a worktree since `startCommit` (commits + uncommitted files). */
async function workspaceDelta(ws: string, startCommit: string | undefined): Promise<{ commits: string[]; dirty: number; stat: string } | undefined> {
  const status = await git(ws, ["status", "--porcelain"]);
  if (status === undefined) return undefined;
  const dirty = status ? status.split("\n").filter(Boolean).length : 0;
  const log = startCommit ? await git(ws, ["log", "--oneline", `${startCommit}..HEAD`]) : "";
  const commits = log ? log.split("\n").filter(Boolean) : [];
  if (!dirty && !commits.length) return { commits, dirty, stat: "" };
  const stat = (startCommit ? await git(ws, ["diff", "--stat", startCommit]) : await git(ws, ["diff", "--stat"])) ?? "";
  return { commits, dirty, stat };
}
const TEXT_EXT = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".ts", ".js", ".py", ".html", ".css", ".csv", ".diff", ".patch", ".log"]);

export function createExecutor(ctx: AppContext, deps: ExecutorDeps & { notifyTaskEvents?: boolean }): ExecutorService {
  const { repo, bus, config, policy, budget } = ctx;
  const logger = ctx.logger.child("executor");
  const running = new Map<string, Running>();
  const concurrency = Math.max(1, Number(config.executor.concurrency) || 1);
  const tickMs = deps.tickMs ?? 30_000;
  const graceMs = deps.graceMs ?? 30_000;
  let paused = false;
  let pauseReason: string | undefined;
  let started = false;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let looping = false;
  let pendingWake = false;

  const notifier = (): NotifierLike | undefined => deps.notifier ?? ctx.services.notifier;

  async function notify(msg: NotifyMessage): Promise<void> {
    const n = notifier();
    if (!n) return;
    if (msg.kind !== "info" && !config.notifications.notify_on.includes(msg.kind)) return;
    try {
      await n.notify(msg);
    } catch (e) {
      logger.warn(`notify ${msg.kind} failed: ${errMsg(e)}`);
    }
  }

  // ── selection ─────────────────────────────────────────────────────

  function chooseModel(task: Task): string {
    if (task.model) return task.model;
    const m = config.brain.models;
    const hard = (task.plan?.notes ?? "").toLowerCase().includes("hard");
    return task.level >= 5 || hard ? m.heavy : m.execute;
  }

  function parentCancelled(t: Task): boolean {
    if (!t.parent_id) return false;
    const p = repo.tasks.get(t.parent_id);
    return !!p && (p.status === "cancelled" || p.status === "failed");
  }

  function candidates(): Task[] {
    const now = nowIso();
    return repo.tasks
      .runnable(200)
      .filter((t) => t.owner === "ai" && !running.has(t.id))
      .filter((t) => !(t.follow_up_at && t.follow_up_at > now))
      .filter((t) => !parentCancelled(t))
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.created_at.localeCompare(b.created_at));
  }

  // ── checkout ──────────────────────────────────────────────────────

  /** What the resume run needs to know about the decision, incl. the gated tool call of an action approval. */
  function resumeInfoOf(pending: PendingResume): ResumeInfo {
    const a = repo.approvals.get(pending.approvalId);
    const payload = a?.kind === "action" ? a.payload : undefined;
    const input = payload?.input && typeof payload.input === "object" && !Array.isArray(payload.input) ? (payload.input as Record<string, unknown>) : {};
    return {
      approvalId: pending.approvalId,
      decision: pending.decision,
      note: pending.note,
      editedPayload: pending.editedPayload,
      kind: pending.kind ?? a?.kind,
      ...(typeof payload?.tool === "string" ? { action: { tool: payload.tool, input } } : {}),
    };
  }

  async function checkout(taskId: string, reasonOverride?: RunReason): Promise<Running | undefined> {
    const t0 = repo.tasks.get(taskId);
    if (!t0 || t0.status !== "ready" || running.has(taskId)) return undefined;
    let runner: Runner;
    try {
      runner = await deps.selectRunner(t0.runner);
    } catch (e) {
      const msg = `runner unavailable: ${errMsg(e)}`;
      bus.record({ type: "error", level: "error", task_id: taskId, message: msg });
      transitionTask(repo, bus, taskId, "blocked", { reason: msg, patch: { last_error: msg, follow_up_at: isoPlus(5 * 60_000) } });
      return undefined;
    }
    const model = chooseModel(t0);
    let out: { task: Task; run: Run; resume?: ResumeInfo } | undefined;
    try {
      out = repo.transaction(() => {
        const t = repo.tasks.get(taskId);
        if (!t || t.status !== "ready") return undefined;
        if (!repo.tasks.dependenciesSatisfied(t)) return undefined;
        const pending = readPendingResume(t);
        const previous = pending ? (pending.runId ? repo.runs.get(pending.runId) : undefined) ?? repo.runs.latestForTask(t.id) : undefined;
        const reason: RunReason = pending ? "resume_after_approval" : (reasonOverride ?? (t.attempts > 0 ? "retry" : "scheduled"));
        const run = repo.runs.create({
          task_id: t.id,
          runner: runner.name,
          model,
          attempt: t.attempts + 1,
          reason,
          resume_of: previous?.id ?? null,
          session_id: pending?.sessionId ?? previous?.session_id ?? null,
        });
        const patch: Partial<Task> = {};
        if (pending) {
          // consume the marker now; keep a trace for the audit trail
          const c = { ...(t.context ?? {}) };
          delete c.pending_resume;
          delete c.waiting_approval_id;
          c.last_resume = { ...pending, runId: run.id, resumedAt: nowIso() };
          patch.context = c;
        }
        const task = transitionTask(repo, bus, t.id, "running", { run_id: run.id, reason, patch });
        return { task, run, resume: pending ? resumeInfoOf(pending) : undefined };
      });
    } catch (e) {
      logger.warn(`checkout ${taskId} failed: ${errMsg(e)}`);
      return undefined;
    }
    if (!out) return undefined;
    const entry: Running = { task: out.task, run: out.run, ac: new AbortController(), startedAt: nowIso(), promise: Promise.resolve(), resume: out.resume };
    running.set(taskId, entry);
    entry.promise = execute(entry, runner)
      .catch((e) => logger.error(`run ${entry.run.id} crashed: ${errMsg(e)}`, e))
      .finally(() => {
        running.delete(taskId);
        if (!stopping) wake("run_finished");
      });
    return entry;
  }

  // ── execution ─────────────────────────────────────────────────────

  function persistEvent(task: Task, run: Run, ev: RunEvent): void {
    const base = { task_id: task.id, run_id: run.id };
    switch (ev.type) {
      case "started":
        if (ev.sessionId || ev.model) repo.runs.update(run.id, { ...(ev.sessionId ? { session_id: ev.sessionId } : {}), ...(ev.model ? { model: ev.model } : {}) });
        break;
      case "assistant":
        bus.record({ ...base, type: "assistant_message", message: trimText(ev.text, 8 * 1024) });
        break;
      case "tool_call":
        bus.record({ ...base, type: "tool_call", message: ev.tool, payload: { tool: ev.tool, input: trimPayload(ev.input), toolUseId: ev.toolUseId ?? null } });
        break;
      case "tool_result":
        bus.record({ ...base, type: "tool_result", level: ev.isError ? "warn" : "debug", message: ev.tool, payload: { tool: ev.tool, output: trimPayload(ev.output), toolUseId: ev.toolUseId ?? null, isError: !!ev.isError } });
        break;
      case "cost":
        bus.record({ ...base, type: "cost", level: "debug", message: `$${ev.costUsd.toFixed(4)}`, payload: { costUsd: ev.costUsd, inputTokens: ev.inputTokens ?? null, outputTokens: ev.outputTokens ?? null } });
        break;
      case "error":
        bus.record({ ...base, type: "error", level: "error", message: trimText(ev.error, 4096) });
        break;
      case "approval_requested":
      case "approval_decided":
        logger.debug(`${ev.type} ${ev.approvalId}`);
        break;
      case "progress":
        logger.debug(`progress: ${ev.message}`);
        break;
      default:
        break;
    }
  }

  function recordResumeFallback(task: Task, run: Run, runner: Runner, resume: ResumeInfo, lostSessionId: string | null, why: string): void {
    bus.record({
      type: "system",
      task_id: task.id,
      run_id: run.id,
      message: `${lostSessionId ? `session ${lostSessionId} not found on this machine` : why}; continuing in a fresh session with the decision on approval ${resume.approvalId} (${resume.decision})`,
      payload: { resume_fallback: "fresh_session", lost_session_id: lostSessionId, approval_id: resume.approvalId, decision: resume.decision, runner: runner.name, reason: trimText(why, 500) },
    });
    logger.info(`run ${run.id}: resume fallback to a fresh session (${trimText(why, 200)})`);
  }

  function promptTaskFor(task: Task): Task {
    if (task.context?.phase !== "integrate") return task;
    const children = repo.tasks.children(task.id).map((c) => ({ id: c.id, title: c.title, status: c.status, result_summary: c.result_summary, workspace: c.workspace }));
    return {
      ...task,
      context: {
        ...task.context,
        children,
        integration_note:
          "All subtasks have finished. Verify and integrate their results into the final deliverable for this task; report what each subtask produced and what remains.",
      },
    };
  }

  async function execute(entry: Running, runner: Runner): Promise<void> {
    const { task, run, ac } = entry;
    const log = logger.child(run.id);
    const timeoutMs = Math.max(1_000, Number(config.brain.timeout_seconds) * 1000);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort(new Error("timeout"));
    }, timeoutMs);
    timer.unref?.();
    let result: RunResult | undefined;
    let sessionId: string | null = run.session_id;
    let model = run.model;
    try {
      transitionRun(repo, bus, run.id, "running");
      bus.record({
        type: "run_started",
        task_id: task.id,
        run_id: run.id,
        message: `run started (attempt ${run.attempt}, ${run.reason}, ${runner.name}/${run.model})`,
        payload: { attempt: run.attempt, reason: run.reason, runner: runner.name, model: run.model, level: task.level, resume_of: run.resume_of },
      });
      const ws = await deps.prepareWorkspace(task);
      const branch = (ws as { branch?: string }).branch;
      const startCommit = ws.kind === "worktree" ? await git(ws.path, ["rev-parse", "HEAD"]) : undefined;
      entry.workspace = { path: ws.path, kind: ws.kind, branch, startCommit };
      const wsPatch: Partial<Task> = {};
      if (task.workspace !== ws.path) wsPatch.workspace = ws.path;
      if (branch && task.context?.branch !== branch) wsPatch.context = { ...(task.context ?? {}), branch, workspace_kind: ws.kind };
      if (Object.keys(wsPatch).length) repo.tasks.update(task.id, wsPatch);
      const context = deps.loadContext();
      const resume = entry.resume;
      const promptTask = promptTaskFor({ ...task, workspace: ws.path });
      const promptOpts = { level: task.level, workspace: ws.path, locale: config.locale, resume };
      // A resume without any recorded session (the parked run died before its agent started) cannot
      // continue a conversation: give the fresh session the whole brief plus the decision.
      const noSession = !!resume && !run.session_id;
      if (noSession) recordResumeFallback(task, run, runner, resume!, null, "no session was recorded for the parked run");
      const { prompt, systemPromptAppend } = deps.buildExecutionPrompt(promptTask, context, { ...promptOpts, freshSession: noSession });
      const tools = policy.toolsForLevel(task.level);
      const gateOpts: GateFactoryOpts = {
        policy,
        level: task.level,
        task: resume ? { ...promptTask, context: { ...promptTask.context, pending_resume: { resume } } } : promptTask,
        run,
        workspace: ws.path,
        approvals: deps.approvals,
        bus,
        waitMs: Number(config.approval.wait_seconds) * 1000,
        expiresHours: Number(config.approval.expire_hours),
        signal: ac.signal,
        logger: log,
        repo,
      };
      const gate = deps.gateFactory(gateOpts);
      const input: RunInput = {
        task: promptTask,
        run,
        level: task.level,
        prompt,
        systemPromptAppend,
        workspace: ws.path,
        model: run.model,
        effort: config.brain.effort,
        maxTurns: config.brain.max_turns,
        timeoutMs,
        budgetUsd: task.budget_usd,
        allowedTools: tools.allow,
        disallowedTools: tools.deny,
        outputSchema: deps.outputSchema,
        resumeSessionId: resume && !noSession ? run.session_id ?? undefined : undefined,
        resumeMessage: resume && !noSession ? prompt : undefined,
        mcpServers: deps.mcpServers?.({ task: promptTask, run, workspace: ws.path }),
        gate,
        signal: ac.signal,
        logger: log,
        describeGate: (tool, inp) => policy.evaluateToolUse({ level: task.level, toolName: tool, input: inp, workspace: ws.path }),
      };
      const drive = async (inp: RunInput): Promise<RunResult | undefined> => {
        let out: RunResult | undefined;
        for await (const ev of runner.run(inp)) {
          persistEvent(task, run, ev);
          if (ev.type === "started") {
            if (ev.sessionId) sessionId = ev.sessionId;
            if (ev.model) model = ev.model;
          } else if (ev.type === "result") {
            out = ev.result;
          }
        }
        return out;
      };
      result = await drive(input);
      if (result?.sessionNotFound && resume && input.resumeSessionId && !ac.signal.aborted) {
        // The parked session lives on another machine (state imported from elsewhere). Nothing ran, so
        // instead of failing (and later redoing everything without the decision) start one fresh
        // session in this same run that carries the brief plus the human's decision. Not an attempt.
        recordResumeFallback(task, run, runner, resume, input.resumeSessionId, result.error ?? "session not found");
        sessionId = null;
        repo.runs.update(run.id, { session_id: null });
        const fresh = deps.buildExecutionPrompt(promptTask, context, { ...promptOpts, freshSession: true });
        result = await drive({
          ...input,
          prompt: fresh.prompt,
          systemPromptAppend: fresh.systemPromptAppend,
          resumeSessionId: undefined,
          resumeMessage: undefined,
          // in-process MCP server instances are bound to one query; build new ones
          mcpServers: deps.mcpServers?.({ task: promptTask, run, workspace: ws.path }),
        });
      }
      if (result?.sessionId) sessionId = result.sessionId;
      const gatePending = (gate as { pendingApprovalId?: string }).pendingApprovalId;
      if (gatePending && !entry.cancelled && (!result || result.status !== "waiting_human")) {
        // The gate parked an approval; the agent stopped (or failed) around it → wait for the human.
        result = { ...(result ?? { text: "", costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0, durationMs: 0 }), status: "waiting_human", pendingApprovalId: gatePending, sessionId: sessionId ?? undefined };
      }
      if (!result) {
        const error = ac.signal.aborted ? (timedOut ? `timeout after ${Math.round(timeoutMs / 1000)}s` : entry.cancelled ? "cancelled" : "aborted") : "runner ended without a result";
        result = { status: "failed", sessionId: sessionId ?? undefined, text: "", costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0, durationMs: 0, error };
      } else if (timedOut && result.status !== "waiting_human") {
        result = { ...result, status: "failed", error: result.error ?? `timeout after ${Math.round(timeoutMs / 1000)}s` };
      }
    } catch (e) {
      const msg = errMsg(e);
      bus.record({ type: "error", level: "error", task_id: task.id, run_id: run.id, message: trimText(msg, 4096) });
      log.error(`run failed: ${msg}`);
      result = { status: "failed", sessionId: sessionId ?? undefined, text: "", costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0, durationMs: 0, error: msg };
    } finally {
      clearTimeout(timer);
    }
    if (result.status === "succeeded" && entry.workspace?.kind === "worktree") {
      const delta = await workspaceDelta(entry.workspace.path, entry.workspace.startCommit);
      if (delta && (delta.commits.length || delta.dirty)) entry.delta = delta;
    }
    await finish(entry, result, { timedOut, sessionId, model });
  }

  // ── completion ────────────────────────────────────────────────────

  async function finish(entry: Running, result: RunResult, meta: { timedOut: boolean; sessionId: string | null; model: string }): Promise<void> {
    const run = entry.run;
    const task = repo.tasks.get(entry.task.id);
    if (!task) return;
    const structured: AgentOutput | undefined =
      (result.structured ? deps.parseAgentOutput(result.structured) ?? result.structured : undefined) ??
      (result.text ? deps.extractAgentOutputFromText?.(result.text) : undefined);
    const cost = Number.isFinite(result.costUsd) ? Math.max(0, result.costUsd) : 0;
    const runPatch: Partial<Run> = {
      cost_usd: cost,
      input_tokens: result.inputTokens ?? 0,
      output_tokens: result.outputTokens ?? 0,
      num_turns: result.numTurns ?? 0,
      result: structured ?? null,
      result_text: trimText(result.text, RESULT_TEXT_MAX) || null,
      session_id: meta.sessionId,
      model: meta.model,
      error: result.error ?? null,
    };
    const post: Array<() => Promise<void>> = [];
    const interrupted = !entry.cancelled && stopping && entry.ac.signal.aborted && !meta.timedOut;

    repo.transaction(() => {
      if (cost > 0) repo.tasks.addCost(task.id, cost);
      bus.record({
        type: "run_finished",
        task_id: task.id,
        run_id: run.id,
        level: result.status === "failed" ? "warn" : "info",
        message: `run ${result.status}${result.error ? `: ${trimText(result.error, 200)}` : ""} ($${cost.toFixed(4)}, ${result.numTurns ?? 0} turns)`,
        payload: { status: result.status, costUsd: cost, numTurns: result.numTurns ?? 0, durationMs: result.durationMs ?? 0, agentStatus: structured?.status ?? null, pendingApprovalId: result.pendingApprovalId ?? null },
      });
      if (entry.cancelled) {
        transitionRun(repo, bus, run.id, "cancelled", runPatch as Record<string, unknown>, true);
        return;
      }
      if (interrupted) {
        transitionRun(repo, bus, run.id, "interrupted", runPatch as Record<string, unknown>, true);
        if (task.status === "running") transitionTask(repo, bus, task.id, "ready", { run_id: run.id, reason: "daemon stopping; will resume" });
        return;
      }
      if (task.status !== "running") {
        if (task.status === "waiting_human" || result.status === "waiting_human") {
          // The approval service already parked the task (the agent called request_approval or the
          // gate created an approval); keep the run resumable instead of closing it as failed.
          transitionRun(repo, bus, run.id, "waiting_human", runPatch as Record<string, unknown>, true);
          return;
        }
        // Someone moved the task meanwhile (cancel); just close the run.
        transitionRun(repo, bus, run.id, result.status === "succeeded" ? "succeeded" : "failed", runPatch as Record<string, unknown>, true);
        return;
      }
      if (result.status === "waiting_human") park(task, run, runPatch, structured, result.pendingApprovalId, post);
      else if (result.status === "succeeded") complete(task, run, runPatch, structured, result, post, entry);
      else fail(task, run, runPatch, result.error ?? "unknown error", post);
    });

    if (cost > 0 || result.status !== "waiting_human") {
      const status = budget.record(cost);
      await handleBudget(status);
    }
    for (const fn of post) {
      try {
        await fn();
      } catch (e) {
        logger.error(`post-run step failed for ${task.id}: ${errMsg(e)}`);
      }
    }
  }

  function contextWithout(task: Task, ...keys: string[]): Record<string, unknown> {
    const c = { ...(task.context ?? {}) };
    for (const k of keys) delete c[k];
    return c;
  }

  function park(task: Task, run: Run, runPatch: Partial<Run>, structured: AgentOutput | undefined, pendingApprovalId: string | undefined, post: Array<() => Promise<void>>): void {
    transitionRun(repo, bus, run.id, "waiting_human", runPatch as Record<string, unknown>);
    const needs = structured?.needs_human ?? undefined;
    transitionTask(repo, bus, task.id, "waiting_human", {
      run_id: run.id,
      reason: pendingApprovalId ? `approval ${pendingApprovalId} pending` : "agent needs human input",
      patch: { context: { ...contextWithout(task, "pending_resume"), waiting_approval_id: pendingApprovalId ?? null, waiting_run_id: run.id } },
    });
    if (!pendingApprovalId) {
      const hasPending = repo.approvals.list({ task_id: task.id, status: "pending", limit: 5 }).length > 0;
      if (!hasPending) {
        const question = needs?.question ?? structured?.summary ?? `Input needed to continue: ${task.title}`;
        const options = needs?.options?.length ? needs.options.map((o) => ({ value: o, label: o })) : [{ value: "respond", label: "Reply" }, { value: "reject", label: "Stop" }];
        post.push(async () => {
          const a = await deps.approvals.request({
            kind: "question",
            task_id: task.id,
            run_id: run.id,
            title: trimText(question, 200),
            context: structured?.summary ?? result_summaryOf(run) ?? "",
            recommendation: "",
            options,
            payload: { question, options: needs?.options ?? [] },
            risk: "low",
            expires_at: isoPlus(Number(config.approval.expire_hours) * HOUR),
          });
          repo.tasks.update(task.id, { context: { ...(repo.tasks.get(task.id)?.context ?? {}), waiting_approval_id: a.id } });
        });
      }
    }
  }

  function result_summaryOf(run: Run): string | undefined {
    return run.result?.summary ?? undefined;
  }

  function complete(task: Task, run: Run, runPatch: Partial<Run>, structured: AgentOutput | undefined, result: RunResult, post: Array<() => Promise<void>>, entry?: Running): void {
    if (structured?.status === "needs_human" || structured?.needs_human) {
      park(task, run, runPatch, structured, undefined, post);
      return;
    }
    transitionRun(repo, bus, run.id, "succeeded", runPatch as Record<string, unknown>);
    const artifacts = structured ? saveArtifacts(task, run, structured) : [];
    // Worktree hint: changes on the tc/ branch the agent did not report as an artifact.
    if (entry?.delta && entry.workspace?.branch && !artifacts.some((a) => a.type === "patch" || a.type === "pr")) {
      const d = entry.delta;
      const content = [`branch: ${entry.workspace.branch}`, `workspace: ${entry.workspace.path}`, d.commits.length ? `commits:\n${d.commits.join("\n")}` : "", d.dirty ? `uncommitted files: ${d.dirty}` : "", d.stat].filter(Boolean).join("\n\n");
      const row = repo.artifacts.create({ task_id: task.id, run_id: run.id, type: "patch", title: `Changes on ${entry.workspace.branch}`, path: entry.workspace.path, content: trimText(content, 16_000), mime: "text/plain" });
      bus.record({ type: "artifact", task_id: task.id, run_id: run.id, message: `patch: ${row.title}`, payload: { artifact_id: row.id, branch: entry.workspace.branch, commits: d.commits.length, dirty: d.dirty } });
      artifacts.push(row);
    }
    if (structured?.learned?.length) {
      try {
        deps.recordLearned(structured.learned, `task:${task.id}`);
      } catch (e) {
        logger.warn(`recordLearned failed: ${errMsg(e)}`);
      }
    }
    const summary = structured?.summary ?? trimText(result.text, 2000);
    const nextContext = contextWithout(task, "pending_resume", "waiting_approval_id", "waiting_run_id", "retry_at");
    if (structured?.follow_ups?.length) nextContext.follow_ups = structured.follow_ups;
    if (structured?.status === "blocked") {
      transitionTask(repo, bus, task.id, "blocked", { run_id: run.id, reason: "agent reported blocked", patch: { last_error: summary, result_summary: summary, context: nextContext } });
      return;
    }
    const verified = structured?.verification?.passed === true;
    const partial = structured?.status === "partial";
    let to: "done" | "review";
    if (task.level >= 5) to = verified && !partial ? "done" : "review";
    else if (task.level >= 3) to = "review";
    else to = "done";
    const reason = to === "done" ? (task.level >= 5 ? "verified" : "analysis delivered") : task.level >= 5 ? (partial ? "partial result" : "verification failed") : `L${task.level} deliverable awaits review`;
    transitionTask(repo, bus, task.id, to, { run_id: run.id, reason, patch: { result_summary: summary, last_error: null, context: nextContext } });
    if (to === "done") {
      afterDone(task);
      if (deps.notifyTaskEvents) post.push(() => notify({ kind: "task_done", task: repo.tasks.get(task.id)!, title: `Done: ${task.title}`, body: summary }));
    } else {
      post.push(async () => {
        const list = artifacts.map((a) => `- [${a.type}] ${a.title}${a.url ? ` ${a.url}` : a.path ? ` (${a.path})` : ""}`).join("\n");
        const ctxText = `${summary}${list ? `\n\nArtifacts:\n${list}` : ""}${structured?.verification ? `\n\nVerification: ${structured.verification.passed ? "passed" : "not passed"} — ${structured.verification.details}` : ""}`;
        await deps.approvals.request({
          kind: "review",
          task_id: task.id,
          run_id: run.id,
          title: `Review: ${task.title}`,
          context: trimText(ctxText, 6000),
          recommendation: structured?.verification?.passed === false ? "Verification did not pass; inspect before accepting." : "Accept if the deliverable meets the acceptance criteria.",
          payload: { task_id: task.id, run_id: run.id, artifacts: artifacts.map((a) => a.id), level: task.level, workspace: task.workspace },
          risk: "low",
          expires_at: isoPlus(Number(config.approval.expire_hours) * HOUR),
        });
      });
    }
  }

  function fail(task: Task, run: Run, runPatch: Partial<Run>, error: string, post: Array<() => Promise<void>>): void {
    transitionRun(repo, bus, run.id, "failed", runPatch as Record<string, unknown>);
    const attempts = task.attempts + 1;
    const max = task.max_attempts > 0 ? task.max_attempts : config.executor.max_attempts;
    const nextContext = contextWithout(task, "pending_resume", "waiting_approval_id", "waiting_run_id");
    if (attempts < max) {
      const backoffs = config.executor.backoff_seconds.length ? config.executor.backoff_seconds : [60, 300, 900];
      const sec = backoffs[Math.min(attempts - 1, backoffs.length - 1)];
      const at = isoPlus(sec * 1000);
      transitionTask(repo, bus, task.id, "blocked", {
        run_id: run.id,
        reason: `attempt ${attempts}/${max} failed; retry in ${sec}s`,
        patch: { attempts, last_error: error, follow_up_at: at, context: { ...nextContext, retry_at: at } },
      });
    } else {
      transitionTask(repo, bus, task.id, "failed", { run_id: run.id, reason: `attempt ${attempts}/${max} failed`, patch: { attempts, last_error: error, context: nextContext } });
      if (deps.notifyTaskEvents) post.push(() => notify({ kind: "task_failed", task: repo.tasks.get(task.id)!, title: `Failed: ${task.title}`, body: error, priority: "normal" }));
    }
  }

  function saveArtifacts(task: Task, run: Run, structured: AgentOutput): Artifact[] {
    const out: Artifact[] = [];
    for (const a of structured.artifacts ?? []) {
      if (!a || typeof a.title !== "string") continue;
      let path: string | null = a.path ?? null;
      let content: string | null = a.content ?? null;
      let size: number | undefined;
      let mime: string | null = null;
      if (a.path) {
        const abs = isAbsolute(a.path) ? a.path : join(task.workspace ?? "", a.path);
        try {
          if (existsSync(abs) && statSync(abs).isFile()) {
            const dir = join(ctx.dataDir, "artifacts", task.id, run.id);
            mkdirSync(dir, { recursive: true });
            const dest = join(dir, basename(abs));
            copyFileSync(abs, dest);
            path = dest;
            size = statSync(dest).size;
            const ext = extname(dest).toLowerCase();
            if (!content && TEXT_EXT.has(ext) && size <= 256 * 1024) content = readFileSync(dest, "utf8");
            if (ext === ".md") mime = "text/markdown";
            else if (ext === ".json") mime = "application/json";
            else if (TEXT_EXT.has(ext)) mime = "text/plain";
          }
        } catch (e) {
          logger.warn(`artifact copy failed for ${abs}: ${errMsg(e)}`);
        }
      }
      const row = repo.artifacts.create({ task_id: task.id, run_id: run.id, type: a.type ?? "text", title: a.title, path, url: a.url ?? null, content, mime, size });
      bus.record({ type: "artifact", task_id: task.id, run_id: run.id, message: `${row.type}: ${row.title}`, payload: { artifact_id: row.id, type: row.type, path: row.path, url: row.url } });
      out.push(row);
    }
    return out;
  }

  /** Parent/child bookkeeping after a task is done. */
  function afterDone(task: Task): void {
    if (!task.parent_id) return;
    const parent = repo.tasks.get(task.parent_id);
    if (!parent || TERMINAL_TASK_STATUSES.includes(parent.status)) return;
    const siblings = repo.tasks.children(parent.id);
    const allDone = siblings.every((s) => s.status === "done" || s.id === task.id);
    if (!allDone) return;
    if (parent.status === "blocked" && repo.tasks.dependenciesSatisfied({ ...parent, depends_on: parent.depends_on.filter((d) => d !== task.id) })) {
      transitionTask(repo, bus, parent.id, "ready", { reason: "all subtasks done; integrate", patch: { context: { ...(parent.context ?? {}), phase: "integrate" } } });
    } else if (parent.context?.phase !== "integrate") {
      repo.tasks.update(parent.id, { context: { ...(parent.context ?? {}), phase: "integrate" } });
    }
  }

  // ── budget ────────────────────────────────────────────────────────

  async function handleBudget(status: BudgetStatus): Promise<void> {
    const key = `budget_notified:${status.day}`;
    const prev = repo.meta.get(key);
    if (status.exhausted) {
      if (!paused) pause(`budget exhausted: $${status.spentUsd.toFixed(2)} of $${status.limitUsd} (${status.day})`);
      if (prev !== "exhausted") {
        repo.meta.set(key, "exhausted");
        await notify({ kind: "budget_warning", title: `Daily budget exhausted ($${status.spentUsd.toFixed(2)}/$${status.limitUsd})`, body: `Execution is paused until ${status.day} ends or the budget is raised.`, priority: "high" });
      }
    } else if (status.warn && !prev) {
      repo.meta.set(key, "warn");
      await notify({ kind: "budget_warning", title: `Daily budget at ${Math.round(status.ratio * 100)}% ($${status.spentUsd.toFixed(2)}/$${status.limitUsd})`, body: `Spend today reached ${Math.round(status.ratio * 100)}% of the daily budget.`, priority: "normal" });
    }
  }

  // ── loop ──────────────────────────────────────────────────────────

  async function fill(): Promise<void> {
    if (stopping) return;
    if (paused) {
      if (pauseReason?.startsWith("budget") && !budget.status().exhausted) resume();
      else return;
    }
    if (!budget.canSpend()) {
      await handleBudget(budget.status());
      return;
    }
    retryDue();
    const reserve = Math.max(0, Number(config.brain.budget_usd_per_run) || 0);
    while (running.size < concurrency && !stopping && !paused) {
      // Reserve the per-run budget for every in-flight run so we never start a run we cannot afford.
      if (!budget.canSpend(running.size * reserve)) break;
      const cands = candidates();
      if (!cands.length) break;
      let took = false;
      for (const c of cands) {
        if (await checkout(c.id)) {
          took = true;
          break;
        }
      }
      if (!took) break;
    }
  }

  async function tick(): Promise<void> {
    if (looping) {
      pendingWake = true;
      return;
    }
    looping = true;
    try {
      do {
        pendingWake = false;
        await fill();
      } while (pendingWake && !stopping);
    } catch (e) {
      logger.error(`executor loop failed: ${errMsg(e)}`, e);
    } finally {
      looping = false;
    }
  }

  function wake(reason: string): void {
    if (!started || stopping) return;
    logger.debug(`wake: ${reason}`);
    void tick();
  }

  function retryDue(): number {
    let n = 0;
    for (const t of repo.tasks.dueFollowUps()) {
      try {
        const ctxNext = { ...(t.context ?? {}) };
        delete ctxNext.retry_at;
        transitionTask(repo, bus, t.id, "ready", { reason: t.context?.retry_at ? "retry backoff elapsed" : "follow-up due", patch: { follow_up_at: null, context: ctxNext } });
        n++;
      } catch (e) {
        logger.warn(`follow-up for ${t.id} failed: ${errMsg(e)}`);
      }
    }
    return n;
  }

  const onWake = ({ reason }: { reason: string }) => wake(reason);

  // ── public API ────────────────────────────────────────────────────

  async function cancelTask(taskId: string, reason = "cancelled by user"): Promise<Task> {
    const task = repo.tasks.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (TERMINAL_TASK_STATUSES.includes(task.status)) return task;
    const r = running.get(taskId);
    if (r) {
      r.cancelled = true;
      r.ac.abort(new Error("cancelled"));
    }
    if (!canTransitionTask(task.status, "cancelled")) throw new Error(`cannot cancel task in status ${task.status}`);
    transitionTask(repo, bus, taskId, "cancelled", { reason, run_id: r?.run.id });
    for (const a of repo.approvals.list({ task_id: taskId, status: "pending", limit: 50 })) {
      repo.approvals.update(a.id, { status: "cancelled" });
      bus.record({ type: "approval_decided", task_id: taskId, run_id: a.run_id, message: `approval cancelled with task`, payload: { approval_id: a.id, status: "cancelled" } });
    }
    for (const c of repo.tasks.children(taskId)) {
      if (!TERMINAL_TASK_STATUSES.includes(c.status)) await cancelTask(c.id, "parent cancelled");
    }
    if (r) await Promise.race([r.promise, sleep(10_000)]);
    return repo.tasks.get(taskId)!;
  }

  async function retryTask(taskId: string): Promise<Task> {
    const task = repo.tasks.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (running.has(taskId) || task.status === "running") return task;
    if (task.status === "cancelled") transitionTask(repo, bus, taskId, "todo", { reason: "manual retry" });
    const ctxNext = contextWithout(task, "retry_at", "waiting_approval_id");
    const t = transitionTask(repo, bus, taskId, "ready", { reason: "manual retry", patch: { last_error: null, follow_up_at: null, context: ctxNext } });
    wake("retry");
    return t;
  }

  async function runTaskNow(taskId: string): Promise<Task> {
    const task = repo.tasks.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const existing = running.get(taskId);
    if (existing) {
      await existing.promise;
      return repo.tasks.get(taskId)!;
    }
    if (task.status !== "ready") {
      if (task.status === "cancelled") transitionTask(repo, bus, taskId, "todo", { reason: "run now" });
      if (task.status === "planning") transitionTask(repo, bus, taskId, "todo", { reason: "run now" });
      transitionTask(repo, bus, taskId, "ready", { reason: "run now", patch: { follow_up_at: null, context: contextWithout(task, "retry_at") } });
    }
    const entry = await checkout(taskId, "manual");
    if (!entry) throw new Error(`task ${taskId} could not be started (dependencies unmet or another run active)`);
    await entry.promise;
    return repo.tasks.get(taskId)!;
  }

  function pause(reason = "paused by user"): void {
    paused = true;
    pauseReason = reason;
    logger.warn(`executor paused: ${reason}`);
    bus.record({ type: "system", level: "warn", message: `executor paused: ${reason}`, payload: { paused: true, reason } });
  }

  function resume(): void {
    if (!paused) return;
    paused = false;
    const prev = pauseReason;
    pauseReason = undefined;
    logger.info(`executor resumed (was: ${prev})`);
    bus.record({ type: "system", message: "executor resumed", payload: { paused: false, previous: prev ?? null } });
    wake("resume");
  }

  function status(): ExecutorStatus {
    return {
      running: [...running.values()].map((r) => ({ task_id: r.task.id, run_id: r.run.id, started_at: r.startedAt, title: r.task.title })),
      concurrency,
      paused,
      ...(pauseReason ? { pauseReason } : {}),
    };
  }

  function start(): void {
    if (started) return;
    started = true;
    stopping = false;
    bus.on("wake", onWake);
    timer = setInterval(() => wake("tick"), tickMs);
    timer.unref?.();
    wake("start");
  }

  async function stop(): Promise<void> {
    if (!started) return;
    stopping = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    bus.off("wake", onWake);
    if (running.size) {
      const all = () => Promise.allSettled([...running.values()].map((r) => r.promise));
      await Promise.race([all(), sleep(graceMs)]);
      if (running.size) {
        logger.warn(`aborting ${running.size} running task(s) after ${graceMs}ms grace`);
        for (const r of running.values()) r.ac.abort(new Error("shutdown"));
        await Promise.race([all(), sleep(10_000)]);
      }
    }
    started = false;
    stopping = false;
  }

  async function drain(): Promise<void> {
    while (running.size) await Promise.allSettled([...running.values()].map((r) => r.promise));
  }

  return { wake, retryTask, cancelTask, runTaskNow, pause, resume, status, start, stop, retryDue, tick, drain };
}
