/**
 * Local git sensor: inspects configured repositories with plain `git` and emits
 * one signal per (repo, condition):
 *   uncommitted_changes, unpushed_commits, stale_branches, merge_conflicts, detached_head
 * A signal is emitted only when the condition's state hash changes (cursor
 * snapshot), and once more when the condition clears (metadata.active=false).
 * Never touches the network (no fetch) and never prompts (GIT_TERMINAL_PROMPT=0).
 */
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { NewSignal } from "../core/types.js";
import { t } from "./i18n.js";
import type { Sensor, SensorContext, SensorPollResult } from "./types.js";
import { errorMessage, hashOf, runCommand, truncate, Warnings, type CommandResult } from "./util.js";

export const LOCALGIT_SOURCE = "localgit";

export const CONDITIONS = ["uncommitted", "unpushed", "stale", "conflicts", "detached"] as const;
export type Condition = (typeof CONDITIONS)[number];

const KIND: Record<Condition, string> = {
  uncommitted: "uncommitted_changes",
  unpushed: "unpushed_commits",
  stale: "stale_branches",
  conflicts: "merge_conflicts",
  detached: "detached_head",
};

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
const MAX_FILES_IN_BODY = 10;
const MAX_BRANCHES = 100;

export interface StatusEntry {
  code: string; // XY
  path: string;
}

export interface BranchInfo {
  name: string;
  upstream: string;
  track: string; // raw %(upstream:track)
  ahead: number;
  behind: number;
  gone: boolean;
  committedAt: number; // unix seconds
  sha: string;
  localOnly?: number; // commits not on any remote (branches without upstream)
}

export interface RepoState {
  label: string;
  path: string;
  branch: string | null; // null when detached
  head: string;
  defaultBranch: string;
  status: StatusEntry[];
  branches: BranchInfo[];
  conflictFiles: string[];
  operation: string | null; // merge | rebase | cherry-pick | revert | null
}

/** Minimal git runner interface (injectable for tests). */
export type GitRunner = (args: string[], cwd: string) => Promise<CommandResult>;

export const defaultGit: GitRunner = (args, cwd) => runCommand("git", args, { cwd, env: GIT_ENV, timeoutMs: 20_000 });

export function parsePorcelain(out: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0 && /[RC]/.test(code)) path = path.slice(arrow + 4);
    entries.push({ code, path });
  }
  return entries;
}

export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: /gone/.test(track) };
}

export function parseBranches(out: string): BranchInfo[] {
  const list: BranchInfo[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [name, upstream, track, ts, sha] = line.split("|");
    if (!name) continue;
    const { ahead, behind, gone } = parseTrack(track ?? "");
    list.push({ name, upstream: upstream ?? "", track: track ?? "", ahead, behind, gone, committedAt: Number(ts) || 0, sha: sha ?? "" });
  }
  return list;
}

function isConflictCode(code: string): boolean {
  return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code);
}

export async function inspectRepo(path: string, git: GitRunner, opts: { label?: string } = {}): Promise<RepoState> {
  const run = async (args: string[]) => {
    const r = await git(args, path);
    if (r.error) throw new Error(`git ${args[0]}: ${r.error}`);
    return r;
  };
  const inside = await run(["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") throw new Error(`${path} is not a git work tree`);

  const headRef = await git(["symbolic-ref", "-q", "--short", "HEAD"], path);
  const branch = headRef.code === 0 ? headRef.stdout.trim() : null;
  const head = (await run(["rev-parse", "--short", "HEAD"])).stdout.trim();

  let defaultBranch = "main";
  const originHead = await git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], path);
  if (originHead.code === 0 && originHead.stdout.trim()) defaultBranch = originHead.stdout.trim().replace(/^origin\//, "");
  else {
    const hasMain = await git(["show-ref", "--verify", "--quiet", "refs/heads/main"], path);
    if (hasMain.code !== 0) {
      const hasMaster = await git(["show-ref", "--verify", "--quiet", "refs/heads/master"], path);
      if (hasMaster.code === 0) defaultBranch = "master";
    }
  }

  const status = parsePorcelain((await run(["status", "--porcelain=v1", "--untracked-files=normal", "--no-renames"])).stdout);
  const conflictFiles = status.filter((s) => isConflictCode(s.code)).map((s) => s.path);

  const refs = await run([
    "for-each-ref",
    "--format=%(refname:short)|%(upstream:short)|%(upstream:track)|%(committerdate:unix)|%(objectname:short)",
    "--sort=-committerdate",
    "refs/heads",
  ]);
  const branches = parseBranches(refs.stdout).slice(0, MAX_BRANCHES);
  const hasRemotes = (await git(["remote"], path)).stdout.trim().length > 0;
  for (const b of branches) {
    if (b.upstream || !hasRemotes) continue;
    const r = await git(["rev-list", "--count", b.name, "--not", "--remotes"], path);
    if (r.code === 0) b.localOnly = Number(r.stdout.trim()) || 0;
  }

  const gitDir = (await run(["rev-parse", "--git-dir"])).stdout.trim();
  const gd = isAbsolute(gitDir) ? gitDir : resolve(path, gitDir);
  let operation: string | null = null;
  if (existsSync(resolve(gd, "MERGE_HEAD"))) operation = "merge";
  else if (existsSync(resolve(gd, "rebase-merge")) || existsSync(resolve(gd, "rebase-apply"))) operation = "rebase";
  else if (existsSync(resolve(gd, "CHERRY_PICK_HEAD"))) operation = "cherry-pick";
  else if (existsSync(resolve(gd, "REVERT_HEAD"))) operation = "revert";

  return { label: opts.label ?? basename(path), path, branch, head, defaultBranch, status, branches, conflictFiles, operation };
}

// ── Condition evaluation ────────────────────────────────────────────

interface Evaluated {
  active: boolean;
  /** Only the stable facts go into the hash (no timestamps / ages). */
  hashInput: unknown;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
}

function daysBetween(nowSec: number, thenSec: number): number {
  return Math.floor(Math.max(0, nowSec - thenSec) / 86_400);
}

export function evaluateConditions(state: RepoState, opts: { now: Date; staleDays: number; locale: string }): Record<Condition, Evaluated> {
  const { label } = state;
  const L = opts.locale;
  const nowSec = Math.floor(opts.now.getTime() / 1000);
  const base = { repo: label, path: state.path, branch: state.branch, head: state.head, default_branch: state.defaultBranch };

  // uncommitted
  const changes = state.status.filter((s) => !isConflictCode(s.code));
  const staged = changes.filter((s) => s.code[0] !== " " && s.code[0] !== "?").length;
  const unstaged = changes.filter((s) => s.code[1] !== " " && s.code[1] !== "?").length;
  const untracked = changes.filter((s) => s.code === "??").length;
  const top = changes.slice(0, MAX_FILES_IN_BODY).map((s) => `${s.code.trim() || "?"} ${s.path}`);
  const uncommitted: Evaluated = {
    active: changes.length > 0,
    hashInput: changes.map((s) => `${s.code}${s.path}`).sort(),
    title: t(L, "git.uncommitted.title", { repo: label, n: changes.length, branch: state.branch ?? state.head }),
    body: [
      `${t(L, "git.label.branch")}: ${state.branch ?? `(detached ${state.head})`}`,
      `${t(L, "git.label.files")}: ${changes.length} (${staged} ${t(L, "git.label.staged")}, ${unstaged} ${t(L, "git.label.unstaged")}, ${untracked} ${t(L, "git.label.untracked")})`,
      ...top,
      ...(changes.length > top.length ? [t(L, "git.label.more", { n: changes.length - top.length })] : []),
    ].join("\n"),
    metadata: { ...base, condition: "uncommitted", count: changes.length, staged, unstaged, untracked, files: changes.slice(0, 25).map((s) => s.path) },
  };

  // unpushed
  const unpushedBranches = state.branches.filter((b) => b.ahead > 0 || (!b.upstream && (b.localOnly ?? 0) > 0) || b.gone);
  const unpushed: Evaluated = {
    active: unpushedBranches.length > 0,
    hashInput: unpushedBranches.map((b) => [b.name, b.sha, b.ahead, b.localOnly ?? 0, b.gone]),
    title: t(L, "git.unpushed.title", { repo: label, n: unpushedBranches.length }),
    body: unpushedBranches
      .map((b) => {
        const parts: string[] = [];
        if (b.gone) parts.push(t(L, "git.label.gone"));
        if (b.upstream) {
          parts.push(t(L, "git.label.ahead", { n: b.ahead }));
          if (b.behind) parts.push(t(L, "git.label.behind", { n: b.behind }));
          return `${b.name} → ${b.upstream}: ${parts.join(", ")}`;
        }
        parts.push(t(L, "git.label.noUpstream", { n: b.localOnly ?? 0 }));
        return `${b.name}: ${parts.join(", ")}`;
      })
      .join("\n"),
    metadata: {
      ...base,
      condition: "unpushed",
      branches: unpushedBranches.map((b) => ({ name: b.name, upstream: b.upstream || null, ahead: b.ahead, behind: b.behind, gone: b.gone, local_only: b.localOnly ?? null, sha: b.sha })),
    },
  };

  // stale
  const staleBranches = state.branches.filter((b) => b.name !== state.defaultBranch && daysBetween(nowSec, b.committedAt) > opts.staleDays);
  const stale: Evaluated = {
    active: staleBranches.length > 0,
    hashInput: staleBranches.map((b) => [b.name, b.sha]).sort(),
    title: t(L, "git.stale.title", { repo: label, n: staleBranches.length, days: opts.staleDays }),
    body: staleBranches
      .map(
        (b) =>
          `${b.name}: ${t(L, "git.label.lastCommit")} ${t(L, "git.label.daysAgo", { n: daysBetween(nowSec, b.committedAt) })} (${b.sha})${b.upstream ? ` → ${b.upstream}${b.gone ? ", " + t(L, "git.label.gone") : ""}` : ""}`,
      )
      .join("\n"),
    metadata: {
      ...base,
      condition: "stale",
      stale_days: opts.staleDays,
      branches: staleBranches.map((b) => ({
        name: b.name,
        sha: b.sha,
        last_commit_at: new Date(b.committedAt * 1000).toISOString(),
        age_days: daysBetween(nowSec, b.committedAt),
        upstream: b.upstream || null,
        gone: b.gone,
      })),
    },
  };

  // conflicts
  const conflictActive = state.conflictFiles.length > 0 || state.operation !== null;
  const conflicts: Evaluated = {
    active: conflictActive,
    hashInput: [state.operation, [...state.conflictFiles].sort()],
    title: t(L, "git.conflicts.title", { repo: label, n: state.conflictFiles.length }),
    body: [
      ...(state.operation ? [`${t(L, "git.label.operation")}: ${state.operation}`] : []),
      ...state.conflictFiles.slice(0, MAX_FILES_IN_BODY).map((f) => `UU ${f}`),
    ].join("\n"),
    metadata: { ...base, condition: "conflicts", operation: state.operation, files: state.conflictFiles.slice(0, 50) },
  };

  // detached
  const detached: Evaluated = {
    active: state.branch === null,
    hashInput: state.head,
    title: t(L, "git.detached.title", { repo: label, sha: state.head }),
    body: `HEAD = ${state.head}`,
    metadata: { ...base, condition: "detached" },
  };

  return { uncommitted, unpushed, stale, conflicts, detached };
}

// ── Sensor ──────────────────────────────────────────────────────────

export interface LocalGitSensorOptions {
  git?: GitRunner;
}

export function resolveRepoPath(p: string, ctx: SensorContext): string {
  if (isAbsolute(p)) return p;
  if (p.startsWith("~/")) return resolve(process.env.HOME ?? "", p.slice(2));
  return resolve(ctx.rootDir, p);
}

export function createLocalGitSensor(opts: LocalGitSensorOptions = {}): Sensor {
  const git = opts.git ?? defaultGit;
  return {
    name: LOCALGIT_SOURCE,
    description: "Local git repositories: uncommitted/unpushed work, stale branches, conflicts, detached HEAD",

    configured(config): boolean {
      const repos = (config.repos as string[] | undefined) ?? [];
      return repos.length > 0;
    },

    async poll(ctx: SensorContext): Promise<SensorPollResult> {
      const warnings = new Warnings();
      const signals: NewSignal[] = [];
      const repos = ((ctx.config.repos as string[] | undefined) ?? []).filter(Boolean);
      const staleDays = Number(ctx.config.stale_days ?? 30);
      const locale = String(ctx.config.locale ?? "zh-CN");
      const now = ctx.now();
      // de-duplicate labels (two repos with the same basename get their full path as label)
      const resolved = repos.map((r) => ({ cfg: r, path: resolveRepoPath(r, ctx) }));
      const counts = new Map<string, number>();
      for (const r of resolved) counts.set(basename(r.path), (counts.get(basename(r.path)) ?? 0) + 1);

      let inspected = 0;
      for (const r of resolved) {
        const label = (counts.get(basename(r.path)) ?? 0) > 1 ? r.path : basename(r.path);
        try {
          if (!existsSync(r.path) || !statSync(r.path).isDirectory()) {
            warnings.add(`repo path not found: ${r.cfg} (${r.path})`);
            continue;
          }
          const lock = resolve(r.path, ".git", "index.lock");
          if (existsSync(lock)) {
            warnings.add(`skipping ${label}: index.lock present (git operation in progress)`);
            continue;
          }
          const state = await inspectRepo(r.path, git, { label });
          inspected++;
          const evaluated = evaluateConditions(state, { now, staleDays, locale });
          const cursorKey = `state:${label}`;
          const prev = ctx.cursors.getJson<Record<string, string>>(cursorKey, {});
          const next: Record<string, string> = {};
          for (const cond of CONDITIONS) {
            const ev = evaluated[cond];
            const hash = ev.active ? hashOf(ev.hashInput) : "none";
            next[cond] = hash;
            const before = prev[cond];
            if (before === hash) continue;
            if (!ev.active && (before === undefined || before === "none")) continue; // never seen active: nothing to say
            const external_id = `${label}:${cond}`;
            if (ev.active) {
              signals.push({
                source: LOCALGIT_SOURCE,
                external_id,
                kind: KIND[cond],
                title: ev.title,
                body: truncate(ev.body, 4000),
                url: null,
                actor: null,
                occurred_at: now.toISOString(),
                metadata: { ...ev.metadata, active: true, state_hash: hash },
              });
            } else {
              signals.push({
                source: LOCALGIT_SOURCE,
                external_id,
                kind: KIND[cond],
                title: t(locale, `git.${cond}.resolved`, { repo: label }),
                body: "",
                url: null,
                actor: null,
                occurred_at: now.toISOString(),
                metadata: { repo: label, path: state.path, branch: state.branch, head: state.head, condition: cond, active: false, state_hash: hash },
              });
            }
          }
          ctx.cursors.setJson(cursorKey, next);
          ctx.logger.debug(`inspected ${label}: ${Object.entries(next).filter(([, h]) => h !== "none").map(([c]) => c).join(",") || "clean"}`);
        } catch (e) {
          warnings.add(`${label}: ${errorMessage(e)}`);
          ctx.logger.warn(`localgit ${label} failed`, { error: errorMessage(e) });
        }
      }
      return { signals, warnings: warnings.list, summary: `${inspected}/${repos.length} repos inspected, ${signals.length} state changes` };
    },
  };
}

export const localgitSensor = createLocalGitSensor();
