# runners — executing a Run with an agent backend

`src/runners/` turns a `RunInput` (task, prompt, level, workspace, budget, gate) into a stream of
`RunEvent`s ending in a `RunResult`. The executor (engine) persists the events, applies the result to
the task/run state machine and handles retries/resume; runners never touch task status themselves.

## Files

| File | Exports | Role |
|---|---|---|
| `types.ts` | `Runner`, `RunInput`, `RunEvent`, `RunResult`, `ToolGate`, `ToolGateResult` | Contract (unchanged). |
| `result.ts` | `AGENT_OUTPUT_JSON_SCHEMA`, `AgentOutputSchema`, `parseAgentOutput`, `extractAgentOutputFromText` | Draft-07 schema for `AgentOutput` (`required: summary, status, verification`; everything else optional), lenient zod parser with defaults, and text extraction (last ```json block or last `{…}`, plus `output`/`result` wrappers). |
| `workspace.ts` | `prepareWorkspace`, `isCodeTask`, `branchNameFor` | Code tasks (`category: code` or labels `repo`/`code`) get a git worktree at `<workspace_root>/<task.id>` on branch `tc/<task.id>` created from `task.context.base_ref` → `origin/HEAD` → current `HEAD` of `config.executor.repo_root`; an existing worktree or branch is reused. Other tasks get a plain dir. Both get `README-task.md` with the brief. `cleanup()` runs `git worktree remove --force` + `prune` and **keeps the branch**; plain dirs are kept (they hold deliverables). Falls back to a plain dir when `repo_root` is not a git repo. Tested live against this repository. |
| `gate.ts` | `createToolGate`, `pendingMessage`, `ToolGateWithState` | See "Gate". |
| `taskcenter-tools.ts` | `createTaskCenterMcp`, `TASKCENTER_MCP_NAME` | In-process MCP server (`createSdkMcpServer` + `tool()` with zod shapes). See "Task Center tools". |
| `claude-sdk.ts` | `ClaudeSdkRunner`, `createClaudeSdkRunner` | Primary runner (Claude Agent SDK `query()`). |
| `claude-cli.ts` | `ClaudeCliRunner`, `buildCliRunnerArgs`, `CLI_SAFE_BASH`, `CLI_DENY_BASH` | Fallback runner (raw `claude -p` NDJSON). |
| `codex.ts` | `CodexRunner`, `buildCodexArgs` | `codex exec --json` best effort; unavailable unless `codex` is on PATH. |
| `dry.ts` | `DryRunner` | Deterministic runner for tests / `provider: dry`. |
| `registry.ts` | `createRunner`, `selectRunner`, `defaultRunnerName`, `RUNNER_NAMES` | Provider→runner mapping and availability fallback `claude-sdk → claude-cli → dry` (with a warning). |
| `util.ts` | `AsyncQueue`, `truncateOutput`, `agentEnv`, `UNGATED_TOOLS`, `errorMessage` | Shared plumbing. |

## Gate (`createToolGate`)

Every tool call goes through `policy.evaluateToolUse({level, toolName, input, workspace})`:

- `allow` → `{action:"allow"}`; `deny` → `{action:"deny", reason:"Denied by policy: …"}`.
- `approve` → `approvals.request({kind:"action", title, context (what/why, task, policy reason, input),
  recommendation, payload:{tool, input, tool_use_id}, risk, options approve/edit/reject,
  expires_at = now + expiresHours})`, a debug-level `approval_requested` event (the approval service
  records the user-facing one), then `approvals.waitForDecision(id, waitMs, signal)`:
  - approved / edited → allow; an edited payload's `input` (or the whole edited object when it has no
    `tool` key) replaces the input;
  - rejected → deny `"The human rejected this action: <note>. Do not retry it…"`;
  - expired / cancelled → deny;
  - decision `respond` (free-text answer) → deny with the response as guidance (never an implicit approve);
  - still pending after `waitMs` → deny with `pendingApprovalId` and the message
    `"Approval <id> is pending human review. Stop working on this step, record what you have done so far,
    and finish with status needs_human."`; `gate.pendingApprovalId` is set so the runner can park the run
    as `waiting_human`.
- Decisions are cached per `(tool, JSON input)` for the run and concurrent identical calls share one
  approval, so a retrying agent cannot spam the Outbox.
- `gate.approvalIds` lists every approval the gate created.

## Task Center tools (`mcp__taskcenter__*`)

`createTaskCenterMcp({repo, bus, task, run, approvals, logger, workspace})` → `{name:"taskcenter",
server, state, tools}`; put `server` into `RunInput.mcpServers.taskcenter`.

| Tool | Effect |
|---|---|
| `update_task_status({status: in_progress\|blocked\|done\|needs_human, summary?})` | `assistant_message` event with `agent_status`; sets `task.result_summary`. Never changes the lifecycle status (executor owns it). |
| `add_note({text})` | `assistant_message` event. |
| `request_approval({title, context, recommendation?, options?, risk?, kind?})` | `approvals.request()` with kind `decision` (options given, `reject` appended) or `question` (`respond`), records `approval_requested`, returns the id and tells the agent to stop with `needs_human`. Ids collected in `state.approvalIds`. |
| `deliver_artifact({type, title, path?\|url?\|content?})` | `repo.artifacts.create` (relative paths resolve against the workspace; missing files are an error) + `artifact` event. |
| `remember({facts[]})` | `recordLearned()` (dedupe + `memory` events). |

`deliver_artifact` and `request_approval` are declared with `permission_policy: "always_ask"` so they
always pass through `canUseTool`/the gate even when `mcp__taskcenter__*` is allow-listed. DB-reading
tools are plain.

## Claude Agent SDK runner (`ClaudeSdkRunner`)

`query({prompt, options})` with `cwd = workspace`, `model`, `effort`, `maxTurns`, `maxBudgetUsd`,
`systemPrompt: {type:"preset", preset:"claude_code", append, excludeDynamicSections:true}`,
`settingSources: []`, `strictMcpConfig: true`, `mcpServers` (whatever the executor passes — normally the
taskcenter server), `permissionMode: "default"`, `outputFormat: {type:"json_schema", schema}`, an
`AbortController` tied to `input.signal` + `timeoutMs`, `env = process.env` minus
`CLAUDECODE`/`CLAUDE_CODE_CHILD_SESSION` plus `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=2`,
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`, `DISABLE_TELEMETRY=1`; `resume` + `resumeMessage` when resuming.

Gating design (verified against SDK 0.3.318):

- A **PreToolUse hook with no matcher** is the universal interception point. It emits `tool_call`, runs
  the gate, and answers `permissionDecision: allow|deny` (with `updatedInput` on edited approvals). Hook
  `timeout` is `timeoutMs + 60 s` so a pending human decision cannot trip the default 600 s hook timeout.
- **Bare names from `allowedTools` are not forwarded** (only scoped rules such as `Bash(npm test *)`);
  bare entries would auto-approve calls before any callback and make the SDK warn
  `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`. `disallowedTools` is forwarded unchanged (bare names remove the tool
  from the model's context, which is what L1/L2 want).
- `canUseTool` is the safety net: anything the hook did not decide (hook failure, `always_ask` MCP
  tools, subagent paths) hits the same cached gate.
- `StructuredOutput`, `TodoWrite`, `ToolSearch`, `BashOutput`, `KillShell`, MCP resource tools are
  never gated (`UNGATED_TOOLS`); `StructuredOutput` is also not logged.
- `PostToolUse` / `PostToolUseFailure` hooks emit `tool_result` (outputs truncated to 4000 chars). A hook
  **deny never produces PostToolUse*/PostToolUseFailure**, so the runner emits a synthetic error
  `tool_result` from the hook itself.
- Hooks run while the generator is awaiting the next SDK message, so events are bridged through an
  `AsyncQueue`; the SDK loop runs as a producer task and `query.close()` is always called in `finally`.

Result mapping: `session_id` from the `init` message → `started`; assistant text blocks → `assistant`;
each `result` → `cost`. `success` → `succeeded`, unless `structured.status === "needs_human"` or the
gate parked an approval (`pendingApprovalId`) → `waiting_human`; `is_error` on success → `failed`.
Error subtypes (`error_max_turns`, `error_max_budget_usd`, `error_during_execution`,
`error_max_structured_output_retries`) → `failed` with the error text (still `waiting_human` when an
approval is pending). The structured output is read from `result.structured_output`, falling back to
JSON in the result text / last assistant text. `inputTokens` = `usage.input + cache_read + cache_creation`.
Abort/timeout → `failed` with `"run timed out"` / `"run aborted"`.

Live smoke (`npx tsx scripts/run-agent-smoke.ts`, haiku, maxTurns 8, budget $0.5):

- Scenario 1 (L3, temp dir): `ls` → `Write hello.txt` → `od -c` verification → `ToolSearch` →
  `mcp__taskcenter__deliver_artifact` → structured `done`; 8 turns, $0.011, hello.txt == "hi".
- Scenario 2 (L3, temp git repo with a bare remote, approvals auto-rejected after 1 s): the first
  `Bash git push origin main` hit the gate → approval `apr_…` (risk high) → rejected → hook deny; the agent
  did not retry, nothing reached the remote, and it finished with `status: blocked`, a `needs_human`
  question offering a `tc/` branch instead; 4 turns, $0.004.

## Claude CLI runner (`ClaudeCliRunner`) — fallback

Spawns `claude -p --output-format stream-json --verbose --model … --max-turns … --max-budget-usd …
--permission-mode default --permission-prompts none --setting-sources "" --strict-mcp-config
--append-system-prompt … --json-schema … [--effort] [--allowedTools] [--disallowedTools] [--mcp-config]
[--resume]` with the prompt on stdin and parses NDJSON (`system/init` → started, `assistant` text/tool_use
→ assistant/tool_call, `user` tool_result → tool_result, `result` → cost/result).

**Limitation:** there is no in-process gate. With `--permission-prompts none` anything not pre-allowed is
denied automatically, so sensitive actions can never be approved inline. Bare `Bash` is therefore never
allow-listed; `CLI_SAFE_BASH` (ls/cat/grep/git status|diff|log|add|commit, test runners, …) is allowed
and `CLI_DENY_BASH` (git push, rm -rf, sudo, gh pr create, curl/wget, publish/deploy commands, …) is
denied outright. In-process (`type: "sdk"`) MCP servers cannot be attached to a child process, so the
taskcenter tools are unavailable here; stdio/http/sse configs are forwarded via `--mcp-config`.

## Codex runner (`CodexRunner`)

`codex exec --json -C <workspace> --sandbox read-only|workspace-write (L3+) --output-schema <file>
--output-last-message <file> --skip-git-repo-check [-m model] [-c model_reasoning_effort=…]`
(`resume <id>` when resuming; extra flags via `TC_CODEX_ARGS`). Maps `thread.started` → started,
`item.*` (`agent_message`, `command_execution`, `file_change`, `mcp_tool_call`, `error`) → assistant /
tool_call / tool_result, `turn.completed.usage` → cost (no USD figure), `turn.failed` → error. The final
message file is parsed as AgentOutput. No gate, no taskcenter tools, no inline approvals (the Codex
sandbox blocks instead). `codex` is not installed here, so `available()` is false and the registry falls
back.

## Dry runner (`DryRunner`)

Emits started → assistant → `Read` tool_call/result (through the gate) → optional scripted steps →
cost → result. `task.context.dry` scripts it: `{fail:true, error?}`, `{needsApproval:"Bash git push
origin main"}` (calls the gate; pending → `waiting_human` + `pendingApprovalId`, rejected → structured
`blocked`), `{writeFile:"hello.txt"}` (gated Write; denied at L1/L2), `{status, summary, artifacts,
learned, followUps, delayMs}`.

## Tests

`tests/runners.test.ts` (19 tests: result parsing, gate with `FakeApprovals`, taskcenter tools via their
handlers, dry runner, registry, CLI/Codex arg builders, utils) and `tests/runners-workspace.test.ts`
(live worktree create/reuse/cleanup in this repo; test branches are deleted afterwards).

## SDK gotchas hit while building this

1. `allowedTools` bare names bypass `canUseTool` (warning `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`); use the
   PreToolUse hook and forward only scoped rules.
2. A PreToolUse deny fires no PostToolUse/PostToolUseFailure; log the denial from the hook.
3. The model discovers MCP tools through a `ToolSearch` call (deferred tools); it must not be gated or the
   taskcenter tools become unreachable at L1/L2 (not in the allow list).
4. `env` replaces the subprocess env; always spread `process.env` (minus the nested-session markers) or the
   CLI cannot find its login.
5. The single-shot `query()` throws after an error result; the result is captured inside the loop first.
6. Hook timeouts are seconds (not ms) and default to 600 s; a human approval wait must be shorter than the
   hook timeout or the call is blocked without our pending message.
7. Scratch scripts run with `tsx` outside a `"type": "module"` package must use `.mts` to allow top-level
   `await`.
