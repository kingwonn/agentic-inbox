#!/usr/bin/env bash
# deploy/cloud-heartbeat.sh — one full Task Center cycle for a cloud session (no daemon).
#
#   taskcenter/deploy/cloud-heartbeat.sh            # import → patrol → triage → plan → run → export → publish
#   TC_MAX_RUNS=0 taskcenter/deploy/cloud-heartbeat.sh   # sense only (no task execution)
#   TC_DIGEST=1 taskcenter/deploy/cloud-heartbeat.sh     # also send the daily digest
#   TC_PUBLISH=0 taskcenter/deploy/cloud-heartbeat.sh    # keep the export local
#
# Designed for a persistent Claude Code cloud session that has this repository attached
# (so `gh api repos/...` and `git push` work). State lives on the `taskcenter-state`
# branch: imported at the start, exported and pushed at the end, so the cycle survives
# container recycling and stays mergeable with a local daemon (`deploy/import-cloud-state.sh`).
# Sensitive actions still go through the policy gate and end up as pending approvals.
# The last line printed is a JSON summary for the calling session.
set -uo pipefail

TC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$TC_DIR"
export TC_ROOT="$TC_DIR"
STATE_BRANCH="${TC_STATE_BRANCH:-taskcenter-state}"
MAX_RUNS="${TC_MAX_RUNS:-2}"
RUN_TIMEOUT="${TC_RUN_TIMEOUT:-1500}"
PUBLISH="${TC_PUBLISH:-1}"
TC="node --no-warnings=ExperimentalWarning bin/tc.mjs"
log() { printf '[heartbeat %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# 1. dependencies and config (idempotent, fast when already done)
if [ ! -d node_modules ]; then log "npm ci"; npm ci --no-audit --no-fund >/dev/null 2>&1 || { log "npm ci failed"; exit 1; }; fi
if [ ! -f dist/cli.js ] || [ -n "$(find src -newer dist/cli.js -name '*.ts' -print -quit 2>/dev/null)" ]; then
  log "build"; npm run -s build >/dev/null 2>&1 || log "build failed; falling back to tsx"
fi
[ -f config/taskcenter.yaml ] || cp config/taskcenter.example.yaml config/taskcenter.yaml
[ -f config/profile.yaml ] || cp config/profile.example.yaml config/profile.yaml
rm -f data/taskcenter.lock 2>/dev/null || true   # no daemon in a heartbeat; a lock here is stale

# 2. merge the latest shared state
bash deploy/import-cloud-state.sh >&2 || log "state import failed (continuing with local state)"

# 3. sense and think
log "patrol";  $TC patrol --once --json >/dev/null 2>"data/logs/heartbeat-patrol.err" || log "patrol had errors (see data/logs/heartbeat-patrol.err)"
log "triage";  $TC triage --json >/dev/null 2>"data/logs/heartbeat-triage.err" || log "triage had errors"
log "plan";    $TC plan --json >/dev/null 2>"data/logs/heartbeat-plan.err" || log "plan had errors"

# 4. act: run up to MAX_RUNS ready tasks (highest priority first), within the daily budget
ran=0
if [ "$MAX_RUNS" -gt 0 ]; then
  ids="$($TC tasks list --status ready --json 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);
      const r={P0:0,P1:1,P2:2,P3:3};a.sort((x,y)=>(r[x.priority]??9)-(r[y.priority]??9));
      console.log(a.map(t=>t.id).join(" "))}catch{console.log("")}})')"
  for id in $ids; do
    [ "$ran" -ge "$MAX_RUNS" ] && break
    exhausted="$($TC status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).budget.exhausted?"1":"0")}catch{console.log("0")}})')"
    if [ "$exhausted" = "1" ]; then log "daily budget exhausted; stop executing"; break; fi
    log "run $id"
    timeout "$RUN_TIMEOUT" $TC run "$id" >"data/logs/heartbeat-run-$id.log" 2>&1 || log "run $id ended with non-zero status"
    ran=$((ran + 1))
  done
fi

# 5. digest (optional)
if [ "${TC_DIGEST:-0}" = "1" ]; then log "digest"; $TC digest --send >/dev/null 2>&1 || log "digest failed"; fi

# 6. export + publish the shared state
export_dir=""
if $TC state export >/dev/null 2>&1; then export_dir="$(ls -d data/exports/*/ 2>/dev/null | sort | tail -1)"; fi
published="no"
if [ "$PUBLISH" = "1" ] && [ -n "$export_dir" ]; then
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  pub="$(mktemp -d)/pub"
  if git -C "$REPO_ROOT" fetch -q origin "$STATE_BRANCH" && git -C "$REPO_ROOT" worktree add -q "$pub" "origin/$STATE_BRANCH" 2>/dev/null; then
    mkdir -p "$pub/state" && cp -r "$export_dir" "$pub/state/"
    ( cd "$pub" && ls -d state/*/ | sort | head -n -48 | xargs -r rm -rf \
      && git add -A state \
      && git -c user.name=tc-heartbeat -c user.email=tc@localhost commit -q -m "heartbeat: $(basename "$export_dir")" \
      && git push -q origin "HEAD:$STATE_BRANCH" ) && published="yes" || log "publishing to $STATE_BRANCH failed"
    git -C "$REPO_ROOT" worktree remove --force "$pub" >/dev/null 2>&1 || true
    basename "$export_dir" > data/.last-cloud-import
  else
    log "cannot fetch origin/$STATE_BRANCH; export kept locally"
  fi
fi

# 7. summary (last line, JSON)
$TC status --json 2>/dev/null | RAN="$ran" EXPORT="$(basename "${export_dir:-none}")" PUBLISHED="$published" node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let st={};try{st=JSON.parse(s)}catch{}
  const { execFileSync } = require("node:child_process");
  const q=(args)=>{try{return JSON.parse(execFileSync("node",["--no-warnings=ExperimentalWarning","bin/tc.mjs",...args,"--json"],{encoding:"utf8"}))}catch{return []}};
  const pending=q(["approvals","list"]).filter(a=>a.status==="pending").map(a=>({id:a.id,kind:a.kind,risk:a.risk,title:a.title,task:a.task_id,expires:a.expires_at}));
  const review=q(["tasks","list","--status","review"]).map(t=>({id:t.id,title:t.title}));
  const failed=q(["tasks","list","--status","failed"]).map(t=>({id:t.id,title:t.title,error:t.last_error}));
  const inbox=q(["inbox","list"]).filter(i=>i.status==="triaged"||i.status==="new").map(i=>({id:i.id,kind:i.kind,priority:i.priority,level:i.level,title:i.title}));
  console.log(JSON.stringify({ran:Number(process.env.RAN),export:process.env.EXPORT,published:process.env.PUBLISHED,
    budget:st.budget,tasks:st.tasks,pending_approvals:pending,review_ready:review,failed,inbox_open:inbox}));});'
