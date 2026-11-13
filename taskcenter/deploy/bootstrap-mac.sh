#!/usr/bin/env bash
# deploy/bootstrap-mac.sh — set up and run the Task Center on a Mac (steps 1, 2, 6, 7 of
# docs/handoff-local-setup.md). Works with the stock macOS bash 3.2; no Homebrew bash needed.
#
#   bash bootstrap-mac.sh [command] [--probe]
#
#   setup (default)   check node/git/claude/gh → clone or update the repo → npm ci → tc init →
#                     build the dashboard → import the cloud heartbeat state → tc doctor
#   service           render the launchd plist with the real node + repo paths, load it,
#                     wait for http://127.0.0.1:4800 to answer
#   verify-restart    kill -9 the daemon and confirm launchd starts it again
#   status            launchd state + `tc status`
#   render-plist      print the plist as `service` would install it (no changes made)
#   uninstall         stop the service and remove the plist (asks first)
#
# Env overrides: AI_DIR (default ~/ai), TC_BRANCH (default feat/taskcenter), TC_REPO_URL.
# When the script is run from inside a checkout (taskcenter/deploy/bootstrap-mac.sh) that
# checkout is used instead of ~/ai/agentic-inbox.
#
# Secrets: this script never reads, prints or writes taskcenter/.env. Fill it in yourself
# (tc init creates it with mode 600) and keep it out of git.
set -euo pipefail

AI_DIR="${AI_DIR:-$HOME/ai}"
TC_REPO_URL="${TC_REPO_URL:-https://github.com/kingwonn/agentic-inbox}"
TC_BRANCH="${TC_BRANCH:-feat/taskcenter}"
LABEL="com.agenticinbox.taskcenter"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=12

CMD="setup"
PROBE=0
for a in "$@"; do
  case "$a" in
    setup|service|verify-restart|status|render-plist|uninstall) CMD="$a" ;;
    --probe) PROBE=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Use the checkout this script lives in when it is one; otherwise ~/ai/agentic-inbox.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../package.json" ] && [ -f "$SCRIPT_DIR/../bin/tc.mjs" ]; then
  TC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  REPO_DIR="$(cd "$TC_DIR/.." && pwd)"
else
  REPO_DIR="$AI_DIR/agentic-inbox"
  TC_DIR="$REPO_DIR/taskcenter"
fi

tc() { (cd "$TC_DIR" && node --no-warnings=ExperimentalWarning bin/tc.mjs "$@"); }

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v maj min
  v="$(node -v | sed 's/^v//')"
  maj="${v%%.*}"; min="${v#*.}"; min="${min%%.*}"
  [ "$maj" -gt "$MIN_NODE_MAJOR" ] || { [ "$maj" -eq "$MIN_NODE_MAJOR" ] && [ "$min" -ge "$MIN_NODE_MINOR" ]; }
}

dashboard_port() {
  (cd "$TC_DIR" && node -e '
    const fs = require("fs"); let port = 4800;
    try { const { parse } = require("yaml"); port = parse(fs.readFileSync("config/taskcenter.yaml", "utf8")).server?.port ?? port; } catch {}
    console.log(port);' 2>/dev/null) || echo 4800
}

wait_for_dashboard() { # $1 = seconds
  local port url i
  port="$(dashboard_port)"; url="http://127.0.0.1:$port/api/status"
  for i in $(seq 1 "$1"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then echo "$port"; return 0; fi
    sleep 1
  done
  return 1
}

daemon_pid() { sed -n 's/.*"pid":[ ]*\([0-9][0-9]*\).*/\1/p' "$TC_DIR/data/taskcenter.lock" 2>/dev/null | head -1; }

need_mac() { [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1 || die "this command needs macOS (launchctl)"; }

# ───────────────────────────── setup ─────────────────────────────
cmd_setup() {
  say "1/6 Prerequisites"
  if node_ok; then ok "node $(node -v)"; else
    die "node >= $MIN_NODE_MAJOR.$MIN_NODE_MINOR is required (found: $(node -v 2>/dev/null || echo none)). Install with: brew install node@22  (or nvm install 22)"
  fi
  command -v git >/dev/null 2>&1 && ok "$(git --version)" || die "git is required (xcode-select --install)"
  if command -v claude >/dev/null 2>&1; then
    ok "claude $(claude --version 2>/dev/null | head -1)"
    if claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then ok "claude: logged in"; else warn "claude: not logged in — run \`claude\` once and log in; the daemon reuses that login"; fi
  else
    die "Claude Code CLI not found — install it (https://claude.ai/code) and run \`claude\` once to log in"
  fi
  if command -v gh >/dev/null 2>&1; then
    if gh auth status >/dev/null 2>&1; then ok "gh: authenticated"; else warn "gh: not logged in — run \`gh auth login\` or put GITHUB_TOKEN in .env (the github sensor needs one of them)"; fi
  else warn "gh CLI not installed (optional: brew install gh); set GITHUB_TOKEN in .env instead"; fi
  if command -v codex >/dev/null 2>&1; then ok "codex $(codex --version 2>/dev/null | head -1) (runner available)"; else warn "codex not installed (optional: npm i -g @openai/codex && codex login)"; fi

  say "2/6 Repository → $REPO_DIR (branch $TC_BRANCH)"
  if [ -d "$REPO_DIR/.git" ]; then
    git -C "$REPO_DIR" fetch origin "$TC_BRANCH"
    if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then
      warn "working tree has local changes; staying on branch $(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD) (no checkout/pull)"
    else
      git -C "$REPO_DIR" checkout -q "$TC_BRANCH"
      git -C "$REPO_DIR" pull -q --ff-only origin "$TC_BRANCH"
      ok "on $TC_BRANCH @ $(git -C "$REPO_DIR" rev-parse --short HEAD)"
    fi
  else
    mkdir -p "$(dirname "$REPO_DIR")"
    git clone -b "$TC_BRANCH" "$TC_REPO_URL" "$REPO_DIR"
    ok "cloned @ $(git -C "$REPO_DIR" rev-parse --short HEAD)"
  fi
  [ -f "$TC_DIR/package.json" ] || die "$TC_DIR/package.json not found — is this the right branch?"

  say "3/6 Dependencies + config"
  (cd "$TC_DIR" && { npm ci --no-audit --no-fund || npm install --no-audit --no-fund; })
  tc init
  (cd "$TC_DIR" && chmod 600 .env 2>/dev/null || true)
  ok "config/taskcenter.yaml, config/profile.yaml, .env (mode 600)"

  say "4/6 Dashboard build"
  # build:web installs web/ deps on newer checkouts; do it explicitly so older ones work too.
  (cd "$TC_DIR" && { npm --prefix web ci --no-audit --no-fund || npm --prefix web install --no-audit --no-fund; } && npm run build:web --silent)
  ok "web/dist built"

  say "5/6 Cloud heartbeat state (branch taskcenter-state)"
  if [ -x "$TC_DIR/deploy/import-cloud-state.sh" ]; then
    "$TC_DIR/deploy/import-cloud-state.sh" || warn "cloud state import failed (not fatal)"
  else
    warn "deploy/import-cloud-state.sh not on this branch — skipped (see deploy/cloud-patrol.md §3)"
  fi

  say "6/6 tc doctor"
  if [ "$PROBE" = 1 ]; then tc doctor --probe || true; else tc doctor || true; fi

  cat <<NEXT

Next steps
  1. Secrets (never paste them in chat): edit $TC_DIR/.env
       GITHUB_TOKEN          GitHub → Settings → Developer settings → PAT (classic: repo, notifications); or just \`gh auth login\`
       IMAP_USER / IMAP_PASSWORD   Gmail address + App Password (Google Account → Security → 2-Step Verification → App passwords)
       CALENDAR_ICS_URL      Google Calendar → Settings → your calendar → "Secret address in iCal format"
       TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   @BotFather; send /start to the bot, then getUpdates for the chat id
  2. Enable what you filled in: $TC_DIR/config/taskcenter.yaml → sensors.imap/ics/fsdocs enabled: true,
     notifications.channels.telegram enabled: true; set sensors.localgit.repos and sensors.fsdocs.paths to your folders.
  3. Personal context: $TC_DIR/config/profile.yaml (roles, projects, goals, habits, preferences, standing orders).
  4. Re-check, then install the always-on service:
       $TC_DIR/deploy/bootstrap-mac.sh service        # doctor must pass; loads launchd, waits for the dashboard
       $TC_DIR/deploy/bootstrap-mac.sh verify-restart # optional: kill -9 the daemon, confirm it comes back
  Dashboard: http://127.0.0.1:$(dashboard_port)
NEXT
}

# ───────────────────────────── service ─────────────────────────────
render_plist() {
  local node_dir extra d out
  node_dir="$(dirname "$(command -v node)")"
  extra=""
  for b in claude gh codex; do
    if command -v "$b" >/dev/null 2>&1; then
      d="$(dirname "$(command -v "$b")")"
      case ":$node_dir:$extra:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" in *":$d:"*) ;; *) extra="${extra:+$extra:}$d" ;; esac
    fi
  done
  out="$(sed "s|__TC_DIR__|$TC_DIR|g; s|__HOME__/agentic-inbox/taskcenter|$TC_DIR|g; s|__HOME__|$HOME|g; s|__NODE__|$node_dir|g" "$TC_DIR/deploy/$LABEL.plist")"
  if [ -n "$extra" ]; then out="$(printf '%s\n' "$out" | sed "s|<string>$node_dir:|<string>$node_dir:$extra:|")"; fi
  printf '%s\n' "$out"
}

cmd_service() {
  need_mac
  [ -f "$TC_DIR/bin/tc.mjs" ] || die "$TC_DIR is not set up yet — run: $0 setup"
  say "tc doctor (must pass)"
  tc doctor || die "fix the failed checks above, then rerun: $0 service"
  local mode
  mode="$(cd "$TC_DIR" && node -e 'console.log((require("fs").statSync(".env").mode & 0o777).toString(8))' 2>/dev/null || echo "")"
  [ -z "$mode" ] || [ "$mode" = "600" ] || warn ".env mode is $mode — run: chmod 600 $TC_DIR/.env"
  [ -d "$TC_DIR/web/dist" ] || warn "web/dist missing — the API will run but the dashboard needs: npm run build:web"

  say "Installing launchd agent $LABEL"
  mkdir -p "$HOME/Library/LaunchAgents" "$TC_DIR/data/logs"
  render_plist > "$PLIST"
  plutil -lint "$PLIST" >/dev/null && ok "$PLIST (WorkingDirectory=$TC_DIR, node=$(dirname "$(command -v node)"))"
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  ok "loaded (RunAtLoad + KeepAlive: restarts on crash and at login)"

  say "Waiting for the dashboard"
  local port
  if port="$(wait_for_dashboard 60)"; then
    ok "daemon pid $(daemon_pid) — dashboard http://127.0.0.1:$port"
  else
    warn "no answer on /api/status after 60 s; last log lines:"
    tail -n 20 "$TC_DIR/data/logs/launchd.err.log" 2>/dev/null || true
    die "see data/logs/launchd.err.log and data/logs/taskcenter.jsonl"
  fi
  cmd_status_short
}

cmd_status_short() {
  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid|last exit code|runs)' | sed 's/^/  /' || warn "launchd: $LABEL not loaded"
}

cmd_verify_restart() {
  need_mac
  local old new port
  old="$(daemon_pid)"
  [ -n "$old" ] && kill -0 "$old" 2>/dev/null || die "daemon not running (no live pid in data/taskcenter.lock) — run: $0 service"
  say "kill -9 $old and wait for launchd to restart it"
  # SIGKILL on purpose: KeepAlive.SuccessfulExit=false only restarts after a non-zero exit, and a
  # SIGTERM shutdown exits 0 (that is how `launchctl bootout` stops it cleanly).
  kill -9 "$old"
  sleep 2
  if port="$(wait_for_dashboard 60)"; then
    new="$(daemon_pid)"
    [ -n "$new" ] && [ "$new" != "$old" ] && ok "restarted: pid $old → $new, dashboard http://127.0.0.1:$port" || warn "dashboard is up but the lock still shows pid ${new:-?}"
  else
    die "daemon did not come back within 60 s — check: launchctl print gui/$(id -u)/$LABEL ; tail data/logs/launchd.err.log"
  fi
  cmd_status_short
}

cmd_status() {
  need_mac
  say "launchd"
  cmd_status_short
  say "tc status"
  tc status || true
}

cmd_uninstall() {
  need_mac
  printf 'Stop and remove the launchd agent %s? [y/N] ' "$LABEL"
  read -r ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "aborted"; exit 0; }
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  ok "removed (data/, config/ and .env are untouched)"
}

case "$CMD" in
  setup) cmd_setup ;;
  service) cmd_service ;;
  verify-restart) cmd_verify_restart ;;
  status) cmd_status ;;
  render-plist) render_plist ;;
  uninstall) cmd_uninstall ;;
esac
