# Deploying the Task Center

The daemon (`tc daemon`) is a single long-running Node process: sensors → triage →
planning → execution loops, the HITL channels, and the HTTP API + dashboard
(`http://127.0.0.1:4800`). State lives in `taskcenter/data/` (SQLite, logs,
workspaces, artifacts, exports). Only one daemon per data dir can run
(`data/taskcenter.lock`).

## Prerequisites (local machine)

| Need | Why |
|---|---|
| Node ≥ 22.12 | `node:sqlite` built in, no native modules |
| Claude Code CLI logged in (`claude --version`, `claude -p "hi"` works) | default brain + runner reuse your Claude login (no API key) |
| `gh` logged in **or** `GITHUB_TOKEN` in `.env` | GitHub sensor |
| git | worktrees for code tasks |
| optional: Telegram bot token + chat id, ntfy topic, SMTP | approvals on your phone |

```bash
cd taskcenter
npm install
npm run build:web          # dashboard (optional; the API works without it)
node bin/tc.mjs init       # config/taskcenter.yaml, config/profile.yaml, .env (chmod 600)
$EDITOR config/taskcenter.yaml .env config/profile.yaml
node bin/tc.mjs doctor --probe   # one haiku call to verify headless auth
node bin/tc.mjs daemon           # foreground; Ctrl-C stops gracefully
```

Keep `tc` on your PATH with `npm link` (or call `node bin/tc.mjs`).

## macOS (launchd)

One-shot, from any directory (clones to `~/ai/agentic-inbox` on first run, or uses the
checkout the script lives in):

```bash
deploy/bootstrap-mac.sh            # prerequisites → clone/update → npm ci → tc init → dashboard → cloud state → doctor
# fill .env / config/taskcenter.yaml / config/profile.yaml, then:
deploy/bootstrap-mac.sh service    # doctor must pass; renders + loads the plist, waits for http://127.0.0.1:4800
deploy/bootstrap-mac.sh verify-restart   # kill -9 the daemon and confirm launchd restarts it
deploy/bootstrap-mac.sh status     # launchd state + tc status
```

By hand (the plist uses `__TC_DIR__`, `__NODE__` and `__HOME__` placeholders):

```bash
TC_DIR="$(pwd)"   # absolute path of taskcenter/
sed "s|__TC_DIR__|$TC_DIR|g; s|__HOME__|$HOME|g; s|__NODE__|$(dirname "$(command -v node)")|g" deploy/com.agenticinbox.taskcenter.plist \
  > ~/Library/LaunchAgents/com.agenticinbox.taskcenter.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agenticinbox.taskcenter.plist
launchctl kickstart -k gui/$(id -u)/com.agenticinbox.taskcenter
tail -f data/logs/taskcenter.jsonl
```

Stop: `launchctl bootout gui/$(id -u)/com.agenticinbox.taskcenter` (or `deploy/bootstrap-mac.sh uninstall`).
The agent runs in your GUI session, so it sees your Claude Code login and keychain. `KeepAlive`
only restarts after a non-zero exit, so a clean `bootout` stays stopped while a crash (or `kill -9`)
is restarted within `ThrottleInterval` seconds. If `claude`, `gh` or `codex` live outside
`/opt/homebrew/bin`, `/usr/local/bin` or `~/.local/bin`, the script adds their directories to the
plist `PATH`; add them yourself when installing by hand.

## Linux (systemd --user)

```bash
mkdir -p ~/.config/systemd/user
cp deploy/taskcenter.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now taskcenter
loginctl enable-linger "$USER"      # keep it running when you log out
journalctl --user -u taskcenter -f
```

If Node is installed through nvm/volta/asdf, put its bin directory in the
`Environment=PATH=` line of the unit.

## Any OS (pm2)

```bash
npm i -g pm2
pm2 start deploy/pm2.config.cjs
pm2 save && pm2 startup
pm2 logs taskcenter
```

## Operating it

| Task | Command |
|---|---|
| Health | `tc doctor`, `tc status` |
| Force a patrol / triage / plan pass | `tc patrol`, `tc triage`, `tc plan` |
| Approve from a terminal | `tc approvals list`, `tc approvals approve <id> [note]` |
| Follow activity | `tc events --follow`, dashboard `/events` |
| Backup | `tc state export` → `data/exports/<timestamp>/` (JSONL + manifest) |
| Restore / merge | `tc state import <dir>` (idempotent, newest row wins) |
| Rotate secrets | edit `.env`, restart the daemon |

Graceful stop: SIGTERM/SIGINT → the executor stops taking tasks, waits up to 30 s for
running agents, aborts the rest (their runs become `interrupted` and the tasks go
back to `ready`), then closes the DB. On the next start `tc daemon` runs recovery
automatically.

Budget: `brain.daily_budget_usd` caps daily spend. At 80 % you get one
`budget_warning` notification; at 100 % the executor pauses itself (triage and
planning also skip) until the next day or `POST /api/executor/resume` /
`tc status` shows the pause reason.

## Cloud heartbeat (laptop closed)

When the local daemon is off, a Claude Code scheduled task can keep "eyes" on your
sources: it runs `tc patrol --once && tc triage && tc state export` in a cloud
session and commits the export to the `taskcenter-state` branch; the local daemon
imports it when it is back: `deploy/import-cloud-state.sh` (idempotent, run it from cron or
after `bootstrap-mac.sh setup`, which already calls it once). Exact prompt and details: see
[`cloud-patrol.md`](./cloud-patrol.md).

## Security notes

- The dashboard binds to `127.0.0.1`. Expose it only through Tailscale/SSH and set
  `TC_API_TOKEN` (write endpoints then require `Authorization: Bearer`).
- `.env` must be `chmod 600`; logs and exports are passed through the secret
  redactor, but do not commit `data/` anyway (it is gitignored).
- Never run agents with `--dangerously-skip-permissions`; the policy gate is the
  only thing standing between an L4/L5 task and `git push origin main`.
