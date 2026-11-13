# Repository guide for AI agents

This repository has two parts:

1. **Agentic Inbox** (root): the upstream Cloudflare Workers email client (React Router + Hono + Durable Objects). Keep upstream layout; see README.md.
2. **Task Center** (`taskcenter/`): the personal AI work hub built on top — proactive sensing, Inbox/Outbox, L1–L5 autonomy, Claude Agent SDK execution, dashboard. Design: `docs/architecture.md`, ADRs in `docs/adr/`, contracts in `taskcenter/docs/CONTRACTS.md`, module notes in `taskcenter/docs/modules/`.

## Conventions (taskcenter)
- Node ≥ 22, TypeScript ESM (`.js` import suffixes), zod 4, SQLite via `node:sqlite` (`src/core/db.ts`); no native modules.
- All state changes go through `src/core/repo.ts` + `src/core/state.ts` (state machine) and are logged to `events`.
- Policy (`config/policy.yaml`) is the single source of truth for autonomy levels and tool gating. Never bypass the gate with `--dangerously-skip-permissions`.
- Agent branches are prefixed `tc/`. Never push to `main` from an agent run without an approval.
- Tests: `cd taskcenter && npm test`; typecheck: `npm run typecheck`.
- Secrets only in `taskcenter/.env` (0600); never commit them; logs are redacted.

## Working on this repo
- Run the system: `cd taskcenter && npm run tc -- doctor && npm run tc -- daemon`.
- Before changing contracts (`src/core/types.ts`, `docs/CONTRACTS.md`), update both and the dependent modules.
- Research notes live in `docs/research/`; keep them updated when adopting a new library or pattern.
