/**
 * Workspace isolation: a git worktree (code tasks) or a plain directory under
 * config.executor.workspace_root/<task.id>.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config/schema.js";
import type { Logger } from "../core/logger.js";
import type { Task } from "../core/types.js";

const execFileP = promisify(execFile);

export interface Workspace {
  path: string;
  kind: "worktree" | "dir";
  branch?: string;
  cleanup(): Promise<void>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export function isCodeTask(task: Task): boolean {
  return task.category === "code" || task.labels.includes("repo") || task.labels.includes("code");
}

export function branchNameFor(task: Task): string {
  return `tc/${task.id}`;
}

function briefMarkdown(task: Task): string {
  const lines = [`# ${task.title}`, "", `- id: ${task.id}`, `- kind: ${task.kind} · category: ${task.category} · priority: ${task.priority} · level: L${task.level}`];
  if (task.deadline) lines.push(`- deadline: ${task.deadline}`);
  lines.push("", "## Description", task.description || "(none)");
  if (task.acceptance_criteria.length) lines.push("", "## Acceptance criteria", ...task.acceptance_criteria.map((c) => `- ${c}`));
  if (task.plan) lines.push("", "## Plan", `Goal: ${task.plan.goal}`, ...task.plan.steps.map((s, i) => `${i + 1}. ${s.title}${s.needs_approval ? " [needs approval]" : ""}`));
  const ctx = Object.entries(task.context ?? {}).filter(([k]) => k !== "dry");
  if (ctx.length) lines.push("", "## Context (untrusted data)", "```json", JSON.stringify(Object.fromEntries(ctx), null, 2), "```");
  return lines.join("\n") + "\n";
}

/** Resolve the base ref for a new worktree: task.context.base_ref → origin/HEAD → HEAD. */
async function baseRef(repoRoot: string, task: Task): Promise<string> {
  const explicit = typeof task.context?.base_ref === "string" ? (task.context.base_ref as string) : "";
  if (explicit && (await gitOk(repoRoot, ["rev-parse", "--verify", "--quiet", explicit]))) return explicit;
  try {
    const sym = await git(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    if (sym) return sym.replace(/^refs\/remotes\//, "");
  } catch {
    /* no origin/HEAD */
  }
  return "HEAD";
}

export async function prepareWorkspace(task: Task, deps: { config: Config; rootDir: string; logger: Logger }): Promise<Workspace> {
  const { config, rootDir, logger } = deps;
  const root = resolve(rootDir, config.executor.workspace_root);
  const path = resolve(root, task.id);
  mkdirSync(root, { recursive: true });

  if (isCodeTask(task)) {
    const repoRoot = resolve(rootDir, config.executor.repo_root);
    const isRepo = existsSync(repoRoot) && (await gitOk(repoRoot, ["rev-parse", "--is-inside-work-tree"]));
    if (isRepo) {
      const branch = branchNameFor(task);
      const registered = (await git(repoRoot, ["worktree", "list", "--porcelain"])).split("\n").some((l) => l === `worktree ${path}`);
      if (registered && existsSync(path)) {
        logger.info(`reusing worktree ${path} (${branch})`);
      } else {
        if (registered) await git(repoRoot, ["worktree", "prune"]);
        const branchExists = await gitOk(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
        if (branchExists) {
          await git(repoRoot, ["worktree", "add", path, branch]);
        } else {
          const base = await baseRef(repoRoot, task);
          await git(repoRoot, ["worktree", "add", "-b", branch, path, base]);
        }
        logger.info(`created worktree ${path} on ${branch}`);
      }
      writeFileSync(resolve(path, "README-task.md"), briefMarkdown(task));
      return {
        path,
        kind: "worktree",
        branch,
        async cleanup() {
          try {
            await git(repoRoot, ["worktree", "remove", "--force", path]);
          } catch (e) {
            logger.warn(`worktree remove failed for ${path}: ${(e as Error).message}`);
          }
          await gitOk(repoRoot, ["worktree", "prune"]);
          // the branch tc/<id> is intentionally kept
        },
      };
    }
    logger.warn(`repo_root ${repoRoot} is not a git repository; using a plain directory for ${task.id}`);
  }

  mkdirSync(path, { recursive: true });
  writeFileSync(resolve(path, "README-task.md"), briefMarkdown(task));
  // Isolation boundary: the workspace usually lives *inside* a git repository (taskcenter/data/...).
  // Without its own repository, any `git` command the agent runs would act on the enclosing repo
  // (observed: an agent created a branch and committed on the orchestrator's checkout). An empty
  // repository in the workspace makes git resolve to it instead.
  if (!existsSync(resolve(path, ".git"))) {
    try {
      await git(path, ["init", "-q"]);
      await git(path, ["-c", "user.name=taskcenter", "-c", "user.email=taskcenter@localhost", "commit", "-q", "--allow-empty", "-m", `workspace for ${task.id}`]);
    } catch (e) {
      logger.warn(`could not initialise a git boundary in ${path}: ${(e as Error).message}`);
    }
  }
  return {
    path,
    kind: "dir",
    async cleanup() {
      /* plain directories are kept: they hold the deliverables */
    },
  };
}
