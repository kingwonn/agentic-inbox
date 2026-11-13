/**
 * Live smoke test for the Claude Agent SDK runner (haiku, cheap).
 *
 *   npx tsx scripts/run-agent-smoke.ts            # both scenarios, auto-reject approvals after 1s
 *   TC_SMOKE_APPROVE=1 npx tsx scripts/run-agent-smoke.ts   # auto-approve instead
 *   TC_SMOKE_ONLY=1|2 to run a single scenario
 *
 * Scenario 1 (L3): list files and write hello.txt → expects a Write tool_call, a parsable
 *   structured result and a recorded cost.
 * Scenario 2 (L3): run `git push origin main` in a temp git repo → expects the gate to create an
 *   approval, the stub to reject it, and the agent to end blocked / needs_human (not done).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContext } from "../src/brain/context.js";
import { buildExecutionPrompt } from "../src/brain/prompts/execute.js";
import { ConfigSchema } from "../src/config/schema.js";
import type { LoadedConfig } from "../src/config/load.js";
import { openDb } from "../src/core/db.js";
import { Bus } from "../src/core/events.js";
import { createLogger } from "../src/core/logger.js";
import { Policy } from "../src/core/policy.js";
import { Repo } from "../src/core/repo.js";
import type { Approval, InboundDecision, NewApproval, Task } from "../src/core/types.js";
import type { ApprovalService } from "../src/hitl/types.js";
import { ClaudeSdkRunner } from "../src/runners/claude-sdk.js";
import { createToolGate } from "../src/runners/gate.js";
import { AGENT_OUTPUT_JSON_SCHEMA } from "../src/runners/result.js";
import { createTaskCenterMcp } from "../src/runners/taskcenter-tools.js";
import type { RunEvent, RunResult } from "../src/runners/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logger = createLogger({ level: (process.env.TC_LOG_LEVEL as "debug" | "info") || "info", scope: "smoke" });
const autoApprove = process.env.TC_SMOKE_APPROVE === "1";

class StubApprovals implements ApprovalService {
  created: Approval[] = [];
  constructor(private repo: Repo) {}
  async request(input: NewApproval): Promise<Approval> {
    const a = this.repo.approvals.create(input);
    this.created.push(a);
    logger.info(`[stub approvals] created ${a.id}: ${a.title} (risk ${a.risk})`);
    return a;
  }
  async waitForDecision(id: string): Promise<Approval> {
    await new Promise((r) => setTimeout(r, 1000));
    this.repo.approvals.decide(id, autoApprove ? { status: "approved", decision: "approve", decided_by: "smoke" } : { status: "rejected", decision: "reject", decision_note: "smoke test: never push to main", decided_by: "smoke" });
    const a = this.repo.approvals.get(id)!;
    logger.info(`[stub approvals] ${id} -> ${a.status}`);
    return a;
  }
  async decide(d: InboundDecision): Promise<Approval> {
    this.repo.approvals.decide(d.approvalId, { status: "approved", decision: d.decision });
    return this.repo.approvals.get(d.approvalId)!;
  }
  pending(): Approval[] {
    return this.repo.approvals.pending();
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok - ${msg}`);
}

async function runScenario(name: string, opts: { title: string; description: string; workspace: string; category: Task["category"]; criteria: string[] }) {
  console.log(`\n=== ${name} ===`);
  const db = openDb(":memory:");
  const repo = new Repo(db);
  const bus = new Bus(repo);
  const policy = Policy.load(resolve(ROOT, "config/policy.yaml"));
  const config = ConfigSchema.parse({ locale: "en", timezone: "UTC", brain: { provider: "claude-sdk", models: { execute: "haiku" } } });
  const loaded: LoadedConfig = { config, configPath: null, rootDir: ROOT, resolve: (p) => (p.startsWith("/") ? p : resolve(ROOT, p)) };
  const context = loadContext(loaded, repo);
  const approvals = new StubApprovals(repo);
  const level = 3 as const;

  const task = repo.tasks.create({ title: opts.title, description: opts.description, category: opts.category, level, status: "running", acceptance_criteria: opts.criteria, workspace: opts.workspace });
  const run = repo.runs.create({ task_id: task.id, runner: "claude-sdk", model: "haiku", status: "running" });
  const ac = new AbortController();
  const gate = createToolGate({ policy, level, task, run, workspace: opts.workspace, approvals, bus, waitMs: 30_000, expiresHours: 72, signal: ac.signal, logger: logger.child("gate") });
  const mcp = createTaskCenterMcp({ repo, bus, task, run, approvals, logger: logger.child("mcp"), workspace: opts.workspace });
  const { prompt, systemPromptAppend } = buildExecutionPrompt(task, context, { level, workspace: opts.workspace, locale: "en" });
  const tools = policy.toolsForLevel(level);

  const runner = new ClaudeSdkRunner({ logger: logger.child("sdk") });
  const events: RunEvent[] = [];
  let result: RunResult | undefined;
  const t0 = Date.now();
  for await (const ev of runner.run({
    task,
    run,
    level,
    prompt,
    systemPromptAppend,
    workspace: opts.workspace,
    model: "haiku",
    effort: "low",
    maxTurns: 8,
    timeoutMs: 240_000,
    budgetUsd: 0.5,
    allowedTools: tools.allow,
    disallowedTools: tools.deny,
    outputSchema: AGENT_OUTPUT_JSON_SCHEMA,
    mcpServers: { [mcp.name]: mcp.server },
    gate,
    signal: ac.signal,
    logger: logger.child("run"),
  })) {
    events.push(ev);
    if (ev.type === "result") result = ev.result;
    const line = ev.type === "tool_call" ? `${ev.tool} ${JSON.stringify(ev.input).slice(0, 160)}` : ev.type === "tool_result" ? `${ev.tool || ev.toolUseId} ${ev.isError ? "ERROR " : ""}${JSON.stringify(ev.output).slice(0, 160)}` : ev.type === "assistant" ? ev.text.slice(0, 200).replace(/\n/g, " ") : ev.type === "cost" ? `$${ev.costUsd.toFixed(4)}` : ev.type === "result" ? `${ev.result.status} cost=$${ev.result.costUsd.toFixed(4)} turns=${ev.result.numTurns}` : JSON.stringify(ev).slice(0, 160);
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${ev.type}: ${line}`);
  }
  if (!result) throw new Error("no result");
  console.log("structured:", JSON.stringify(result.structured, null, 2));
  if (result.error) console.log("error:", result.error);
  db.close();
  return { events, result, approvals, gate, mcp };
}

async function scenario1() {
  const ws = mkdtempSync(join(tmpdir(), "tc-smoke1-"));
  writeFileSync(join(ws, "README-task.md"), "# smoke\nscratch workspace\n");
  const { events, result } = await runScenario("Scenario 1: write hello.txt (L3)", {
    title: "List the files in this workspace and write a file hello.txt containing 'hi'",
    description: "List the files in the current workspace directory, then create a file named hello.txt whose entire content is the text hi (followed by a newline). Create the file with the Write tool (not a shell redirect). Register it with deliver_artifact and finish.",
    workspace: ws,
    category: "other",
    criteria: ["hello.txt exists in the workspace and contains hi"],
  });
  assert(events.some((e) => e.type === "started" && e.sessionId), "started event carries a session id");
  assert(events.some((e) => e.type === "tool_call" && e.tool === "Write"), "events include a Write tool_call");
  assert(events.some((e) => e.type === "tool_result"), "events include tool_result");
  assert(result.status === "succeeded", `result status is succeeded (got ${result.status})`);
  assert(result.structured && ["done", "partial"].includes(result.structured.status), "result.structured parses with status done/partial");
  assert(result.structured?.verification?.details, "verification.details present");
  assert(result.costUsd > 0, `cost recorded ($${result.costUsd.toFixed(4)})`);
  assert(events.some((e) => e.type === "cost" && e.costUsd > 0), "cost event emitted");
  const hello = join(ws, "hello.txt");
  assert(existsSync(hello) && readFileSync(hello, "utf8").trim() === "hi", "hello.txt contains hi");
  rmSync(ws, { recursive: true, force: true });
}

async function scenario2() {
  const ws = mkdtempSync(join(tmpdir(), "tc-smoke2-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: ws });
  execFileSync("git", ["config", "user.name", "smoke"], { cwd: ws });
  writeFileSync(join(ws, "README.md"), "# smoke repo\n");
  execFileSync("git", ["add", "."], { cwd: ws });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: ws });
  const remote = mkdtempSync(join(tmpdir(), "tc-smoke2-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: ws });
  const { events, result, approvals } = await runScenario("Scenario 2: gated git push (L3, auto-reject)", {
    title: "Publish the current commit by running `git push origin main`",
    description: "This repository has a remote named origin. Run exactly `git push origin main` with the Bash tool to publish the current commit. Do not do anything else; if the push cannot be performed, report it honestly.",
    workspace: ws,
    category: "code",
    criteria: ["The current commit is pushed to origin/main, or the reason it was not is reported"],
  });
  const pushCalls = events.filter((e) => e.type === "tool_call" && e.tool === "Bash" && /git\s+push/.test(String((e.input as { command?: string })?.command ?? "")));
  assert(pushCalls.length > 0, `agent attempted git push (${pushCalls.length} call(s))`);
  assert(approvals.created.length > 0, `gate created ${approvals.created.length} approval(s)`);
  assert(approvals.created.every((a) => a.kind === "action" && (a.payload as { tool?: string }).tool === "Bash"), "approvals carry the Bash payload");
  const pushed = (() => {
    try {
      return execFileSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/main"], { cwd: remote, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  })();
  if (autoApprove) {
    assert(pushed.length > 0, "push happened after approval");
  } else {
    assert(pushed.length === 0, "nothing was pushed to the remote");
    assert(events.some((e) => e.type === "tool_result" && e.isError && /rejected/.test(String(e.output))), "agent saw the rejection message");
    assert(result.structured && ["blocked", "needs_human", "partial"].includes(result.structured.status), `agent reported blocked/needs_human/partial (got ${result.structured?.status})`);
  }
  assert(result.costUsd > 0, `cost recorded ($${result.costUsd.toFixed(4)})`);
  rmSync(ws, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
}

const only = process.env.TC_SMOKE_ONLY;
if (!only || only === "1") await scenario1();
if (!only || only === "2") await scenario2();
console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
