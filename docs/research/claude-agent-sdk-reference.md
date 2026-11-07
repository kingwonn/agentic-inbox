# Claude Agent SDK (TypeScript) + headless `claude -p` — orchestrator reference

**Verified against:** `@anthropic-ai/claude-agent-sdk` **0.3.318** (bundles Claude Code **2.1.318**; `engines.node >=18.14.0`), `claude-agent-sdk` (Python) **0.2.178** (`requires_python >=3.10`), and the official docs at `code.claude.com/docs/en/agent-sdk/*` and `code.claude.com/docs/en/headless`, fetched 2026-11-05. Items marked **[unverified]** could not be confirmed from docs or the published bundle. The `platform.claude.com/docs/en/agent-sdk/*` URLs now redirect to a SPA shell; `code.claude.com` is the canonical host.

Repo note: this project pins `zod ^3.25.76`; the SDK declares `peerDependencies: { zod: "^4.0.0", "@anthropic-ai/sdk": ">=0.93.0", "@modelcontextprotocol/sdk": "^1.29.0" }` (not marked optional). Expect an npm `ERESOLVE` on install. The root entry *inlines its own* zod/MCP copies and `tool()` accepts Zod 3 or 4 schemas, so `--legacy-peer-deps`, upgrading to zod 4, or importing from `zod/v4` (shipped inside zod 3.25) all work. Do not import both `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/claude-agent-sdk/core` in one process.

---

## 1. `query()` API

```ts
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

function query(args: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query;
// Query extends AsyncGenerator<SDKMessage, void> and adds interrupt(), close(),
// setPermissionMode(), setModel(), setMcpServers(), streamInput(), getContextUsage(), ...
```

**Exact `Options` names** (subset relevant to an orchestrator; defaults in parentheses):

| Option | Type / default | Notes |
|---|---|---|
| `cwd` | `string` (`process.cwd()`) | Working dir of the subprocess; also keys the on-disk session store (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`). |
| `allowedTools` | `string[]` (`[]`) | Pre-approves calls. Does **not** restrict Claude to these tools. Supports rule syntax: `"Bash(git diff *)"`, `"mcp__taskcenter__*"`. |
| `disallowedTools` | `string[]` (`[]`) | Bare name (`"Bash"`) removes the tool from context; scoped rule (`"Bash(rm *)"`) denies matching calls in every mode incl. `bypassPermissions`. |
| `tools` | `string[] \| { type: 'preset', preset: 'claude_code' }` | Availability layer. `tools: []` strips all built-ins so only your MCP tools exist. |
| `permissionMode` | `'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan' \| 'dontAsk' \| 'auto'` (`'default'`) | `bypassPermissions` also requires `allowDangerouslySkipPermissions: true` and refuses to start as root. |
| `canUseTool` | `CanUseTool` | Called only when the permission flow falls through to a prompt (see §2). |
| `permissionPrompts` | `'host' \| 'none'` (`'host'`) | `'none'` denies anything that would prompt instead of calling `canUseTool`. |
| `maxTurns` | `number` (no limit) | Ends with `subtype: "error_max_turns"`. |
| `maxBudgetUsd` | `number` (no limit) | Client-side estimate; can overshoot by one response + running subagents. Ends with `error_max_budget_usd`. |
| `systemPrompt` | `string \| string[] \| { type:'custom', prompt, snapshot? } \| { type:'preset', preset:'claude_code', append?, excludeDynamicSections?, snapshot? }` (minimal prompt) | There is no separate `appendSystemPrompt` option; use the preset object's `append`. |
| `model` / `fallbackModel` | `string` | Alias (`haiku`, `sonnet`, `opus`, `fable`) or full ID. `fallbackModel` accepts a comma-separated chain. |
| `effort` | `'low'\|'medium'\|'high'\|'xhigh'\|'max'` | |
| `thinking` | `{type:'adaptive', display?} \| {type:'enabled', budgetTokens?} \| {type:'disabled'}` (`adaptive`) | `maxThinkingTokens` is deprecated. |
| `mcpServers` | `Record<string, McpServerConfig>` (`{}`) | Values: stdio/SSE/HTTP configs, or the object returned by `createSdkMcpServer()`. |
| `strictMcpConfig` | `boolean` (`false`) | Ignore `.mcp.json`, user settings, plugin and claude.ai-connector servers. |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | See §3. |
| `settingSources` | `('user'\|'project'\|'local')[]` (all three) | `[]` disables filesystem settings, hooks from `settings.json`, skills, and CLAUDE.md. CLAUDE.md loading is governed by this, not by the preset. |
| `resume` / `continue` / `forkSession` / `sessionId` / `resumeSessionAt` | | `resume` takes a session ID; `continue: true` picks the most recent session in `cwd`; `sessionId` must be a UUID. |
| `persistSession` | `boolean` (`true`) | `false` = in-memory only, cannot resume. |
| `abortController` | `AbortController` | The signal is passed to `child_process.spawn`; aborting terminates the subprocess. |
| `env` | `Record<string,string>` (`process.env`) | **Replaces** the subprocess env — always spread `process.env`. |
| `pathToClaudeCodeExecutable` | `string` (bundled native binary) | Only needed when optional deps were skipped (`npm ci --omit=optional`) or for `bun build --compile`. |
| `executable` / `executableArgs` | `'node'\|'bun'\|'deno'` | Auto-detected. |
| `outputFormat` | `{ type:'json_schema', schema }` | See §5. |
| `includePartialMessages` | `boolean` (`false`) | Emits `stream_event` messages (token deltas). |
| `stderr` | `(data: string) => void` | Capture CLI stderr. |
| `agents` | `Record<string, AgentDefinition>` | Programmatic subagents; each can set `model`, `effort`, `maxTurns`, `tools`. |
| `betas` | `SdkBeta[]` (`[]`) | Currently `"context-1m-2025-08-07"`. |

**Message stream** (`SDKMessage` union; discriminate on `type`, then `subtype`):

| `type` | Key fields |
|---|---|
| `system` / `subtype: "init"` | `session_id`, `model`, `tools[]`, `mcp_servers[{name,status}]`, `permissionMode`, `apiKeySource` (`"ANTHROPIC_API_KEY" \| "apiKeyHelper" \| "/login managed key" \| "none"`), `claude_code_version`, `capabilities[]`, `plugin_errors?` |
| `assistant` | `message: BetaMessage` (`id`, `content[]`, `stop_reason`, `usage`), `parent_tool_use_id`, `agent_id?`, `error?` (`'rate_limit'`, `'overloaded'`, `'authentication_failed'`, `'billing_error'`, `'model_not_found'`, …) |
| `user` | tool results: `message.content[]` with `tool_result` blocks, `tool_use_result` (structured) |
| `stream_event` | only with `includePartialMessages` |
| `system` / `"status"`, `"api_retry"`, `"permission_denied"`, `"compact_boundary"`, … | diagnostics |
| `result` | see below |

`SDKResultMessage` (always last; present on success *and* error):

```ts
type SDKResultMessage =
  | { type: "result"; subtype: "success"; session_id: string; result: string;
      is_error: boolean; stop_reason: string | null; num_turns: number;
      duration_ms: number; duration_api_ms: number; total_cost_usd: number;
      usage: NonNullableUsage; modelUsage: Record<string, ModelUsage>;
      permission_denials: { tool_name; tool_use_id; tool_input }[];
      structured_output?: unknown; deferred_tool_use?: { id; name; input };
      terminal_reason?: "completed" | "max_turns" | "tool_deferred" | "aborted_streaming" |
                        "aborted_tools" | "api_error" | "budget_exhausted" | ...;
      api_error_status?: number | null; uuid: string; /* ... */ }
  | { type: "result"; subtype: "error_max_turns" | "error_during_execution" |
      "error_max_budget_usd" | "error_max_structured_output_retries";
      session_id; is_error; num_turns; total_cost_usd; usage; modelUsage;
      permission_denials; errors: string[]; stop_reason; terminal_reason?; /* ... */ };
```

- `session_id` is on the `init` message (first) and on every `result`. Capture it from `init` so you can resume even if the process dies mid-run.
- `total_cost_usd` and `modelUsage` cover the whole tree (subagents, compaction); `usage` covers only the main loop. Resumed sessions carry forward earlier spend, so read the *latest* result rather than summing.
- `success` with `is_error: true` happens on `stop_reason: "refusal"` or an API error on the last turn; check `stop_reason`/`terminal_reason`/`api_error_status`.
- **Single-shot `query()` throws after yielding an error result** (e.g. `error_max_turns`). Wrap the loop in try/catch and capture the result inside the loop.

```ts
let sessionId: string | undefined, cost = 0, finalText = "";
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 20 * 60_000);
try {
  for await (const m of query({ prompt, options: { cwd, abortController: ac, maxTurns: 40, maxBudgetUsd: 3 } })) {
    if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
    if (m.type === "result") { cost = m.total_cost_usd; if (m.subtype === "success") finalText = m.result; }
  }
} catch (e) { /* error result already captured above; connection/spawn failures land here with no result */ }
finally { clearTimeout(timer); }
```

---

## 2. Gating sensitive tools with `canUseTool`

Evaluation order per call: **hooks → deny rules → ask rules → permission mode → allow rules → `canUseTool`**. Consequences:

- Anything approved by `allowedTools`, a settings allow rule, `acceptEdits`, or `bypassPermissions` **never reaches `canUseTool`** (the SDK emits a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` process warning for bare-name entries). To observe/deny those calls, use a `PreToolUse` hook (runs for every call, can deny even in `bypassPermissions`).
- In `dontAsk` the callback is skipped and the call denied. In `default` with no callback, prompts are denied.
- For your own in-process tools, set `permission_policy: "always_ask"` on the server config (SDK ≥0.3.301) so the call reaches the callback **even if** `allowedTools: ["mcp__taskcenter__*"]` covers it. Pair with `annotations: { destructiveHint: true }` or the `auto`-mode classifier may approve it before you see it.
- `canUseTool` has **no timeout**; the subprocess waits indefinitely. Honor `options.signal`.

```ts
import { query, tool, createSdkMcpServer, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";

const canUseTool: CanUseTool = async (toolName, input, { signal, toolUseID, decisionReason, agentID }) => {
  const sensitive =
    toolName === "mcp__taskcenter__send_email" ||
    (toolName === "Bash" && /\bgit\s+push\b/.test(String(input.command ?? "")));
  if (!sensitive) return { behavior: "allow", updatedInput: input };

  const approval = await approvals.waitForHuman({ toolName, input, toolUseID, agentID, signal }); // your queue
  if (approval.kind === "approve")
    return { behavior: "allow", updatedInput: approval.editedInput ?? input }; // may rewrite args
  return { behavior: "deny", message: `Denied by ${approval.by}: ${approval.reason}`, interrupt: approval.stopRun };
};
```

`PermissionResult` is exactly `{ behavior: "allow"; updatedInput?; updatedPermissions?; toolUseID? } | { behavior: "deny"; message: string; interrupt?: boolean; toolUseID? }`. `updatedPermissions` > 4096 entries invalidates the result. Returning `null` is only for when you already sent the `control_response` yourself (echoing `requestId`); otherwise the call blocks forever.

**Approval that must survive a process restart** (queue, then resume hours later): use a `PreToolUse` hook returning `permissionDecision: "defer"`. The turn ends with `stop_reason: "tool_deferred"` and `deferred_tool_use: { id, name, input }` on the result; persist `session_id`, and later resume the session (`options.resume`) with the same hooks/MCP servers registered — the same tool call re-fires `PreToolUse`, where you return `"allow"` (optionally with `updatedInput`) or `"deny"`. Constraints: `-p`/SDK only; only works when the turn has a single pending tool call; resume **without a prompt** or the deferred call is dropped (documented form: `claude -p --resume <id>` with no prompt; **[unverified]** how to express a prompt-less resume through `query()`, whose `prompt` is required — the SDK reference only says "resume with the same `session_id`", so spawn the CLI directly for this step if `query()` with an empty prompt misbehaves); permission mode is not restored on `-p` resume, pass it again.

```ts
PreToolUse: [{ matcher: "mcp__taskcenter__send_email", hooks: [async (input) => {
  const pre = input as PreToolUseHookInput;
  const a = await approvals.lookup(pre.session_id, pre.tool_use_id);
  if (!a) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } };
  return { hookSpecificOutput: { hookEventName: "PreToolUse",
    permissionDecision: a.approved ? "allow" : "deny", permissionDecisionReason: a.reason, updatedInput: a.input } };
}] }]
```

---

## 3. Hooks for audit logging

```ts
type HookCallback = (input: HookInput, toolUseID: string | undefined, opts: { signal: AbortSignal }) => Promise<HookJSONOutput>;
interface HookCallbackMatcher { matcher?: string; hooks: HookCallback[]; timeout?: number /* seconds */; onFailure?: "continue" | "block" }
```

Events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionRequest`, `PermissionDenied`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Notification`, `Setup`, `TaskCreated`, `TaskCompleted`, `Elicitation`, `ConfigChange`, `FileChanged`, … (33 total). All inputs carry `session_id`, `cwd`, `hook_event_name`, `transcript_path`, `permission_mode?`, `agent_id?`, `agent_type?`, `prompt_id?`. `PreToolUse` adds `tool_name`, `tool_input`, `tool_use_id`, `mcp_server?`; `PostToolUse` adds `tool_response`, `duration_ms?`.

```ts
const auditHook: HookCallback = async (input, toolUseID, { signal }) => {
  // Fire-and-forget: return async so the agent does not wait on the DB write.
  db.insertToolEvent({
    sessionId: input.session_id, event: input.hook_event_name, toolUseId: toolUseID,
    agentId: (input as any).agent_id ?? null,
    toolName: (input as any).tool_name, toolInput: (input as any).tool_input,
    toolResponse: (input as any).tool_response, durationMs: (input as any).duration_ms,
    at: new Date(),
  }).catch(console.error);
  return { async: true, asyncTimeout: 30_000 };
};

const options: Options = {
  hooks: {
    PreToolUse:  [{ hooks: [auditHook] }],                 // no matcher = every tool
    PostToolUse: [{ hooks: [auditHook] }],
    PostToolUseFailure: [{ hooks: [auditHook] }],
    SessionStart: [{ hooks: [auditHook] }],                // TS only; not a Python callback event
    Stop: [{ hooks: [auditHook] }],                        // Stop ignores matchers
    SubagentStop: [{ hooks: [auditHook] }],
  },
};
```

Rules of thumb: a sync hook that returns `{}` allows; `deny` beats `defer` beats `ask` beats `allow` across multiple hooks; default per-event timeout is 600 s (30 s for `UserPromptSubmit`), on timeout a `PreToolUse` hook *blocks* the call; a throwing hook lets the action proceed unless `onFailure: "block"` (SDK ≥0.3.317). Matchers match the tool name only (`"Write|Edit"`, `"mcp__taskcenter__.*"`); filter on `tool_input.file_path` inside the callback. Hooks may not fire for the final turn when `maxTurns` ends the session. Set `includeHookEvents: true` to also see `hook_started`/`hook_response` messages in the stream.

---

## 4. In-process "task center" tools: `createSdkMcpServer` + `tool()`

```ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

function makeTaskCenter(taskId: string) {
  const update_task_status = tool(
    "update_task_status", "Set the task's status in the task center",
    { status: z.enum(["in_progress", "blocked", "done"]), summary: z.string().optional() },
    async ({ status, summary }) => {
      await tasks.setStatus(taskId, status, summary);
      return { content: [{ type: "text", text: `status=${status}` }], structuredContent: { ok: true, status } };
    },
    { annotations: { idempotentHint: true } });

  const add_note = tool("add_note", "Append a note to the task log", { text: z.string().min(1) },
    async ({ text }) => { await tasks.addNote(taskId, text); return { content: [{ type: "text", text: "noted" }] }; });

  const request_approval = tool("request_approval", "Ask a human to approve an action before continuing",
    { action: z.string(), details: z.string().optional() },
    async ({ action, details }) => {
      const id = await approvals.create(taskId, action, details);
      return { content: [{ type: "text", text: `approval ${id} pending; call again later or stop` }] };
    });

  const deliver_artifact = tool("deliver_artifact", "Attach a finished artifact to the task",
    { path: z.string(), kind: z.enum(["draft_email", "report", "patch"]) },
    async ({ path, kind }) => {
      try { await artifacts.store(taskId, kind, path); return { content: [{ type: "text", text: "delivered" }] }; }
      catch (e) { return { content: [{ type: "text", text: `deliver failed: ${(e as Error).message}` }], isError: true }; }
    },
    { annotations: { destructiveHint: true } });

  return createSdkMcpServer({ name: "taskcenter", version: "1.0.0", tools: [update_task_status, add_note, request_approval, deliver_artifact],
    instructions: "Report progress with update_task_status; never finish without deliver_artifact.", timeout: 30_000 });
}

const options: Options = {
  mcpServers: { taskcenter: { ...makeTaskCenter(taskId), tools: [{ name: "deliver_artifact", permission_policy: "always_ask" }] } },
  allowedTools: ["mcp__taskcenter__*", "Read", "Grep", "Glob"],   // tool names are mcp__<serverKey>__<toolName>
  canUseTool,                                                       // deliver_artifact still lands here
};
```

- Handler signature: `(args: InferShape<Schema>, extra) => Promise<CallToolResult>`; `inputSchema` is a Zod **raw shape** (`{ a: z.string() }`), not `z.object(...)`.
- A throwing handler becomes an `isError` result; the loop continues. Compose the error text yourself for better recovery.
- `structuredContent` is forwarded to Claude as JSON; text blocks are then dropped (images/resources kept).
- Tools run in **your** Node process (so they can touch your DB directly); the MCP server key in `mcpServers` determines the `mcp__<key>__` prefix (replace `.`/spaces with `_`).
- Mid-session changes: `q.setMcpServers({...})` replaces SDK-managed servers; `tools: []` clears policies.
- To scale past ~a few dozen tools, see tool search (`searchHint`, `alwaysLoad`).

---

## 5. Structured output

```ts
import { z } from "zod";
const Outcome = z.object({ status: z.enum(["done", "needs_human", "failed"]), summary: z.string(),
  artifacts: z.array(z.string()), followups: z.array(z.string()) });

for await (const m of query({ prompt, options: {
  outputFormat: { type: "json_schema", schema: z.toJSONSchema(Outcome, { target: "draft-7" }) } } })) {
  if (m.type === "result") {
    if (m.subtype === "success" && m.structured_output) { const out = Outcome.parse(m.structured_output); /* typed */ }
    else if (m.subtype === "error_max_structured_output_retries") { /* schema never satisfied */ }
    else { /* success without structured_output (e.g. refusal) — treat as failure */ }
  }
}
```

The SDK validates with JSON Schema **draft-07** (Zod defaults to 2020-12; pass `target: "draft-7"`). Invalid schemas fail at startup (CLI ≥2.1.205). Claude returns the object through an injected `StructuredOutput` tool call you will see in the stream — skip it in your tool log. Read the validated value only from `result.structured_output`. Keep schemas shallow; make fields optional when the task may lack data. CLI equivalent: `claude -p --output-format json --json-schema '<schema>'` → `.structured_output`.

---

## 6. Running many workers: process model, concurrency, resume, auth

**Process model (verified in the 0.3.318 bundle).** Every `query()` spawns one Claude Code subprocess (`child_process.spawn` with `stdio: ["pipe","pipe","pipe"]`, `windowsHide: true`, your `abortController.signal`). The CLI is the bundled native binary from the platform optional dependency (`@anthropic-ai/claude-agent-sdk-linux-x64`, etc.). SDK and CLI talk NDJSON (`--input-format/--output-format stream-json`) over stdin/stdout. The SDK sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts` (if unset), deletes `NODE_OPTIONS`, and maps `DEBUG_CLAUDE_AGENT_SDK` → `DEBUG=1`. On abort/`close()` it sends `SIGTERM`, then `SIGKILL` after 5 s (Windows: closes stdin). A `process.on("exit")` handler SIGTERMs all tracked children on normal orchestrator exit — but **not** if the orchestrator itself is SIGKILLed; in that case the child sees stdin EOF and shuts down (it cancels pending prompts when input ends). `startup()`/`prewarm()` pre-spawn a process to take spawn+init latency off the critical path.

**Concurrency.** There is no SDK-level limit; each worker is a full CLI runtime plus its own API stream. Practical limits are API rate limits and memory. Use a semaphore (`p-limit`-style) and tune empirically — 4–8 concurrent workers per host is a sane starting point **[unverified: no official number]**. Inside each worker, cap fan-out with `env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "3", CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" }` (defaults 20 and 3). Single-shot runs also wait up to 10 min for background subagents at exit (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`).

**Timeouts.** Wall-clock: `abortController` + `setTimeout` (result: `terminal_reason: "aborted_*"`, error `"Claude Code process aborted by user"`). API-level via `env`: `API_TIMEOUT_MS` (600000), `CLAUDE_CODE_MAX_RETRIES` (10, cap 15), `CLAUDE_STREAM_IDLE_TIMEOUT_MS` (300000), `CLAUDE_CODE_RETRY_WATCHDOG=1` for unattended runs. Prefer `q.interrupt()` (streaming mode) before abort if you want a clean result.

**Resume after crash.** Persist `session_id` from the `init` message. Later: `query({ prompt: "Continue the task", options: { resume: sessionId, cwd: sameCwd } })`. Transcripts live at `~/.claude/projects/<cwd with non-alphanumerics→'-'>/<id>.jsonl` (or `$CLAUDE_CONFIG_DIR/projects/`); resume works from any directory on the same machine (CLI ≥2.1.223). Set `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` in `env` to auto-continue a turn cut off mid-way; `CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS` bounds staleness. A crashed process emits a final `error_during_execution` result whose cost fields may be zeroed — take totals from the previous result. For cross-host resume use the `sessionStore` adapter (alpha) or ship the `.jsonl`; often simpler to re-prompt with your own saved state. `forkSession: true` + `resume` branches without touching the original.

**Auth** (precedence the CLI applies): provider env (`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`) → `ANTHROPIC_AUTH_TOKEN` (Bearer) → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, subscription-backed, 1-year) → `ant` profiles → `/login` keychain credentials. In `-p`/SDK mode an API key is used silently when present. The SDK does **not** load `.env`. Detect what was used via `init.apiKeySource` (`"none"` = OAuth/bearer/cloud). `--bare` / `CLAUDE_CODE_SIMPLE=1` ignores OAuth and keychain entirely (API key only). Policy: Anthropic does not allow third-party products to offer claude.ai login/rate limits to *their* users — use API keys for anything customer-facing; `CLAUDE_CODE_OAUTH_TOKEN` is documented for your own CI/automation.

---

## 7. Cost control

- **Hard stops:** `maxTurns` (turn = one model round-trip incl. tool calls) and `maxBudgetUsd` (checked after each response; subagent spend counts; overshoot ≤ one response). Both yield an error result that still carries `session_id` so you can resume with a higher cap.
- **Model routing:** `model: "haiku"` for classification/triage workers, `"sonnet"` for execution, `"opus"`/`"fable"` for hard tasks. Aliases resolve to current versions; pass full IDs to pin. Per-subagent override via `agents: { triage: { description, prompt, model: "haiku", effort: "low", maxTurns: 5 } }`. `fallbackModel: "sonnet,haiku"` for overload resilience.
- **Effort/thinking:** `effort: "low"` for simple workers; `thinking: { type: "adaptive" }` is default. No `temperature`/`max_tokens` options; `CLAUDE_CODE_MAX_OUTPUT_TOKENS` env caps output.
- **Prompt caching** is automatic (system prompt, tool definitions, CLAUDE.md prefix). To maximize cross-worker cache hits: keep `allowedTools`/MCP tool sets identical across workers; use `systemPrompt: { type: "preset", preset: "claude_code", append: SHARED_TEXT, excludeDynamicSections: true }` (moves per-machine auto-memory paths out of the system prompt); for custom prompts put volatile text after the exported `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` in a `string[]`. Verify with `usage.cache_read_input_tokens` / `modelUsage[m].cacheReadInputTokens`.
- **Accounting:** per-step usage is on `assistant.message.usage`, but one API response yields several assistant messages sharing `message.id` — dedupe by ID; per-step `output_tokens` is a placeholder, real counts are on the result. `total_cost_usd` is a client-side estimate from a bundled price table, not billing.
- **Startup cost:** `settingSources: []` + `tools: [...]` + `strictMcpConfig: true` avoids loading user plugins/MCP servers/skills into every worker's context.

---

## 8. Python SDK equivalents (`pip install claude-agent-sdk`, 0.2.178, Python ≥3.10)

| TypeScript | Python |
|---|---|
| `query({ prompt, options })` | `query(prompt=..., options=ClaudeAgentOptions(...))` (async iterator; raises `ResultError` after an error result) |
| persistent streaming session | `ClaudeSDKClient(options)`: `connect()`, `query()`, `receive_response()`, `interrupt()`, `set_permission_mode()`, `set_model()`, `disconnect()`; use `async with` |
| `Options` | `ClaudeAgentOptions` dataclass: `allowed_tools`, `disallowed_tools`, `permission_mode`, `max_turns`, `max_budget_usd`, `system_prompt`, `mcp_servers`, `hooks`, `can_use_tool`, `cwd`, `env` (**merged**, not replaced), `resume`, `continue_conversation`, `fork_session`, `output_format`, `model`, `fallback_model`, `effort`, `thinking`, `setting_sources`, `cli_path` (= `pathToClaudeCodeExecutable`), `max_buffer_size`, `stderr`, `agents` |
| `canUseTool(name, input, opts)` → `PermissionResult` | `can_use_tool(tool_name, input_data, context: ToolPermissionContext)` → `PermissionResultAllow(updated_input=...)` / `PermissionResultDeny(message=..., interrupt=...)` |
| `hooks: { PreToolUse: [{ matcher, hooks, timeout, onFailure }] }` | `hooks={"PreToolUse": [HookMatcher(matcher=..., hooks=[cb], timeout=..., on_failure=...)]}`; callback `(input_data, tool_use_id, context)`; `SessionStart`/`SessionEnd` **not** available as Python callbacks |
| `tool(name, desc, zodShape, handler, extras)` | `@tool(name, desc, {"a": float} \| JSONSchema dict, annotations=...)` on `async def f(args) -> dict` returning `{"content": [...], "is_error": bool}` (no `structuredContent`) |
| `createSdkMcpServer({ name, version, tools })` | `create_sdk_mcp_server(name, version, tools)` |
| `SDKResultMessage` | `ResultMessage` (flat dataclass; `total_cost_usd`, `usage`, `model_usage` are Optional) |
| `SDKSystemMessage.session_id` | `SystemMessage.data["session_id"]` |
| `outputFormat` / `structured_output` | `output_format={"type":"json_schema","schema": Model.model_json_schema()}` / `message.structured_output` |
| errors thrown | `CLINotFoundError`, `CLIConnectionError`, `ProcessError`, `ResultError`, `CLIJSONDecodeError` |

---

## 9. Known gotchas

1. **Node ≥18.14** (engines); project runs Node 22, fine. Default runtime for the SDK's helper processes is `node` (or `bun` if running under Bun).
2. **Bundled CLI** ships as a platform optional dependency; `npm ci --omit=optional`, Yarn 1 (`libc` field ignored → both glibc+musl installed), Docker multi-stage copies, and `bun build --compile` all break resolution (`Native CLI binary for <platform>-<arch> not found`). Fix with `pathToClaudeCodeExecutable` (a separately installed `claude` works: `which claude`) or `extractFromBunfs()`. SDK and CLI versions track each other (0.3.N ↔ 2.1.N); features gated by CLI version need the matching SDK.
3. **Nested inside another Claude Code session** (e.g. orchestrator started from a Claude Code Bash tool): the child inherits `CLAUDECODE=1` and `CLAUDE_CODE_CHILD_SESSION=1` because `env` defaults to `process.env` and the SDK does not strip them (verified in bundle). Documented effects: nested *interactive* sessions are not persisted/resumable; `-p`/SDK sessions **still persist**; the "declared scheduled run" origin feature is ignored. I found **no documented hard failure** for nested headless runs, but removing both vars from `env` (`const { CLAUDECODE, CLAUDE_CODE_CHILD_SESSION, ...rest } = process.env`) avoids the nested classification and is harmless; set `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` if you keep them and need transcripts. Also note `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, if inherited from a hosted session, makes the CLI ignore `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` from settings files.
4. **`env` replaces, not merges** (TS). Forgetting `...process.env` drops `PATH`, `HOME`, and your API key → `Not logged in`.
5. **`canUseTool` is silently bypassed** for tools in `allowedTools`/allow rules/`acceptEdits`/`bypassPermissions`; `allowedTools` does not constrain `bypassPermissions`. Use `disallowedTools` for hard blocks and `PreToolUse` hooks for universal interception. In `bypassPermissions` the CLI refuses to start as root (`startup_failure_reason: "bypass_root"`).
6. **Raw `claude -p` from Node:** never use `child_process.exec` (1 MiB `maxBuffer` default kills long runs); use `spawn` + `readline` over stdout. Pair `--output-format stream-json` with `--verbose` (docs always do; older CLIs error without it) and `--include-partial-messages` only if you want deltas. `-p` with no prompt and no piped stdin errors. Exit code 143 on SIGTERM with no result recorded; send SIGINT (or `interrupt()`) first for a clean result. Flags verified in `claude --help` 2.1.318: `--output-format text|json|stream-json`, `--input-format text|stream-json`, `--json-schema`, `--max-budget-usd`, `--max-turns`, `--permission-mode`, `--permission-prompts host|none`, `--allowedTools`, `--disallowedTools`, `--tools`, `--append-system-prompt[-file]`, `--system-prompt[-file]`, `--mcp-config`, `--strict-mcp-config`, `--resume`, `--continue`, `--fork-session`, `--session-id`, `--model`, `--fallback-model`, `--effort`, `--bare`, `--no-session-persistence`, `--setting-sources`, `--settings`, `--agents`, `--betas`, `--dangerously-skip-permissions`, `--replay-user-messages`, `--permission-prompt-tool`.
7. **Zombie/orphan processes:** normal exit → SDK SIGTERMs children; `abort()`/`close()` → SIGTERM then SIGKILL after 5 s; orchestrator SIGKILL → children orphaned until they notice stdin EOF (they do shut down, but a running Bash tool subtree may linger until the CLI kills it on SIGTERM). Run under a supervisor, always `close()` in `finally`, and consider `spawnClaudeCodeProcess` to wrap spawning (e.g. process groups, cgroups, containers) when you need guaranteed cleanup.
8. **Single-shot `query()` throws** after an error result; streaming-input sessions stay alive after errors. If your streaming prompt generator throws, the error surfaces as `"Claude Code process aborted by user"` — look at the generator first.
9. **Session files accumulate** in `~/.claude/projects/...` (30-day `cleanupPeriodDays` sweep by default). For throwaway workers set `persistSession: false`; for tenancy isolation set `CLAUDE_CONFIG_DIR` (+ `CLAUDE_CODE_PROJECT_DIR_NAME`) per worker pool.
10. **Settings leakage:** default `settingSources` loads `~/.claude/settings.json`, project `.claude/settings.json` (hooks, permission rules, MCP servers) and CLAUDE.md from `cwd`. For deterministic workers pass `settingSources: []` and `strictMcpConfig: true`, then opt back in to `"project"` if you want CLAUDE.md.
11. **`structured_output` can be absent on `subtype: "success"`** (refusal, early stop). Always check both.
12. **Hooks vs `maxTurns`:** `Stop`/`PostToolUse` hooks may not fire when the turn limit ends the session; log the `result` message independently.
13. **Telemetry/network:** set `DISABLE_TELEMETRY=1` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` in `env` for locked-down hosts (note: `0`/`false` still disables).

### Minimal worker runner (ties it together)

```ts
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

export async function runWorker(task: Task, signal?: AbortSignal) {
  const ac = new AbortController();
  signal?.addEventListener("abort", () => ac.abort());
  const killTimer = setTimeout(() => ac.abort(), task.timeoutMs ?? 30 * 60_000).unref?.();
  const { CLAUDECODE, CLAUDE_CODE_CHILD_SESSION, ...cleanEnv } = process.env;

  const options: Options = {
    cwd: task.workdir,
    model: task.tier === "triage" ? "haiku" : "sonnet",
    effort: task.tier === "triage" ? "low" : "high",
    maxTurns: 60, maxBudgetUsd: 2.5,
    systemPrompt: { type: "preset", preset: "claude_code", append: WORKER_RULES, excludeDynamicSections: true },
    settingSources: [], strictMcpConfig: true,
    tools: ["Read", "Grep", "Glob", "Bash", "Edit", "Write"],
    mcpServers: { taskcenter: { ...makeTaskCenter(task.id), tools: [{ name: "deliver_artifact", permission_policy: "always_ask" }] } },
    allowedTools: ["Read", "Grep", "Glob", "mcp__taskcenter__*", "Bash(npm test *)"],
    disallowedTools: ["Bash(git push *)", "Bash(rm -rf *)"],
    permissionMode: "default", canUseTool,
    hooks: { PreToolUse: [{ hooks: [auditHook] }], PostToolUse: [{ hooks: [auditHook] }], Stop: [{ hooks: [auditHook] }] },
    outputFormat: { type: "json_schema", schema: OutcomeSchema },
    abortController: ac,
    env: { ...cleanEnv, CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "3", CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1", DISABLE_TELEMETRY: "1" },
    stderr: (line) => log.debug({ taskId: task.id, line }),
    ...(task.resumeSessionId ? { resume: task.resumeSessionId } : {}),
  };

  const q = query({ prompt: task.prompt, options });
  let sessionId: string | undefined; let last: any;
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") { sessionId = m.session_id; await tasks.saveSession(task.id, sessionId); }
      if (m.type === "result") last = m;
    }
  } catch (err) { if (!last) throw err; /* error result already captured */ }
  finally { clearTimeout(killTimer as any); q.close(); }

  return { sessionId, subtype: last?.subtype, cost: last?.total_cost_usd, turns: last?.num_turns,
           output: last?.subtype === "success" ? last.structured_output : undefined,
           denials: last?.permission_denials ?? [], errors: last?.errors ?? [] };
}
```

### Sources
- https://code.claude.com/docs/en/agent-sdk/typescript (full Options/Query/message/hook types)
- https://code.claude.com/docs/en/agent-sdk/{overview,quickstart,permissions,hooks,custom-tools,sessions,cost-tracking,structured-outputs,streaming-vs-single-mode,agent-loop,subagents,modifying-system-prompts,configuration,claude-code-features,python,troubleshooting}
- https://code.claude.com/docs/en/headless, /cli-reference, /env-vars, /authentication, /hooks (defer section)
- npm `@anthropic-ai/claude-agent-sdk@0.3.318` tarball (`sdk.mjs` spawn/kill/env logic); local `claude --help` (2.1.318)
