/**
 * In-process MCP server exposing Task Center tools to the execution agent
 * (mcp__taskcenter__*). Tools run in the daemon process and touch the DB directly.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { recordLearned } from "../brain/memory.js";
import { truncateChars } from "../brain/providers/util.js";
import type { Bus } from "../core/events.js";
import type { Logger } from "../core/logger.js";
import type { Repo } from "../core/repo.js";
import { isoPlus } from "../core/time.js";
import { ARTIFACT_TYPES, RISKS, type Run, type Task } from "../core/types.js";
import type { ApprovalService } from "../hitl/types.js";

export interface TaskCenterMcpDeps {
  repo: Repo;
  bus: Bus;
  task: Task;
  run: Run;
  approvals: ApprovalService;
  logger: Logger;
  workspace: string;
  /** Hours until a request_approval item expires (default 72). */
  expiresHours?: number;
}

export interface TaskCenterMcpState {
  /** Approval ids created through request_approval during this run. */
  approvalIds: string[];
  /** Last status the agent reported via update_task_status. */
  lastStatus?: string;
}

export const TASKCENTER_MCP_NAME = "taskcenter";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(t: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

export function createTaskCenterMcp(deps: TaskCenterMcpDeps): { name: string; server: unknown; state: TaskCenterMcpState; tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> }> } {
  const { repo, bus, task, run, approvals, logger, workspace } = deps;
  const state: TaskCenterMcpState = { approvalIds: [] };
  const expiresHours = deps.expiresHours ?? 72;

  const update_task_status = tool(
    "update_task_status",
    "Report the agent's progress on the current task: in_progress, blocked, done or needs_human, with an optional summary. Does not change the task's lifecycle state (the task center owns that).",
    { status: z.enum(["in_progress", "blocked", "done", "needs_human"]), summary: z.string().optional() },
    async ({ status, summary }) => {
      state.lastStatus = status;
      bus.record({ type: "assistant_message", task_id: task.id, run_id: run.id, message: `[agent status: ${status}]${summary ? ` ${truncateChars(summary, 500)}` : ""}`, payload: { agent_status: status, summary: summary ?? null } });
      if (summary) repo.tasks.update(task.id, { result_summary: truncateChars(summary, 4000) });
      return text(`status recorded: ${status}`);
    },
    { annotations: { idempotentHint: true } },
  );

  const add_note = tool(
    "add_note",
    "Append a short progress note (decision, finding, blocker) to the task timeline.",
    { text: z.string().min(1).max(4000) },
    async ({ text: note }) => {
      bus.record({ type: "assistant_message", task_id: task.id, run_id: run.id, message: truncateChars(note, 1000), payload: { note: true } });
      return text("noted");
    },
  );

  const request_approval = tool(
    "request_approval",
    "Ask the human for a decision or an answer before continuing. Returns the approval id. After calling this, stop working on that step and finish with status needs_human; the task will be resumed with the human's answer.",
    {
      title: z.string().min(1).max(200),
      context: z.string().min(1).max(6000),
      recommendation: z.string().max(2000).optional(),
      options: z.array(z.string().min(1).max(80)).max(6).optional(),
      risk: z.enum(RISKS).optional(),
      kind: z.enum(["decision", "question"]).optional(),
    },
    async ({ title, context, recommendation, options, risk, kind }) => {
      const k = kind ?? (options && options.length ? "decision" : "question");
      const opts = options && options.length ? options.map((o) => ({ value: o.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40) || "option", label: o })) : [{ value: "respond", label: "Respond" }];
      if (k === "decision" && !opts.some((o) => o.value === "reject")) opts.push({ value: "reject", label: "Reject" });
      const a = await approvals.request({ task_id: task.id, run_id: run.id, kind: k, title, context, recommendation: recommendation ?? "", options: opts, payload: { source: "agent", tool: "request_approval" }, risk: risk ?? "medium", expires_at: isoPlus(expiresHours * 3_600_000) });
      state.approvalIds.push(a.id);
      bus.record({ type: "approval_requested", task_id: task.id, run_id: run.id, message: `agent asked: ${truncateChars(title, 120)}`, payload: { approval_id: a.id, kind: k, source: "agent" } });
      return text(`Approval ${a.id} created (${k}). The human has been notified. Do not wait or poll: record what you have done so far and finish now with status needs_human, including this question in needs_human.question.`);
    },
    { annotations: { destructiveHint: false, openWorldHint: true } },
  );

  const deliver_artifact = tool(
    "deliver_artifact",
    "Register a deliverable (file in the workspace, URL, inline text/document, patch, PR, email draft) so the human can find it. Provide path (relative to the workspace or absolute), url, or content.",
    {
      type: z.enum(ARTIFACT_TYPES),
      title: z.string().min(1).max(200),
      path: z.string().optional(),
      url: z.string().optional(),
      content: z.string().max(200_000).optional(),
    },
    async ({ type, title, path, url, content }) => {
      if (!path && !url && !content) return text("deliver_artifact needs at least one of path, url, content", true);
      let absPath: string | null = null;
      let size: number | null = null;
      if (path) {
        absPath = path.startsWith("/") ? path : resolve(workspace, path);
        if (!existsSync(absPath)) return text(`path does not exist: ${absPath}`, true);
        try {
          size = statSync(absPath).size;
        } catch {
          size = null;
        }
      }
      const art = repo.artifacts.create({ task_id: task.id, run_id: run.id, type, title, path: absPath, url: url ?? null, content: content ?? null, size: size ?? undefined });
      bus.record({ type: "artifact", task_id: task.id, run_id: run.id, message: `artifact: ${title} (${type})`, payload: { artifact_id: art.id, type, path: absPath, url: url ?? null } });
      return text(`artifact ${art.id} registered`);
    },
    { annotations: { idempotentHint: false } },
  );

  const remember = tool(
    "remember",
    "Save durable facts about the user, their projects or people for future tasks (only clearly true, useful facts).",
    { facts: z.array(z.string().min(6).max(500)).min(1).max(20) },
    async ({ facts }) => {
      const added = recordLearned(repo, facts, task.id, bus);
      return text(`remembered ${added} new fact(s) (${facts.length - added} already known)`);
    },
    { annotations: { idempotentHint: true } },
  );

  const defs = [update_task_status, add_note, request_approval, deliver_artifact, remember];
  const sdk = createSdkMcpServer({
    name: TASKCENTER_MCP_NAME,
    version: "1.0.0",
    instructions: "Task Center tools: report progress with update_task_status, leave notes with add_note, ask humans with request_approval (then stop with needs_human), register every deliverable with deliver_artifact, and save durable facts with remember.",
    tools: defs,
    timeout: 60_000,
  });
  const server = {
    ...sdk,
    // always_ask routes these through canUseTool / the gate even when allowedTools covers mcp__taskcenter__*.
    tools: [
      { name: "deliver_artifact", permission_policy: "always_ask" as const },
      { name: "request_approval", permission_policy: "always_ask" as const },
    ],
  };
  logger.debug(`taskcenter MCP ready for ${task.id}`);
  return {
    name: TASKCENTER_MCP_NAME,
    server,
    state,
    tools: defs.map((d) => ({ name: d.name, handler: (args: Record<string, unknown>) => (d.handler as (a: unknown, extra: unknown) => Promise<ToolResult>)(args, {}) })),
  };
}
