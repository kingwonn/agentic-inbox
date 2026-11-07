/**
 * Resume after an approval whose parked agent session does not exist on this machine (e.g. it ran in a
 * cloud session and only the state was imported with `tc state import`). The executor must fall back
 * once, in the same run, to a fresh session that carries the human's decision — not fail and redo.
 *
 * Harness: the real executor, prompt builder and tool gate; the engine dry runner (scripted through
 * task.context.dry, `sessionMissing: true` makes resume runs report `sessionNotFound`), wrapped to
 * record every RunInput.
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadContext } from "../src/brain/context.js";
import { buildExecutionPrompt } from "../src/brain/prompts/execute.js";
import { createDryRunner } from "../src/engine/dry.js";
import { createExecutor } from "../src/engine/executor.js";
import { fallbackPrepareWorkspace } from "../src/engine/fallbacks.js";
import { createToolGate } from "../src/runners/gate.js";
import { AGENT_OUTPUT_JSON_SCHEMA, extractAgentOutputFromText, parseAgentOutput } from "../src/runners/result.js";
import type { RunInput, Runner } from "../src/runners/types.js";
import { makeCtx, type TestCtx } from "./engine-helpers.js";

const PUSH = { command: "git push origin main" };

function harness(t: TestCtx) {
  const { ctx } = t;
  const inputs: RunInput[] = [];
  const dry = createDryRunner();
  const runner: Runner = {
    name: "dry",
    available: () => dry.available(),
    run(input) {
      inputs.push(input);
      return dry.run(input);
    },
  };
  const executor = createExecutor(ctx, {
    selectRunner: async () => runner,
    gateFactory: (o) => createToolGate(o),
    prepareWorkspace: (task) => fallbackPrepareWorkspace(task, { config: ctx.config, rootDir: ctx.loaded.rootDir, logger: ctx.logger }),
    buildExecutionPrompt,
    loadContext: () => loadContext(ctx.loaded, ctx.repo),
    outputSchema: AGENT_OUTPUT_JSON_SCHEMA,
    parseAgentOutput,
    extractAgentOutputFromText,
    recordLearned: () => 0,
    approvals: t.wired.approvals,
    tickMs: 60_000,
  });
  return {
    inputs,
    async runAll() {
      await executor.tick();
      await executor.drain();
    },
  };
}

describe("engine/executor resume when the parked session is missing", () => {
  let t: TestCtx;
  afterEach(async () => t?.cleanup());

  /** Run an L4 task until the gate parks it on `git push`, then decide that approval. */
  async function parkAndDecide(dry: Record<string, unknown>, decision: { decision: string; note?: string; editedPayload?: Record<string, unknown> }) {
    t = await makeCtx();
    const h = harness(t);
    const { repo } = t.ctx;
    const task = repo.tasks.create({ title: "Publish the release notes", description: "Commit RELEASE.md and push it to the main branch.", level: 4, status: "ready", context: { dry: { tool: "Bash", toolInput: PUSH, ...dry } } });
    await h.runAll();
    expect(repo.tasks.get(task.id)?.status).toBe("waiting_human");
    const run1 = repo.runs.latestForTask(task.id)!;
    const [approval] = repo.approvals.list({ task_id: task.id, status: "pending" });
    expect(approval.payload).toMatchObject({ tool: "Bash", input: PUSH });
    await t.wired.approvals.decide({ approvalId: approval.id, decidedBy: "test", ...decision });
    expect(repo.tasks.get(task.id)?.status).toBe("ready");
    await h.runAll();
    const run2 = repo.runs.latestForTask(task.id)!;
    const events = repo.events.list({ run_id: run2.id, limit: 500 });
    const fallbacks = events.filter((e) => e.type === "system" && e.payload?.resume_fallback);
    const actionApprovals = repo.approvals.list({ task_id: task.id, limit: 50 }).filter((a) => a.kind === "action");
    return { h, repo, task: repo.tasks.get(task.id)!, run1, run2, approval, events, fallbacks, actionApprovals };
  }

  it("approve: one run, fresh session with the brief + decision; the approved push runs without a second approval", async () => {
    const { h, task, run1, run2, approval, events, fallbacks, actionApprovals, repo } = await parkAndDecide({ sessionMissing: true }, { decision: "approve", note: "ship it" });

    // run 1 (parks), resume attempt on the lost session, fresh session — the last two in the same run
    expect(h.inputs.length).toBe(3);
    const [, resumeTry, fresh] = h.inputs;
    expect(resumeTry.run.id).toBe(run2.id);
    expect(resumeTry.resumeSessionId).toBe(run1.session_id);
    expect(fresh.run.id).toBe(run2.id);
    expect(fresh.resumeSessionId).toBeUndefined();
    expect(fresh.resumeMessage).toBeUndefined();
    expect(fresh.prompt).toContain("# Task: Publish the release notes");
    expect(fresh.prompt).toContain("Commit RELEASE.md and push it to the main branch.");
    expect(fresh.prompt).toContain("ran on another machine");
    expect(fresh.prompt).toContain(`approval ${approval.id}`);
    expect(fresh.prompt).toContain("The human decided: **approve**");
    expect(fresh.prompt).toContain("Note from the human: ship it");
    expect(fresh.prompt).toContain('"command": "git push origin main"');

    expect(repo.runs.listByTask(task.id).length).toBe(2);
    expect(run2).toMatchObject({ reason: "resume_after_approval", resume_of: run1.id, status: "succeeded", error: null, session_id: `dry-${run2.id}` });
    expect(task.status).toBe("review"); // L4 deliverable
    expect(task.attempts).toBe(0);
    expect(task.last_error).toBeNull();

    expect(fallbacks.length).toBe(1);
    expect(fallbacks[0].payload).toMatchObject({ resume_fallback: "fresh_session", lost_session_id: run1.session_id, approval_id: approval.id, decision: "approve" });
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    // the gate applied the earlier decision: the push ran, no new Outbox item
    expect(events.find((e) => e.type === "tool_result" && e.message === "Bash")?.payload?.output).toBe("ok (dry)");
    expect(actionApprovals.map((a) => a.id)).toEqual([approval.id]);
  });

  it("reject: the fresh session is told not to redo the work, and the push stays denied without a new approval", async () => {
    const { h, task, run2, events, fallbacks, actionApprovals, approval } = await parkAndDecide({ sessionMissing: true }, { decision: "reject", note: "not this week" });
    const fresh = h.inputs[2];
    expect(fresh.prompt).toContain("The human decided: **reject**");
    expect(fresh.prompt).toContain("Do not redo the earlier work and do not perform the rejected action");
    expect(fresh.prompt).toContain("Note from the human: not this week");
    expect(fallbacks.length).toBe(1);
    expect(String(events.find((e) => e.type === "tool_result" && e.message === "Bash")?.payload?.output)).toContain(`The human rejected this action (approval ${approval.id}): not this week`);
    expect(actionApprovals.length).toBe(1);
    expect(run2.status).toBe("succeeded");
    expect(task.attempts).toBe(0);
  });

  it("falls back only once: a failing fresh session is an ordinary failed attempt", async () => {
    const { h, task, run2, fallbacks } = await parkAndDecide({ sessionMissing: true, fail: true, error: "tests failed" }, { decision: "approve" });
    expect(h.inputs.length).toBe(3);
    expect(fallbacks.length).toBe(1);
    expect(run2.status).toBe("failed");
    expect(run2.error).toBe("tests failed");
    expect(task.status).toBe("blocked");
    expect(task.attempts).toBe(1);
    expect(task.last_error).toBe("tests failed");
  });

  it("normal resume is unchanged: the parked session is resumed with the short resume message", async () => {
    const { h, task, run1, run2, fallbacks, actionApprovals } = await parkAndDecide({}, { decision: "approve", note: "go" });
    expect(h.inputs.length).toBe(2);
    const resumed = h.inputs[1];
    expect(resumed.resumeSessionId).toBe(run1.session_id);
    expect(resumed.resumeMessage).toBe(resumed.prompt);
    expect(resumed.prompt.startsWith(`# Resume task ${task.id}`)).toBe(true);
    expect(resumed.prompt).not.toContain("another machine");
    expect(fallbacks).toEqual([]);
    expect(run2).toMatchObject({ reason: "resume_after_approval", status: "succeeded", session_id: run1.session_id });
    expect(task.status).toBe("review");
    expect(actionApprovals.length).toBe(1);
  });

  it("a resume with no recorded session starts fresh with the brief and the answer", async () => {
    t = await makeCtx();
    const h = harness(t);
    const { repo } = t.ctx;
    const task = repo.tasks.create({ title: "Pick a venue", description: "Book the venue the human picks.", level: 2, status: "waiting_human" });
    const q = await t.wired.approvals.request({ kind: "question", task_id: task.id, title: "Which venue?", payload: {} });
    await t.wired.approvals.decide({ approvalId: q.id, decision: "respond", note: "the small one", decidedBy: "test" });
    await h.runAll();
    expect(h.inputs.length).toBe(1);
    expect(h.inputs[0].resumeSessionId).toBeUndefined();
    expect(h.inputs[0].prompt).toContain("# Task: Pick a venue");
    expect(h.inputs[0].prompt).toContain("The human decided: **respond**");
    expect(h.inputs[0].prompt).toContain("Note from the human: the small one");
    const run = repo.runs.latestForTask(task.id)!;
    expect(run.reason).toBe("resume_after_approval");
    expect(repo.events.list({ run_id: run.id, limit: 100 }).filter((e) => e.type === "system" && e.payload?.resume_fallback).map((e) => e.payload?.lost_session_id)).toEqual([null]);
    expect(repo.tasks.get(task.id)?.status).toBe("done");
  });
});
