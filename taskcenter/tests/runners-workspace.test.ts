/**
 * Live git worktree test against this repository (repo_root = ..).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { branchNameFor, isCodeTask, prepareWorkspace } from "../src/runners/workspace.js";
import { cfg, ROOT, task } from "./brain-helpers.js";
import { silentLogger } from "../src/core/logger.js";

const repoRoot = resolve(ROOT, "..");
const wsRoot = mkdtempSync(join(tmpdir(), "tc-ws-"));
const branches: string[] = [];

function git(args: string[], cwd = repoRoot): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

afterAll(() => {
  for (const b of branches) {
    try {
      git(["worktree", "prune"]);
      git(["branch", "-D", b]);
    } catch {
      /* already gone */
    }
  }
  rmSync(wsRoot, { recursive: true, force: true });
});

describe("workspace", () => {
  const config = cfg({ executor: { workspace_root: wsRoot, repo_root: ".." } });

  it("creates, reuses and cleans up a git worktree for code tasks (branch kept)", async () => {
    const t = task({ id: `tsk_ws${Date.now().toString(36)}`, category: "code", title: "Worktree test" });
    expect(isCodeTask(t)).toBe(true);
    const branch = branchNameFor(t);
    branches.push(branch);
    const ws = await prepareWorkspace(t, { config, rootDir: ROOT, logger: silentLogger });
    expect(ws.kind).toBe("worktree");
    expect(ws.branch).toBe(branch);
    expect(ws.path).toBe(join(wsRoot, t.id));
    expect(existsSync(join(ws.path, "README-task.md"))).toBe(true);
    expect(readFileSync(join(ws.path, "README-task.md"), "utf8")).toContain("# Worktree test");
    expect(git(["branch", "--show-current"], ws.path)).toBe(branch);
    expect(git(["rev-parse", "HEAD"], ws.path)).toBe(git(["rev-parse", "HEAD"]));
    expect(existsSync(join(ws.path, "taskcenter", "package.json"))).toBe(true);
    expect(git(["worktree", "list", "--porcelain"])).toContain(`worktree ${ws.path}`);

    // reuse
    const again = await prepareWorkspace(t, { config, rootDir: ROOT, logger: silentLogger });
    expect(again.path).toBe(ws.path);
    expect(again.kind).toBe("worktree");

    await ws.cleanup();
    expect(existsSync(ws.path)).toBe(false);
    expect(git(["worktree", "list", "--porcelain"])).not.toContain(`worktree ${ws.path}`);
    expect(git(["branch", "--list", branch])).toContain(branch); // branch survives cleanup

    // re-prepare after cleanup re-attaches the existing branch
    const third = await prepareWorkspace(t, { config, rootDir: ROOT, logger: silentLogger });
    expect(git(["branch", "--show-current"], third.path)).toBe(branch);
    await third.cleanup();
  });

  it("uses a plain directory for non-code tasks", async () => {
    const t = task({ id: `tsk_dir${Date.now().toString(36)}`, category: "writing", acceptance_criteria: ["done"] });
    const ws = await prepareWorkspace(t, { config, rootDir: ROOT, logger: silentLogger });
    expect(ws.kind).toBe("dir");
    expect(ws.path).toBe(join(wsRoot, t.id));
    const md = readFileSync(join(ws.path, "README-task.md"), "utf8");
    expect(md).toContain("## Acceptance criteria");
    await ws.cleanup();
    expect(existsSync(ws.path)).toBe(true); // deliverables are kept
  });

  it("falls back to a directory when repo_root is not a git repo", async () => {
    const t = task({ id: `tsk_nogit${Date.now().toString(36)}`, category: "code" });
    const ws = await prepareWorkspace(t, { config: cfg({ executor: { workspace_root: wsRoot, repo_root: mkdtempSync(join(tmpdir(), "tc-nogit-")) } }), rootDir: ROOT, logger: silentLogger });
    expect(ws.kind).toBe("dir");
  });
});
