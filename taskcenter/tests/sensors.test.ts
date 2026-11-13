import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, utimesSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";
import type { LoadedConfig } from "../src/config/load.js";
import { openDb } from "../src/core/db.js";
import { silentLogger } from "../src/core/logger.js";
import { Repo } from "../src/core/repo.js";
import { createSensors, makeSensorContext, getSensor, type SensorEntry } from "../src/sensors/registry.js";
import { captureSignal, manualSensor } from "../src/sensors/manual.js";
import { createFsDocsSensor, extractTodos } from "../src/sensors/fsdocs.js";
import { createLocalGitSensor, parsePorcelain, parseTrack, evaluateConditions, inspectRepo, defaultGit } from "../src/sensors/localgit.js";
import { excerpt, stripHtml, sha1, runCommand, commandExists, safeFetch, firstLine, Warnings } from "../src/sensors/util.js";
import { t } from "../src/sensors/i18n.js";

const TASKCENTER_ROOT = resolve(import.meta.dirname, "..");
const tmpDirs: string[] = [];
function tmp(prefix = "tc-sensors-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function harness(rootDir = TASKCENTER_ROOT) {
  const db = openDb(":memory:");
  const repo = new Repo(db);
  const loaded: LoadedConfig = {
    config: ConfigSchema.parse({}),
    configPath: null,
    rootDir,
    resolve: (p: string) => (p.startsWith("/") ? p : resolve(rootDir, p)),
  };
  return { db, repo, loaded };
}

function ctxFor(entry: SensorEntry, h: ReturnType<typeof harness>, now?: Date) {
  return makeSensorContext(entry, { repo: h.repo, logger: silentLogger, loaded: h.loaded, now: now ? () => now : undefined });
}

describe("sensors/util", () => {
  it("excerpt trims, collapses and cuts", () => {
    expect(excerpt("  a\r\n\r\n\r\n\r\nb  ", 100)).toBe("a\n\nb");
    expect(excerpt("x".repeat(50), 10).length).toBe(10);
    expect(excerpt("x".repeat(50), 10).endsWith("…")).toBe(true);
    expect(excerpt(null)).toBe("");
  });
  it("stripHtml produces readable text", () => {
    const html = `<html><head><style>p{}</style></head><body><h1>Hi &amp; bye</h1><p>one<br>two</p><ul><li>a</li><li>b</li></ul><script>x()</script></body></html>`;
    const text = stripHtml(html);
    expect(text).toContain("Hi & bye");
    expect(text).toContain("one\ntwo");
    expect(text).toContain("- a");
    expect(text).not.toContain("x()");
    expect(text).not.toContain("<");
  });
  it("hashes and first lines", () => {
    expect(sha1("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(firstLine("\n\n# Title here\nbody")).toBe("Title here");
  });
  it("runCommand never throws", async () => {
    const ok = await runCommand("git", ["--version"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("git version");
    const missing = await runCommand("definitely-not-a-binary-xyz", []);
    expect(missing.code).toBe(null);
    expect(missing.error).toContain("ENOENT");
    const bad = await runCommand("git", ["not-a-command"]);
    expect(bad.code).not.toBe(0);
    expect(commandExists("git")).toBe(true);
    expect(commandExists("definitely-not-a-binary-xyz")).toBe(false);
  });
  it("safeFetch retries transient failures and respects HTTP errors", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      if (calls === 1) throw new Error("fetch failed: ECONNRESET");
      return new Response("{}", { status: 503 });
    };
    const res = await safeFetch("https://example.invalid/x", {}, { fetchImpl, retries: 2, backoffMs: 1 });
    expect(res.status).toBe(503);
    expect(calls).toBe(3);
  });
  it("Warnings dedupes", () => {
    const w = new Warnings(2);
    w.add("a");
    w.add("a");
    w.add("b");
    w.add("c");
    expect(w.list).toEqual(["a", "b"]);
  });
  it("i18n falls back and substitutes", () => {
    expect(t("zh-CN", "git.label.branch")).toBe("分支");
    expect(t("en", "git.uncommitted.title", { repo: "r", n: 2, branch: "main" })).toBe("r: 2 uncommitted change(s) on main");
    expect(t("fr", "git.label.branch")).toBe("Branch");
    expect(t("en", "missing.key")).toBe("missing.key");
  });
});

describe("sensors/registry", () => {
  it("creates one entry per sensor with enabled = config.enabled && configured", () => {
    const config = ConfigSchema.parse({
      sensors: {
        github: { enabled: true, repos: ["kingwonn/agentic-inbox"], use_gh_cli: true },
        imap: { enabled: true, user: "", password: "" }, // enabled but missing credentials
        ics: { enabled: false, urls: ["https://example.com/a.ics"] },
        localgit: { enabled: true, repos: [".."] },
        fsdocs: { enabled: true, paths: [] },
        manual: { enabled: true },
      },
    });
    const entries = createSensors(config);
    const byName = Object.fromEntries(entries.map((e) => [e.sensor.name, e]));
    expect(Object.keys(byName).sort()).toEqual(["fsdocs", "github", "ics", "imap", "localgit", "manual"]);
    expect(byName.github.enabled).toBe(true);
    expect(byName.imap.enabled).toBe(false);
    expect(byName.ics.enabled).toBe(false);
    expect(byName.localgit.enabled).toBe(true);
    expect(byName.fsdocs.enabled).toBe(false);
    expect(byName.manual.enabled).toBe(true);
    expect(byName.manual.config.capture_dir).toBe("./data/capture");
    expect(byName.github.config.locale).toBe("zh-CN");
    expect(getSensor("ics")?.name).toBe("ics");
  });

  it("builds a context whose cursors are scoped by sensor name", () => {
    const h = harness();
    const [a, b] = createSensors(h.loaded.config).filter((e) => e.sensor.name === "manual" || e.sensor.name === "localgit");
    const ca = ctxFor(a, h);
    const cb = ctxFor(b, h);
    ca.cursors.set("k", "1");
    cb.cursors.setJson("k", { x: 2 });
    expect(ca.cursors.get("k")).toBe("1");
    expect(cb.cursors.getJson("k", {})).toEqual({ x: 2 });
    expect(h.repo.cursors.get(a.sensor.name, "k")).toBe("1");
    expect(ca.rootDir).toBe(TASKCENTER_ROOT);
    expect(ca.resolvePath("data")).toBe(resolve(TASKCENTER_ROOT, "data"));
    expect(ca.now()).toBeInstanceOf(Date);
  });
});

describe("sensors/manual", () => {
  it("turns drop-folder files into signals and moves them to processed/", async () => {
    const dir = tmp();
    const capture = join(dir, "capture");
    mkdirSync(capture);
    writeFileSync(join(capture, "idea.md"), "# Build a thing\n\nSome details here.\n");
    writeFileSync(join(capture, "note.txt"), "   \n");
    writeFileSync(join(capture, "ignore.json"), "{}");
    const h = harness(dir);
    const entry: SensorEntry = { sensor: manualSensor, config: { enabled: true, capture_dir: capture }, enabled: true };
    const res = await manualSensor.poll(ctxFor(entry, h));
    expect(res.signals.length).toBe(1);
    expect(res.signals[0]).toMatchObject({ source: "manual", external_id: "idea.md", kind: "manual", title: "Build a thing", actor: "user" });
    expect(res.signals[0].body).toContain("Some details here.");
    expect(existsSync(join(capture, "idea.md"))).toBe(false);
    expect(existsSync(join(capture, "processed", "idea.md"))).toBe(true);
    expect(existsSync(join(capture, "processed", "note.txt"))).toBe(true); // empty files are moved, not emitted
    expect(existsSync(join(capture, "ignore.json"))).toBe(true);
    const again = await manualSensor.poll(ctxFor(entry, h));
    expect(again.signals.length).toBe(0);
  });

  it("captureSignal upserts directly", () => {
    const h = harness();
    const s = captureSignal(h.repo, "Call the bank about the card\nbefore Friday", "cli", { url: "https://bank.example" });
    expect(s.source).toBe("manual");
    expect(s.title).toBe("Call the bank about the card");
    expect(s.actor).toBe("cli");
    expect(s.url).toBe("https://bank.example");
    expect(h.repo.signals.getByExternal("manual", s.external_id)?.id).toBe(s.id);
    expect(() => captureSignal(h.repo, "   ", "cli")).toThrow();
    const s2 = captureSignal(h.repo, "same text", "api", { externalId: "fixed" });
    const s3 = captureSignal(h.repo, "same text", "api", { externalId: "fixed" });
    expect(s2.id).toBe(s3.id);
  });
});

describe("sensors/fsdocs", () => {
  it("extracts todos", () => {
    const todos = extractTodos("hello\nTODO: one\n- [ ] two\n- [x] done\nFIXME three\n");
    expect(todos).toEqual(["TODO: one", "- [ ] two", "FIXME three"]);
  });

  it("emits document signals for new/changed files only", async () => {
    const dir = tmp();
    const docs = join(dir, "notes");
    mkdirSync(join(docs, "sub"), { recursive: true });
    mkdirSync(join(docs, "node_modules"), { recursive: true });
    writeFileSync(join(docs, "a.md"), "# Plan\n\nTODO: write tests\n- [ ] ship it\n");
    writeFileSync(join(docs, "sub", "b.txt"), "plain text note");
    writeFileSync(join(docs, "node_modules", "c.md"), "ignored");
    writeFileSync(join(docs, "big.md"), "x".repeat(3000));
    writeFileSync(join(docs, "report.docx"), "binary-ish");
    const sensor = createFsDocsSensor({ hasMarkitdown: () => false });
    const h = harness(dir);
    const entry: SensorEntry = { sensor, config: { enabled: true, paths: [docs], extensions: ["md", "txt", "docx"], max_file_kb: 2, locale: "en" }, enabled: true };
    const r1 = await sensor.poll(ctxFor(entry, h));
    const ids = r1.signals.map((s) => s.external_id).sort();
    expect(ids).toEqual([join(docs, "a.md"), join(docs, "sub", "b.txt")]);
    const a = r1.signals.find((s) => s.external_id.endsWith("a.md"))!;
    expect(a.kind).toBe("document");
    expect(a.title).toBe("New document: a.md — Plan");
    expect(a.metadata?.todos).toEqual(["TODO: write tests", "- [ ] ship it"]);
    expect(a.metadata?.changed).toBe("new");
    expect(a.body).toContain("Open items:");
    expect(r1.warnings?.some((w) => w.includes("markitdown"))).toBe(true);

    const r2 = await sensor.poll(ctxFor(entry, h));
    expect(r2.signals.length).toBe(0);

    // mtime-only change (same content) -> no signal; content change -> updated
    const past = new Date(Date.now() + 5000);
    utimesSync(join(docs, "sub", "b.txt"), past, past);
    writeFileSync(join(docs, "a.md"), "# Plan v2\n\nall done\n");
    const r3 = await sensor.poll(ctxFor(entry, h));
    expect(r3.signals.map((s) => s.external_id)).toEqual([join(docs, "a.md")]);
    expect(r3.signals[0].metadata?.changed).toBe("updated");
    expect(r3.signals[0].title).toBe("Document updated: a.md — Plan v2");
    expect(r3.signals[0].metadata?.todos).toEqual([]);

    // custom extractor handles docx
    const sensor2 = createFsDocsSensor({ extract: async (f) => (f.ext === "docx" ? "Converted DOCX content" : readFileSync(f.abs, "utf8")) });
    const r4 = await sensor2.poll(ctxFor({ ...entry, sensor: sensor2 }, h));
    expect(r4.signals.map((s) => s.external_id)).toEqual([join(docs, "report.docx")]);
    expect(r4.signals[0].body).toContain("Converted DOCX content");
  });

  it("warns on missing paths instead of throwing", async () => {
    const sensor = createFsDocsSensor({ hasMarkitdown: () => false });
    const h = harness();
    const entry: SensorEntry = { sensor, config: { enabled: true, paths: ["/nonexistent/path/xyz"] }, enabled: true };
    const r = await sensor.poll(ctxFor(entry, h));
    expect(r.signals).toEqual([]);
    expect(r.warnings?.[0]).toContain("path not found");
  });
});

describe("sensors/localgit", () => {
  it("parses porcelain and tracking info", () => {
    expect(parsePorcelain(" M a.ts\n?? b.ts\nUU c.ts\nR  old -> new\n")).toEqual([
      { code: " M", path: "a.ts" },
      { code: "??", path: "b.ts" },
      { code: "UU", path: "c.ts" },
      { code: "R ", path: "new" },
    ]);
    expect(parseTrack("[ahead 3, behind 1]")).toEqual({ ahead: 3, behind: 1, gone: false });
    expect(parseTrack("[gone]")).toEqual({ ahead: 0, behind: 0, gone: true });
    expect(parseTrack("")).toEqual({ ahead: 0, behind: 0, gone: false });
  });

  it("evaluates conditions deterministically", () => {
    const now = new Date("2026-11-05T00:00:00Z");
    const state = {
      label: "r",
      path: "/r",
      branch: "main",
      head: "abc1234",
      defaultBranch: "main",
      status: [{ code: " M", path: "a" }],
      branches: [
        { name: "main", upstream: "origin/main", track: "[ahead 2]", ahead: 2, behind: 0, gone: false, committedAt: 1762300800, sha: "abc1234" },
        { name: "old", upstream: "", track: "", ahead: 0, behind: 0, gone: false, committedAt: 1700000000, sha: "def5678", localOnly: 3 },
      ],
      conflictFiles: [],
      operation: null,
    };
    const ev = evaluateConditions(state, { now, staleDays: 30, locale: "en" });
    expect(ev.uncommitted.active).toBe(true);
    expect(ev.unpushed.active).toBe(true);
    expect(ev.unpushed.body).toContain("main → origin/main: 2 commit(s) ahead");
    expect(ev.unpushed.body).toContain("old: no upstream, 3 local-only commit(s)");
    expect(ev.stale.active).toBe(true);
    expect((ev.stale.metadata.branches as Array<{ name: string }>).map((b) => b.name)).toEqual(["old"]);
    expect(ev.conflicts.active).toBe(false);
    expect(ev.detached.active).toBe(false);
  });

  it("emits per-condition signals on change only (temp repo)", async () => {
    const dir = tmp();
    const repoDir = join(dir, "proj");
    mkdirSync(repoDir);
    const git = (args: string[], env: Record<string, string> = {}) =>
      execFileSync("git", args, { cwd: repoDir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x", ...env }, stdio: "pipe" }).toString();
    git(["init", "-q", "-b", "main"]);
    writeFileSync(join(repoDir, "a.txt"), "one\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    git(["checkout", "-q", "-b", "old-feature"]);
    writeFileSync(join(repoDir, "b.txt"), "two\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "old work"], { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old });
    git(["checkout", "-q", "main"]);
    writeFileSync(join(repoDir, "a.txt"), "changed\n");
    writeFileSync(join(repoDir, "untracked.txt"), "new\n");

    const sensor = createLocalGitSensor();
    const h = harness(dir);
    const entry: SensorEntry = { sensor, config: { enabled: true, repos: ["proj"], stale_days: 30, locale: "en" }, enabled: true };
    const r1 = await sensor.poll(ctxFor(entry, h));
    expect(r1.warnings ?? []).toEqual([]);
    const kinds1 = r1.signals.map((s) => s.kind).sort();
    expect(kinds1).toEqual(["stale_branches", "uncommitted_changes"]);
    const unc = r1.signals.find((s) => s.kind === "uncommitted_changes")!;
    expect(unc.external_id).toBe("proj:uncommitted");
    expect(unc.metadata?.count).toBe(2);
    expect(unc.metadata?.untracked).toBe(1);
    expect(unc.title).toBe("proj: 2 uncommitted change(s) on main");
    const stale = r1.signals.find((s) => s.kind === "stale_branches")!;
    expect(stale.external_id).toBe("proj:stale");
    expect((stale.metadata?.branches as Array<{ name: string }>)[0].name).toBe("old-feature");

    // unchanged -> nothing
    const r2 = await sensor.poll(ctxFor(entry, h));
    expect(r2.signals).toEqual([]);

    // clean tree -> resolved signal once
    git(["checkout", "--", "a.txt"]);
    rmSync(join(repoDir, "untracked.txt"));
    const r3 = await sensor.poll(ctxFor(entry, h));
    expect(r3.signals.length).toBe(1);
    expect(r3.signals[0]).toMatchObject({ external_id: "proj:uncommitted", kind: "uncommitted_changes" });
    expect(r3.signals[0].metadata?.active).toBe(false);
    expect(r3.signals[0].title).toBe("proj: working tree is clean again");

    // detached head
    git(["checkout", "-q", "--detach"]);
    const r4 = await sensor.poll(ctxFor(entry, h));
    expect(r4.signals.map((s) => s.kind)).toEqual(["detached_head"]);
    git(["checkout", "-q", "main"]);
    const r5 = await sensor.poll(ctxFor(entry, h));
    expect(r5.signals.map((s) => [s.kind, s.metadata?.active])).toEqual([["detached_head", false]]);

    // missing repo path -> warning, not throw
    const r6 = await sensor.poll(ctxFor({ ...entry, config: { ...entry.config, repos: ["nope"] } }, h));
    expect(r6.signals).toEqual([]);
    expect(r6.warnings?.[0]).toContain("repo path not found");
  });

  it("inspects the live agentic-inbox repo (config repos: [..])", async () => {
    const h = harness();
    const state = await inspectRepo(resolve(TASKCENTER_ROOT, ".."), defaultGit);
    expect(state.label).toBe("agentic-inbox");
    expect(state.head.length).toBeGreaterThanOrEqual(7);
    expect(state.branches.some((b) => b.name === "feat/taskcenter" || b.name === "main")).toBe(true);
    const entries = createSensors(ConfigSchema.parse({ sensors: { localgit: { enabled: true, repos: [".."] } } }));
    const entry = entries.find((e) => e.sensor.name === "localgit")!;
    expect(entry.enabled).toBe(true);
    const r = await entry.sensor.poll(ctxFor(entry, h));
    expect(r.warnings ?? []).toEqual([]);
    expect(r.summary).toContain("1/1 repos inspected");
    for (const s of r.signals) {
      expect(s.source).toBe("localgit");
      expect(s.external_id.startsWith("agentic-inbox:")).toBe(true);
      expect(h.repo.signals.upsert(s).isNew).toBe(true);
    }
    expect(h.repo.cursors.get("localgit", "state:agentic-inbox")).toBeTruthy();
    // second poll is idempotent
    const r2 = await entry.sensor.poll(ctxFor(entry, h));
    expect(r2.signals.length).toBe(0);
  });
});

describe("drop folder bookkeeping", () => {
  it("does not leave stray files in the repo data dir", () => {
    // sanity: the manual sensor default dir is under data/, which is gitignored
    const gi = readFileSync(resolve(TASKCENTER_ROOT, ".gitignore"), "utf8");
    expect(gi).toContain("data/");
    expect(readdirSync(resolve(TASKCENTER_ROOT, "tests", "fixtures"))).toContain("calendar.ics");
  });
});
