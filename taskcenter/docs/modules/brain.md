# brain — LLM providers, context, triage, planning, prompts, memory, digest

`src/brain/` holds everything that *thinks* without executing: single-shot LLM calls and the
prompt/parse logic around them. Execution agents live in `src/runners/`.

## Files

| File | Exports (see `docs/CONTRACTS.md`) | Notes |
|---|---|---|
| `llm.ts` | `LlmProvider`, `LlmRequest`, `LlmResponse` | Contract (unchanged). |
| `providers/claude-cli.ts` | `ClaudeCliProvider`, `createClaudeCliProvider`, `buildClaudeCliArgs` | Default provider. Spawns `claude -p --output-format json --max-turns 1 --tools "" --no-session-persistence --setting-sources "" --strict-mcp-config --permission-mode dontAsk [--effort] [--system-prompt] [--json-schema]`; prompt via stdin (no argv limits). Reads `structured_output` (falls back to the first JSON object in `result`), `total_cost_usd`, `usage`. Timeout → SIGTERM then SIGKILL. Env strips `CLAUDECODE`/`CLAUDE_CODE_CHILD_SESSION`. Verified live (haiku): ~$0.0004 per trivial call, ~2 s. |
| `providers/anthropic-api.ts` | `AnthropicApiProvider`, `MODEL_ALIASES`, `PRICE_TABLE`, `estimateCostUsd`, `resolveModelId`, `buildMessagesRequest` | Direct `POST /v1/messages` via `fetch` with `ANTHROPIC_API_KEY` (`ANTHROPIC_BASE_URL` honoured). Aliases haiku→`claude-haiku-5-5`, sonnet→`claude-sonnet-5-5`, opus→`claude-opus-5-5`. Structured output via `output_config.format = {type:"json_schema", schema}`; on a 400 mentioning `output_config`/`format` it retries once with "respond with JSON" in the prompt and extracts the first JSON object. Cost is estimated from `PRICE_TABLE` (USD/MTok incl. cache rates). No live test (no key here); unit-tested with a mocked fetch. |
| `providers/dry.ts` | `DryLlmProvider`, `dryTriageFor` | Deterministic, zero-cost. `purpose: classify` → keyword-heuristic `TriageResult`s for the signals found in the prompt's first ```json block; `plan` → 3-step plan, no subtasks; `digest`/`profile-suggestions` → canned text. `respond(req)` hook lets tests inject answers; `calls[]` records requests. |
| `providers/index.ts` | `createLlmProvider(config, logger)` | `claude-sdk`/`claude-cli` → claude-cli provider; `anthropic-api`; `dry`. `TC_LLM_PROVIDER` env overrides. |
| `providers/util.ts` | `extractFirstJson`, `extractLastJsonObject`, `estimateTokens`, `truncateToTokens`, `truncateChars`, `cleanClaudeEnv` | Shared helpers (also used by runners). |
| `context.ts` | `loadContext`, `renderProfile`, `renderMemories`, `loadProfile`, `pickLang` | Parses `config.profile_path` (falls back to `config/profile.yaml`, then `profile.example.yaml`), renders compact markdown in the profile's `identity.preferred_language` (zh-CN/en headings), appends active memories (`minConfidence 0.5`, 60 max), caps `text` at ~3000 tokens (profile ⅔, memories ⅓). |
| `classifier.ts` | `triageSignals`, `TRIAGE_JSON_SCHEMA`, `TriageBatchSchema`, `buildTriagePrompt`, `digestSignal`, `inferRequiredCapabilities`, `fallbackTriage` | See below. |
| `planner.ts` | `planTask`, `PLAN_JSON_SCHEMA`, `PlanResponseSchema`, `buildPlanPrompt`, `fallbackPlan`, `PlannedSubtask` | See below. |
| `prompts/execute.ts` | `buildExecutionPrompt`, `buildSystemPromptAppend`, `buildPromptBody`, `buildResumePrompt` | See below. |
| `memory.ts` | `recordLearned`, `refreshContext`, `consolidateMemories`, `inferMemoryKind`, `generatedProfilePath` | See below. |
| `digest.ts` | `buildDigest`, `renderDigestTemplate` | See below. |

## Triage (`triageSignals`)

1. Signals are batched (`config.patrol.triage_batch_size`). Each signal becomes a digest: id, source, kind,
   title (≤200), actor, occurred_at, url, body excerpt (≤1200 chars), metadata highlights (repo, number,
   state, labels, from/to/subject, path, branch, start/end, …).
2. Prompt = personal context + rules + the digests as a ```json block, with `TRIAGE_JSON_SCHEMA`
   (draft-07, `{items: TriageItem[]}`) passed as `jsonSchema`. Rules cover: grouping related signals into
   one item, the five kinds, categories, P0–P3 with the profile's priority rules, L1–L5 definitions from
   `docs/architecture.md`, `dismiss` for noise, `learned` facts, and output language = `config.locale`.
3. Validation with zod (`TriageItemSchema` uses `.catch()` for enum/number drift). Parse failure → one
   repair call (`purpose: classify-repair`) quoting the bad answer. Total failure → `fallbackTriage()`
   per signal (kind info, L1, P3, confidence 0.3).
4. Coverage guard: hallucinated ids are dropped, an id claimed twice goes to the first item, and
   uncovered signals get a fallback item — every input signal ends up in exactly one result.
5. Policy clamp: `policy.decideLevel({proposed, category, priority, confidence, source, text, tags,
   requiredCapabilities, availableCapabilities})`. Required capabilities are inferred:
   `external_communication` (or communication + send/reply words) → `email_send`; code/ops + push/PR/merge
   → `github_write`; scheduling + book/create → `calendar_write`; browse/search → `web_browse`. The result
   keeps `level_proposed`, sets `level` (dismissed items are forced to L1), and appends
   `[policy: …reasons]` to `level_reason`; category/priority overrides from policy are applied too.

Live check (haiku, `TC_LIVE=1 npx vitest run tests/brain-live.test.ts`): 3 signals, $0.0016, 8 s — PR
→ todo/code/P1/L2, newsletter → dismissed, overdue invoice → decision/finance/P0 clamped by the
`invoice|payment` override.

## Planning (`planTask`)

Prompt = context + task JSON (title, description ≤4000, kind/category/priority/level, acceptance
criteria, deadline, labels, context ≤3000) + rules: 2–8 steps with `needs_approval` for external
comms/publishing/pushing shared branches/PRs/deletes/spending/outside-workspace writes, at least one
verification step, 2–5 checkable acceptance criteria, risks, `required_capabilities`,
`estimated_cost_usd`, and subtasks **only** when genuinely multi-part (≥2 independent chunks or >~1 h),
max 8, `depends_on` as earlier indexes, levels ≤ parent. `normalise()` assigns step ids `s1…`, clamps
subtask levels, filters invalid `depends_on`, drops a lone single subtask, keeps the task's own criteria
when the model returns none. Parse failure → one repair call → `fallbackPlan()` (3 generic steps).

## Execution prompt (`buildExecutionPrompt`)

`systemPromptAppend` (~1100 tokens, tested < 1500) contains: role + standing orders from the profile
(authority, approval gates, escalation, never, confirm-before/ok-without lists, tone); the rule text for
the task's level (L1/L2 read-only … L5 pre-authorised `tc/` pushes); workspace rules (write only inside
the workspace, `tc/` branches only, never push main/force-push, run tests when touching code, no
credentials); the prompt-injection defence paragraph; the `mcp__taskcenter__*` tool guide (incl. "after
`request_approval`, stop and finish with `needs_human`"; "a deny saying an approval is pending → wrap up");
and the AgentOutput contract (status semantics, verification must describe what was actually checked,
summary in the locale). The `prompt` body has title/metadata, description, plan steps with
`[needs approval]`, acceptance criteria, links, and `task.context` wrapped in `<untrusted_content>`
(`context.dry` is skipped). With `opts.resume` the body is replaced by the approval decision
(approve/edit with edited payload/reject/respond) and "continue" instructions.

## Memory

- `recordLearned(repo, learned, source, bus?)` normalises each fact (whitespace, trailing period,
  6–500 chars), infers a kind (preference / habit / goal / project / person / fact) with simple regexes,
  upserts via `repo.memories.upsertByContent` (confidence 0.6; duplicates bump confidence) and records a
  `memory` bus event for new rows. Returns the number of new memories.
- `refreshContext(deps)`: harvests `result.learned` from runs ended in the last 24 h, retires exact
  duplicates (keeps the higher confidence) and memories with confidence < 0.5 untouched for 30 days,
  writes `<data_dir>/context/profile.generated.md` (profile + top memories + last 7 days of task outcomes),
  and, if an `llm` is given and `TC_CONTEXT_LLM !== "off"`, appends a "Suggested profile updates" bullet
  list produced by `models.classify` (haiku). `profile.yaml` is never edited automatically.

## Digest

`renderDigestTemplate` is pure (zh-CN / en): new inbox items by kind with top 5 per kind, pending
approvals with risk/expiry, tasks running / waiting / in review / done / failed (24 h window), spend
today vs `brain.daily_budget_usd`, and `ics` signals in the next 24 h. `buildDigest` optionally polishes
it with `models.classify` unless `TC_DIGEST_LLM=off`; any LLM failure or a too-short answer returns the
template.

## Tests

`tests/brain.test.ts` (24 tests, dry provider, mocked fetch, temp dirs) and `tests/brain-live.test.ts`
(skipped unless `TC_LIVE=1`). Helpers in `tests/brain-helpers.ts` (`mem()`, `cfg()`, `loaded()`,
`policy()`, `sig()`, `task()`, `FakeApprovals`).

## Contract changes

- `src/core/types.ts`: `TriageResult.level_proposed?: Level` (additive, optional). Everything else matches
  `docs/CONTRACTS.md`.
