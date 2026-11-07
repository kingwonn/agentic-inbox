import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildCliRunnerArgs, CLI_DENY_BASH, ClaudeCliRunner } from "../src/runners/claude-cli.js";
import { ClaudeSdkRunner } from "../src/runners/claude-sdk.js";
import { buildCodexArgs, CodexRunner } from "../src/runners/codex.js";
import { DryRunner } from "../src/runners/dry.js";
import { createToolGate, pendingMessage } from "../src/runners/gate.js";
import { createRunner, defaultRunnerName, selectRunner } from "../src/runners/registry.js";
import { AGENT_OUTPUT_JSON_SCHEMA, extractAgentOutputFromText, parseAgentOutput } from "../src/runners/result.js";
import { createTaskCenterMcp } from "../src/runners/taskcenter-tools.js";
import type { RunEvent, RunInput, RunResult } from "../src/runners/types.js";
import { AsyncQueue, truncateOutput, agentEnv, isSessionNotFoundError } from "../src/runners/util.js";
import { cfg, FakeApprovals, mem, policy, task } from "./brain-helpers.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tc-runners-"));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function setup(level: 1 | 2 | 3 | 4 | 5 = 3, over: Partial<Parameters<typeof task>[0]> = {}) {
  const { repo, bus, logger } = mem();
  const { id: _id, created_at: _c, updated_at: _u, ...rest } = task(over);
  const t = repo.tasks.create({ ...rest, level });
  const run = repo.runs.create({ task_id: t.id, runner: "dry", model: "haiku" });
  const approvals = new FakeApprovals(repo);
  const workspace = tmp();
  const gate = createToolGate({ policy: policy(), level, task: t, run, workspace, approvals, bus, waitMs: 50, expiresHours: 72, signal: new AbortController().signal, logger });
  return { repo, bus, logger, task: t, run, approvals, workspace, gate };
}

async function collect(it: AsyncIterable<RunEvent>): Promise<{ events: RunEvent[]; result: RunResult }> {
  const events: RunEvent[] = [];
  for await (const e of it) events.push(e);
  const r = events.find((e) => e.type === "result") as { type: "result"; result: RunResult } | undefined;
  if (!r) throw new Error("no result event");
  return { events, result: r.result };
}

function runInput(s: ReturnType<typeof setup>, over: Partial<RunInput> = {}): RunInput {
  return {
    task: s.task,
    run: s.run,
    level: s.task.level,
    prompt: "do it",
    systemPromptAppend: "rules",
    workspace: s.workspace,
    model: "haiku",
    maxTurns: 5,
    timeoutMs: 10_000,
    budgetUsd: 0.1,
    allowedTools: policy().toolsForLevel(s.task.level).allow,
    disallowedTools: policy().toolsForLevel(s.task.level).deny,
    outputSchema: AGENT_OUTPUT_JSON_SCHEMA,
    gate: s.gate,
    signal: new AbortController().signal,
    logger: s.logger,
    ...over,
  };
}

describe("result parsing", () => {
  it("exposes a draft-07 schema matching AgentOutput", () => {
    expect(AGENT_OUTPUT_JSON_SCHEMA.$schema).toContain("draft-07");
    const props = AGENT_OUTPUT_JSON_SCHEMA.properties as Record<string, unknown>;
    for (const k of ["summary", "status", "artifacts", "verification", "follow_ups", "needs_human", "learned"]) expect(props[k]).toBeDefined();
    expect(AGENT_OUTPUT_JSON_SCHEMA.required).toEqual(["summary", "status", "verification"]);
  });

  it("parses leniently with defaults", () => {
    const out = parseAgentOutput({ summary: "did it", status: "weird", artifacts: [{ type: "nope", title: "x" }, "junk"], verification: "yes", follow_ups: "n/a" })!;
    expect(out.status).toBe("partial");
    expect(out.artifacts[0].type).toBe("text");
    expect(out.verification).toEqual({ passed: false, details: "" });
    expect(out.follow_ups).toEqual([]);
    expect(out.needs_human).toBeNull();
    expect(parseAgentOutput({ unrelated: 1 })).toBeUndefined();
    expect(parseAgentOutput("str")).toBeUndefined();
    const nh = parseAgentOutput({ summary: "need input", status: "needs_human" })!;
    expect(nh.needs_human?.question).toBe("need input");
    const full = parseAgentOutput({ summary: "s", status: "done", artifacts: [{ type: "file", title: "f", path: "/p" }], verification: { passed: true, details: "ran tests" }, follow_ups: ["a"], learned: ["x"] })!;
    expect(full.learned).toEqual(["x"]);
    expect(full.artifacts[0].path).toBe("/p");
  });

  it("extracts from fenced blocks, trailing objects and wrappers", () => {
    const text = 'I did things.\n```json\n{"summary":"ok","status":"done","verification":{"passed":true,"details":"d"}}\n```\nthanks';
    expect(extractAgentOutputFromText(text)?.status).toBe("done");
    expect(extractAgentOutputFromText('prose {"a":1} and then {"summary":"x","status":"blocked","verification":{"passed":false,"details":""}}')?.status).toBe("blocked");
    expect(extractAgentOutputFromText('{"output": {"summary":"w","status":"partial"}}')?.summary).toBe("w");
    expect(extractAgentOutputFromText("nothing here")).toBeUndefined();
    expect(extractAgentOutputFromText("")).toBeUndefined();
  });
});

describe("tool gate", () => {
  it("allows policy-permitted tools and denies level-forbidden ones without approvals", async () => {
    const s = setup(2);
    const r = await s.gate({ tool: "Read", input: { file_path: "/etc/hosts" } });
    expect(r.action).toBe("allow");
    const w = await s.gate({ tool: "Write", input: { file_path: join(s.workspace, "a.txt"), content: "x" } });
    expect(w.action).toBe("deny");
    expect(w.reason).toContain("Denied by policy");
    expect(s.approvals.requested.length).toBe(0);
    const mk = await s.gate({ tool: "Bash", input: { command: "mkfs.ext4 /dev/sda" } });
    expect(mk.action).toBe("deny");
  });

  it("creates an approval for git push, allows when approved and caches identical calls", async () => {
    const s = setup(3);
    s.approvals.mode = "approve";
    const call = { tool: "Bash", input: { command: "git push origin main" }, toolUseId: "tu1" };
    const r = await s.gate(call);
    expect(r.action).toBe("allow");
    expect(r.reason).toContain("approved");
    expect(s.approvals.requested.length).toBe(1);
    const a = s.approvals.requested[0];
    expect(a.kind).toBe("action");
    expect(a.task_id).toBe(s.task.id);
    expect(a.run_id).toBe(s.run.id);
    expect(a.risk).toBe("high");
    expect(a.payload).toMatchObject({ tool: "Bash", input: { command: "git push origin main" } });
    expect(a.options.map((o) => o.value)).toEqual(["approve", "edit", "reject"]);
    expect(a.expires_at).toBeTruthy();
    expect(s.repo.events.list({ type: "approval_requested" }).length).toBe(1);
    const again = await s.gate(call);
    expect(again.action).toBe("allow");
    expect(s.approvals.requested.length).toBe(1);
    expect(s.approvals.waits).toBe(1);
    // concurrent identical calls share one approval
    const s2 = setup(3);
    await Promise.all([s2.gate(call), s2.gate(call)]);
    expect(s2.approvals.requested.length).toBe(1);
  });

  it("returns the edited input when the human edits", async () => {
    const s = setup(4);
    s.approvals.mode = "edit";
    s.approvals.editedPayload = { tool: "Bash", input: { command: "git push origin tc/safe" } };
    const r = await s.gate({ tool: "Bash", input: { command: "git push origin main" } });
    expect(r.action).toBe("allow");
    expect(r.action === "allow" && r.input).toEqual({ command: "git push origin tc/safe" });
    const s3 = setup(4);
    s3.approvals.mode = "edit";
    s3.approvals.editedPayload = { command: "rm -rf build" };
    const r3 = await s3.gate({ tool: "Bash", input: { command: "rm -rf /" } });
    expect(r3.action === "allow" && r3.input).toEqual({ command: "rm -rf build" });
  });

  it("denies with the note when rejected, and with pendingApprovalId on timeout", async () => {
    const s = setup(3);
    s.approvals.mode = "reject";
    s.approvals.note = "wrong branch";
    const r = await s.gate({ tool: "Bash", input: { command: "git push origin main" } });
    expect(r.action).toBe("deny");
    expect(r.reason).toContain("The human rejected this action: wrong branch");
    expect(s.gate.pendingApprovalId).toBeUndefined();

    const p = setup(3);
    p.approvals.mode = "pending";
    const pr = await p.gate({ tool: "Bash", input: { command: "git push origin main" } });
    expect(pr.action).toBe("deny");
    expect(pr.action === "deny" && pr.pendingApprovalId).toBe(p.approvals.requested[0].id);
    expect(pr.reason).toBe(pendingMessage(p.approvals.requested[0].id));
    expect(p.gate.pendingApprovalId).toBe(p.approvals.requested[0].id);
    expect(p.gate.approvalIds).toEqual([p.approvals.requested[0].id]);

    const e = setup(3);
    e.approvals.mode = "expired";
    expect((await e.gate({ tool: "Bash", input: { command: "sudo ls" } })).reason).toContain("expired");
  });

  it("treats respond decisions as guidance, not approval", async () => {
    const s = setup(3);
    s.approvals.mode = "respond";
    s.approvals.note = "push to tc/ instead";
    const r = await s.gate({ tool: "Bash", input: { command: "git push origin main" } });
    expect(r.action).toBe("deny");
    expect(r.reason).toContain("responded");
    expect(r.reason).toContain("push to tc/ instead");
  });

  it("gates writes outside the workspace and pre-authorises L5 tc/ pushes", async () => {
    const s = setup(3);
    s.approvals.mode = "pending";
    const out = await s.gate({ tool: "Write", input: { file_path: "/etc/motd", content: "x" } });
    expect(out.action).toBe("deny");
    expect(s.approvals.requested[0].risk).toBe("medium");
    const inside = await s.gate({ tool: "Write", input: { file_path: join(s.workspace, "ok.txt"), content: "x" } });
    expect(inside.action).toBe("allow");
    const l5 = setup(5);
    expect((await l5.gate({ tool: "Bash", input: { command: "git push -u origin tc/abc" } })).action).toBe("allow");
    expect(l5.approvals.requested.length).toBe(0);
  });

  it("applies the decision a resume run carries to exactly the decided call instead of asking again", async () => {
    const decided = (decision: string, extra: Record<string, unknown> = {}) =>
      setup(4, { context: { pending_resume: { resume: { approvalId: "apr_prev", decision, action: { tool: "Bash", input: { command: "git push origin main" } }, ...extra } } } });
    const push = { tool: "Bash", input: { command: "git push origin main", description: "Push the branch" } };

    const a = decided("approve");
    a.approvals.mode = "pending";
    const ok = await a.gate(push);
    expect(ok.action).toBe("allow");
    expect(ok.reason).toContain("approved earlier by the human (approval apr_prev");
    expect(a.approvals.requested.length).toBe(0);
    expect(a.repo.events.list({ type: "approval_decided" })[0].payload).toMatchObject({ approval_id: "apr_prev", source: "gate_resume", action: "allow" });
    // any other call still goes through a new approval
    const other = await a.gate({ tool: "Bash", input: { command: "git push --force origin main" } });
    expect(other.action === "deny" && other.pendingApprovalId).toBe(a.approvals.requested[0].id);

    const e = decided("edit", { editedPayload: { tool: "Bash", input: { command: "git push origin tc/safe" } } });
    const edited = await e.gate(push);
    expect(edited.action === "allow" && edited.input).toEqual({ command: "git push origin tc/safe" });
    expect((await e.gate({ tool: "Bash", input: { command: "git push origin tc/safe" } })).action).toBe("allow");
    expect(e.approvals.requested.length).toBe(0);

    const r = decided("reject", { note: "not today" });
    const no = await r.gate(push);
    expect(no.action).toBe("deny");
    expect(no.reason).toContain("The human rejected this action (approval apr_prev): not today");
    expect(r.approvals.requested.length).toBe(0);

    // policy deny still wins over an earlier approval
    const d = setup(4, { context: { pending_resume: { resume: { approvalId: "apr_prev", decision: "approve", action: { tool: "Bash", input: { command: "mkfs.ext4 /dev/sda" } } } } } });
    expect((await d.gate({ tool: "Bash", input: { command: "mkfs.ext4 /dev/sda" } })).action).toBe("deny");
  });
});

describe("taskcenter MCP tools", () => {
  function tools() {
    const s = setup(3);
    const mcp = createTaskCenterMcp({ repo: s.repo, bus: s.bus, task: s.task, run: s.run, approvals: s.approvals, logger: s.logger, workspace: s.workspace });
    const by = Object.fromEntries(mcp.tools.map((t) => [t.name, t.handler]));
    return { ...s, mcp, by };
  }

  it("exposes five tools with always_ask policies for the sensitive ones", () => {
    const { mcp } = tools();
    expect(mcp.name).toBe("taskcenter");
    expect(mcp.tools.map((t) => t.name).sort()).toEqual(["add_note", "deliver_artifact", "remember", "request_approval", "update_task_status"]);
    const server = mcp.server as { type: string; name: string; instance: unknown; tools: Array<{ name: string; permission_policy: string }> };
    expect(server.type).toBe("sdk");
    expect(server.instance).toBeTruthy();
    expect(server.tools.map((t) => `${t.name}:${t.permission_policy}`).sort()).toEqual(["deliver_artifact:always_ask", "request_approval:always_ask"]);
  });

  it("records status, notes, artifacts, approvals and memories", async () => {
    const { by, repo, task: t, approvals, workspace, mcp } = tools();
    const r1 = await by.update_task_status({ status: "in_progress", summary: "started" });
    expect(r1.content[0].text).toContain("in_progress");
    expect(repo.tasks.get(t.id)?.result_summary).toBe("started");
    expect(mcp.state.lastStatus).toBe("in_progress");
    await by.add_note({ text: "found the bug" });
    const msgs = repo.events.list({ task_id: t.id, type: "assistant_message" });
    expect(msgs.length).toBe(2);

    const r2 = await by.request_approval({ title: "Which DB?", context: "sqlite vs postgres", options: ["sqlite", "postgres"], risk: "low" });
    expect(r2.content[0].text).toContain("needs_human");
    expect(approvals.requested.length).toBe(1);
    expect(approvals.requested[0].kind).toBe("decision");
    expect(approvals.requested[0].options.map((o) => o.value)).toEqual(["sqlite", "postgres", "reject"]);
    expect(mcp.state.approvalIds).toEqual([approvals.requested[0].id]);
    const q = await by.request_approval({ title: "Free question", context: "what?" });
    expect(q.content[0].text).toContain("question");
    expect(approvals.requested[1].options[0].value).toBe("respond");

    writeFileSync(join(workspace, "out.md"), "# hi");
    const r3 = await by.deliver_artifact({ type: "document", title: "Report", path: "out.md" });
    expect(r3.content[0].text).toContain("registered");
    const arts = repo.artifacts.listByTask(t.id);
    expect(arts.length).toBe(1);
    expect(arts[0].path).toBe(join(workspace, "out.md"));
    expect(arts[0].size).toBe(4);
    const bad = await by.deliver_artifact({ type: "file", title: "missing", path: "nope.txt" });
    expect(bad.isError).toBe(true);
    const none = await by.deliver_artifact({ type: "text", title: "empty" });
    expect(none.isError).toBe(true);
    await by.deliver_artifact({ type: "url", title: "PR", url: "https://example.com/pr/1" });
    expect(repo.events.list({ task_id: t.id, type: "artifact" }).length).toBe(2);

    const r4 = await by.remember({ facts: ["The user deploys with wrangler", "The user deploys with wrangler"] });
    expect(r4.content[0].text).toContain("remembered 1");
    expect(repo.memories.active().length).toBe(1);
  });
});

describe("dry runner", () => {
  it("emits a full event sequence and a parsable result", async () => {
    const s = setup(3, { context: { dry: { writeFile: "hello.txt", learned: ["fact one"] } } });
    const { events, result } = await collect(new DryRunner().run(runInput(s)));
    expect(events[0].type).toBe("started");
    expect(events.filter((e) => e.type === "tool_call").map((e) => (e as { tool: string }).tool)).toEqual(["Read", "Write"]);
    expect(events.some((e) => e.type === "cost")).toBe(true);
    expect(result.status).toBe("succeeded");
    expect(result.structured?.status).toBe("done");
    expect(result.structured?.learned).toEqual(["fact one"]);
    expect(readFileSync(join(s.workspace, "hello.txt"), "utf8")).toBe("hi\n");
    expect(parseAgentOutput(JSON.parse(result.text))).toBeTruthy();
  });

  it("fails, blocks on rejection and parks on pending approvals", async () => {
    const f = setup(3, { context: { dry: { fail: true, error: "boom" } } });
    const fr = await collect(new DryRunner().run(runInput(f)));
    expect(fr.result.status).toBe("failed");
    expect(fr.result.error).toBe("boom");

    const r = setup(3, { context: { dry: { needsApproval: "Bash git push origin main" } } });
    r.approvals.mode = "reject";
    const rr = await collect(new DryRunner().run(runInput(r)));
    expect(rr.result.status).toBe("succeeded");
    expect(rr.result.structured?.status).toBe("blocked");
    expect(r.approvals.requested.length).toBe(1);

    const p = setup(3, { context: { dry: { needsApproval: "Bash git push origin main" } } });
    p.approvals.mode = "pending";
    const pr = await collect(new DryRunner().run(runInput(p)));
    expect(pr.result.status).toBe("waiting_human");
    expect(pr.result.pendingApprovalId).toBe(p.approvals.requested[0].id);
    expect(pr.result.structured?.status).toBe("needs_human");

    const w = setup(2, { context: { dry: { writeFile: "x.txt" } } });
    const wr = await collect(new DryRunner().run(runInput(w)));
    expect(wr.result.structured?.status).toBe("blocked");
    expect(existsSync(join(w.workspace, "x.txt"))).toBe(false);
  });

  it("reports a missing session on resume runs only", async () => {
    const s = setup(3, { context: { dry: { sessionMissing: true } } });
    const resumed = await collect(new DryRunner().run(runInput(s, { resumeSessionId: "sess-gone", resumeMessage: "go on" })));
    expect(resumed.result).toMatchObject({ status: "failed", sessionNotFound: true });
    expect(resumed.result.sessionId).toBeUndefined();
    expect(resumed.events.some((e) => e.type === "started" || e.type === "error")).toBe(false);
    const fresh = await collect(new DryRunner().run(runInput(s)));
    expect(fresh.result.status).toBe("succeeded");
    expect(fresh.result.sessionNotFound).toBeUndefined();
  });
});

describe("registry", () => {
  const { logger } = mem();
  it("creates runners by name and maps provider to runner", async () => {
    expect(createRunner("dry", { config: cfg(), logger }).name).toBe("dry");
    expect(createRunner("claude-sdk", { config: cfg(), logger }).name).toBe("claude-sdk");
    expect(createRunner("claude-cli", { config: cfg(), logger }).name).toBe("claude-cli");
    expect(createRunner("codex", { config: cfg(), logger }).name).toBe("codex");
    expect(() => createRunner("nope", { config: cfg(), logger })).toThrow();
    expect(defaultRunnerName(cfg({ brain: { provider: "claude-cli" } }))).toBe("claude-cli");
    expect(defaultRunnerName(cfg({ brain: { provider: "anthropic-api" } }))).toBe("claude-sdk");
    expect((await selectRunner(cfg({ brain: { provider: "dry" } }), logger)).name).toBe("dry");
    expect((await selectRunner(cfg(), logger, "dry")).name).toBe("dry");
  });

  it("falls back when the requested runner is unavailable", async () => {
    const codex = new CodexRunner({ bin: "codex-definitely-missing" });
    expect((await codex.available()).ok).toBe(false);
    const picked = await selectRunner(cfg({ brain: { provider: "claude-sdk" } }), logger, "codex");
    expect(picked.name).not.toBe("codex");
    expect(["claude-sdk", "claude-cli", "dry"]).toContain(picked.name);
    expect((await new ClaudeSdkRunner().available()).ok).toBe(true);
    expect((await new ClaudeCliRunner({ bin: "claude-definitely-missing" }).available()).ok).toBe(false);
  });
});

describe("claude-cli runner args", () => {
  it("replaces bare Bash with safe prefixes and denies dangerous commands", () => {
    const s = setup(3);
    const { args, allowed, disallowed } = buildCliRunnerArgs(runInput(s, { effort: "low", mcpServers: { taskcenter: { type: "sdk", name: "taskcenter", instance: {} }, ext: { type: "stdio", command: "x" } } }));
    expect(allowed).not.toContain("Bash");
    expect(allowed).toContain("Bash(git status*)");
    expect(allowed).toContain("Read");
    expect(disallowed).toEqual(expect.arrayContaining(CLI_DENY_BASH));
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]).required).toEqual(["summary", "status", "verification"]);
    const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    expect(Object.keys(mcp.mcpServers)).toEqual(["ext"]);
    expect(args).not.toContain("--dangerously-skip-permissions");
    const resumed = buildCliRunnerArgs(runInput(setup(2), { resumeSessionId: "sess-1" }));
    expect(resumed.args[resumed.args.indexOf("--resume") + 1]).toBe("sess-1");
    expect(resumed.allowed).not.toContain("Write");
  });
});

describe("codex runner args", () => {
  it("builds exec args with sandbox by level", () => {
    const s = setup(2);
    const args = buildCodexArgs(runInput(s, { model: "gpt-5-codex", effort: "xhigh" }), { schema: "/s.json", lastMessage: "/l.md" });
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5-codex");
    expect(args).toContain('model_reasoning_effort="high"');
    const l4 = buildCodexArgs(runInput(setup(4), { model: "haiku" }), { schema: "/s.json", lastMessage: "/l.md" });
    expect(l4[l4.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(l4).not.toContain("-m");
    // `resume` is exec's subcommand: options first, then `resume <id> -` (prompt on stdin)
    const resumed = buildCodexArgs(runInput(setup(4), { resumeSessionId: "sess-1" }), { schema: "/s.json", lastMessage: "/l.md" });
    expect(resumed[0]).toBe("exec");
    expect(resumed.slice(-3)).toEqual(["resume", "sess-1", "-"]);
  });
});

/**
 * A fake agent CLI that replays the output observed for a resume of an unknown session
 * (claude 2.1.319: error result + stderr line, exit 1; codex 0.167: stderr only, exit 1).
 */
function fakeBin(name: string, stdout: string, stderr: string): { bin: string; args: () => string } {
  const dir = tmp();
  const bin = join(dir, name);
  const argsFile = join(dir, "args.txt");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '%s' '${stdout}'\necho '${stderr}' >&2\nexit 1\n`);
  chmodSync(bin, 0o755);
  return { bin, args: () => readFileSync(argsFile, "utf8") };
}

const CLAUDE_NOT_FOUND = '{"type":"result","subtype":"error_during_execution","duration_ms":0,"is_error":true,"num_turns":0,"stop_reason":null,"session_id":"sess-1","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"errors":["No conversation found with session ID: sess-1"]}\n';

describe("resume of a session that does not exist here", () => {
  it("recognises the Claude and Codex not-found errors only", () => {
    expect(isSessionNotFoundError("error_during_execution: No conversation found with session ID: 1b4c1f0e")).toBe(true);
    expect(isSessionNotFoundError(undefined, "Error: thread/resume: thread/resume failed: no rollout found for thread id 1b4c (code -32600)")).toBe(true);
    expect(isSessionNotFoundError("error_max_turns", "file not found", undefined)).toBe(false);
  });

  it("claude-cli: reports sessionNotFound instead of an error, and only for resume runs", async () => {
    const fake = fakeBin("claude", CLAUDE_NOT_FOUND, "No conversation found with session ID: sess-1");
    const s = setup(3);
    const r = await collect(new ClaudeCliRunner({ bin: fake.bin }).run(runInput(s, { resumeSessionId: "sess-1", resumeMessage: "go on" })));
    expect(fake.args()).toContain("--resume\nsess-1");
    expect(r.result).toMatchObject({ status: "failed", sessionNotFound: true });
    expect(r.result.sessionId).toBeUndefined();
    expect(r.events.some((e) => e.type === "error")).toBe(false);
    expect(r.events.some((e) => e.type === "progress")).toBe(true);
    const plain = await collect(new ClaudeCliRunner({ bin: fake.bin }).run(runInput(s)));
    expect(plain.result.sessionNotFound).toBeUndefined();
    expect(plain.events.some((e) => e.type === "error")).toBe(true);
  });

  it("claude-sdk: reports sessionNotFound from the SDK's error result", async () => {
    const fake = fakeBin("claude", CLAUDE_NOT_FOUND, "No conversation found with session ID: sess-1");
    const r = await collect(new ClaudeSdkRunner({ pathToClaudeCodeExecutable: fake.bin }).run(runInput(setup(3), { resumeSessionId: "sess-1", resumeMessage: "go on" })));
    expect(fake.args()).toContain("--resume=sess-1");
    expect(r.result).toMatchObject({ status: "failed", sessionNotFound: true });
    expect(r.events.some((e) => e.type === "error")).toBe(false);
  });

  it("codex: reports sessionNotFound for `no rollout found`", async () => {
    const fake = fakeBin("codex", "", "Error: thread/resume: thread/resume failed: no rollout found for thread id sess-1 (code -32600)");
    const r = await collect(new CodexRunner({ bin: fake.bin }).run(runInput(setup(3), { resumeSessionId: "sess-1", resumeMessage: "go on" })));
    expect(fake.args().trim().split("\n").slice(-3)).toEqual(["resume", "sess-1", "-"]);
    expect(r.result).toMatchObject({ status: "failed", sessionNotFound: true });
  });
});

describe("runner utils", () => {
  it("AsyncQueue bridges pushes to iteration and closes", async () => {
    const q = new AsyncQueue<number>();
    const seen: number[] = [];
    const consumer = (async () => {
      for await (const n of q) seen.push(n);
    })();
    q.push(1);
    await new Promise((r) => setTimeout(r, 5));
    q.push(2);
    q.close();
    q.push(3);
    await consumer;
    expect(seen).toEqual([1, 2]);
  });

  it("truncates outputs and prepares env", () => {
    expect(truncateOutput("a".repeat(5000)) as string).toHaveLength(4000 + "…[+1000 chars]".length);
    expect(truncateOutput({ a: 1 })).toEqual({ a: 1 });
    const env = agentEnv();
    expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe("2");
    expect(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe("1");
    expect(env.CLAUDECODE).toBeUndefined();
  });
});
