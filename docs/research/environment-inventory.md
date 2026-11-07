# Environment & Capability Inventory

Captured: 2026-11-05 (cloud session, `env_018mvLamiiYqcJ3GPvU4fA2d`, "Default – trusted network access").
Purpose: know exactly which capabilities the task center can rely on *today*, on which machine, and what the user must still provide.

## 1. Execution environments

| Environment | What it is | Available now | Notes |
|---|---|---|---|
| Claude Code cloud session (this one) | Ephemeral Linux container, 4 vCPU / 15 GB RAM, 30 GB writable | yes | Repo cloned fresh each session; nothing persists unless committed/pushed. Outbound HTTPS via policy proxy (`/root/.ccr`). |
| Claude Code **scheduled tasks** (`create_trigger`) | Cron-driven sessions in the same cloud environment; each firing can start a fresh session with a stored prompt | yes | This is the cloud "heartbeat" for proactive patrols when the user's laptop is off. 7-day-free limit does **not** apply (unlike in-session `CronCreate`). |
| Claude Code child sessions (`create_session`, `send_message`) | Fan-out sibling cloud sessions | yes | Useful for big parallel jobs; each costs a container. |
| In-session subagents (`Agent` tool, `Workflow` tool) | Parallel workers sharing this container | yes | Used to build this project in parallel. Depth limit 1. |
| Headless Claude Code CLI (`claude -p`) | Non-interactive agent runs, JSON/stream-json output | **yes – verified** | `claude 2.1.318`; auth is host-managed here, on the user's machine it uses their Claude login. Models verified: `claude-haiku-5-5` (~$0.004/trivial call), `claude-sonnet-5-5` (~$0.07), `claude-fable-5-1` (default, ~$0.38 because of the large cached system prompt). |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` 0.3.x (npm), `claude-agent-sdk` 0.2.172 (python, preinstalled) | yes | Drives the CLI as a subprocess; supports hooks, `canUseTool`, in-process MCP tools. |
| User's own computer (Remote Control) | `list_computer_folders` / `request_computer_folder` | not attached | No folders shared yet. The daemon is designed to run on the user's machine (launchd/systemd/pm2) **or** in the cloud. |
| Docker | client present, **no daemon** | no | Cannot run containers here. |

## 2. CLIs & runtimes present (cloud container)

- Node 22.23 (`/opt/node22`, default) and Node 24.22 (`/opt/node24`), npm 10, pnpm 10, yarn, bun 1.4
- Python 3.13 + `uv`, `claude-agent-sdk`, `mcp`, `markitdown`, `pdfplumber`, `openpyxl`, `pandas`, `playwright`
- Go, Rust 1.97, Java (Maven/Gradle), Ruby
- `gh` 2.89 (REST only; GraphQL blocked; **repo-scoped** to `kingwonn/agentic-inbox` – user-level endpoints such as `/user/repos` and `/notifications` are refused), `git` (push works via injected credentials)
- `gcloud`, `bq`, `gsutil` (proxy-preconfigured), `rclone`
- `redis-server` 7, PostgreSQL 16 client + server binaries (`pg_ctlcluster`), `node:sqlite` (SQLite 3.53 with JSON1, WAL, FTS5 – verified)
- `playwright` 1.63 + Chromium (`/opt/pw-browsers/chromium`), `google-chrome`
- **Missing:** `codex`, `openai`, `gemini`, `aider`, `wrangler` (installable via npm), `sqlite3` CLI, `fd`, `ollama`

## 3. MCP servers / connectors

| Server | State | Use |
|---|---|---|
| `github` (GitHub MCP) | connected | issues, PRs, commits, files, actions, reviews – scoped to `kingwonn/agentic-inbox` (+ repos added with `add_repo`) |
| `claude-code-remote` | connected | sessions, scheduled tasks (`create_trigger`), `send_later`, repo attach, documentation |
| `Claude_Docs` | connected | living docs (not used by the daemon) |
| Gmail / Google Calendar / Slack / Notion / Linear / Todoist connectors | **not installed** (registry shows `not_installed`) | The daemon therefore uses **IMAP (app password)**, **ICS secret URL**, and tokens instead of claude.ai connectors. If the user connects them later, cloud patrol sessions can use them directly. |
| Plugin MCPs (marketing/finance/PM: hubspot, notion, slack, asana, linear, …) | proxy 403 – not reachable | ignore |

## 4. Skills available in-session

Document/office: `docs`, `docx`, `pptx`, `xlsx`, `pdf`, `google-workspace`. Research: `deep-research`, `brightdata-plugin:*` (needs API key). Product/marketing/finance skill packs. Browser/computer: `chrome-browser`, `built-in-browser`, `computer-use` (desktop app only). Dev: `code-review`, `simplify`, `security-review`, `run`, `claude-api`, `workflow-authoring`, `session-start-hook`.

These are session skills; the daemon cannot call them directly. The cloud patrol session (started by a scheduled task) can.

## 5. Identity & context discovered

- GitHub user `kingwonn` (16 public repos). Repo `kingwonn/agentic-inbox` is a fork of `cloudflare/agentic-inbox`.
- Open PR #1 `codex/analyze-project-for-sparkai-integration` ("Mailbox auto-resolution helper, integrate into MCP tools, and add tests") – authored with Codex on 2026-04-19; branch `sparkai-email` also exists. "SparkAI" looks like one of the user's projects (email integration). This is the first real signal the task center should surface.
- User email: `wkunwking@gmail.com` (Gmail → IMAP app password path is applicable).

## 6. LLM access paths (brain)

1. **Claude Code CLI / Agent SDK** (primary): works wherever `claude` is logged in (user laptop, cloud sessions). No API key needed.
2. **Anthropic API key** (`ANTHROPIC_API_KEY`): optional; not present here.
3. **OpenAI-compatible endpoint** (for Codex/other models): optional; not present here. `codex` CLI is not installed, so "Codex as coding agent" is implemented as a pluggable runner that is disabled until the user installs it.
4. **Cloudflare Workers AI** (used by the existing email client): requires a Cloudflare deployment; not used by the daemon.

## 7. Constraints that shaped the design

- Container is ephemeral → everything must be in git; runtime state in a single SQLite file (`data/taskcenter.db`) that can be copied.
- GitHub token here is repo-scoped → the GitHub sensor reads repo-scoped endpoints and accepts a user PAT on the user's machine for notifications/search.
- No connectors → sensors use the most portable protocols (IMAP, ICS, REST tokens, filesystem).
- `claude -p` with the default model is expensive per call → classification uses haiku, execution uses sonnet by default, opus/fable only when the task's level demands it; every run records cost.
