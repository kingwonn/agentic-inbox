import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";
import type { LoadedConfig } from "../src/config/load.js";
import { openDb } from "../src/core/db.js";
import { silentLogger } from "../src/core/logger.js";
import { Repo } from "../src/core/repo.js";
import { createGithubSensor, createGhCliApi, createTokenApi, githubSensor, reviewDecision, summarizeChecks, type GithubApi, type GithubApiResult } from "../src/sensors/github.js";
import { createSensors, makeSensorContext, type SensorEntry } from "../src/sensors/registry.js";
import { commandExists, SensorConfigError } from "../src/sensors/util.js";

const ROOT = resolve(import.meta.dirname, "..");
const NOW = new Date("2026-11-05T12:00:00Z");

function harness() {
  const repo = new Repo(openDb(":memory:"));
  const loaded: LoadedConfig = { config: ConfigSchema.parse({}), configPath: null, rootDir: ROOT, resolve: (p) => (p.startsWith("/") ? p : resolve(ROOT, p)) };
  return { repo, loaded };
}

type Route = (query: URLSearchParams) => GithubApiResult;

/** Route table keyed by path (without query string); counts calls per path. */
class FakeApi implements GithubApi {
  readonly mode = "token" as const;
  calls: string[] = [];
  constructor(public routes: Record<string, Route | unknown>) {}
  async request<T>(path: string): Promise<GithubApiResult<T>> {
    const [p, qs] = path.split("?");
    this.calls.push(p);
    const route = this.routes[p];
    if (route === undefined) return { ok: false, status: 404, data: undefined, error: "HTTP 404: Not Found" };
    const r = typeof route === "function" ? (route as Route)(new URLSearchParams(qs ?? "")) : { ok: true, status: 200, data: route };
    return r as GithubApiResult<T>;
  }
  /** Exact path matches. */
  count(path: string): number {
    return this.calls.filter((c) => c === path).length;
  }
  countPrefix(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }
}

const REPO = "kingwonn/agentic-inbox";
const BASE = `repos/${REPO}`;
const pr1 = {
  number: 1,
  title: "Mailbox auto-resolution helper",
  body: "Adds a helper.\n\n" + "x".repeat(3000),
  state: "open",
  draft: false,
  html_url: `https://github.com/${REPO}/pull/1`,
  user: { login: "kingwonn" },
  head: { ref: "codex/analyze", sha: "aaaa1111aaaa1111", repo: { full_name: REPO } },
  base: { ref: "sparkai-email", sha: "bbbb2222" },
  labels: [{ name: "enhancement" }],
  assignees: [],
  requested_reviewers: [{ login: "reviewer1" }],
  created_at: "2026-04-10T00:00:00Z",
  updated_at: "2026-04-19T04:32:42Z",
  merged_at: null,
};
const issue3 = {
  number: 3,
  title: "Dashboard crashes on empty inbox",
  body: "Steps to reproduce...",
  state: "open",
  html_url: `https://github.com/${REPO}/issues/3`,
  user: { login: "someone" },
  labels: [{ name: "bug" }],
  assignees: [{ login: "kingwonn" }],
  comments: 2,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-02T00:00:00Z",
};

function routes(overrides: Record<string, Route | unknown> = {}): Record<string, Route | unknown> {
  return {
    [BASE]: { default_branch: "main" },
    [`${BASE}/pulls`]: (q: URLSearchParams) => ({ ok: true, status: 200, data: q.get("state") === "open" ? [pr1] : [] }),
    [`${BASE}/pulls/1`]: { ...pr1, mergeable_state: "clean", mergeable: true },
    [`${BASE}/pulls/1/reviews`]: [
      { user: { login: "r2" }, state: "COMMENTED", submitted_at: "2026-04-11T00:00:00Z" },
      { user: { login: "r1" }, state: "CHANGES_REQUESTED", submitted_at: "2026-04-12T00:00:00Z" },
      { user: { login: "r1" }, state: "APPROVED", submitted_at: "2026-04-13T00:00:00Z" },
    ],
    [`${BASE}/commits/aaaa1111aaaa1111/check-runs`]: {
      total_count: 3,
      check_runs: [
        { id: 1, name: "build", status: "completed", conclusion: "success" },
        { id: 2, name: "test", status: "completed", conclusion: "failure", html_url: "https://ci/2" },
        { id: 3, name: "lint", status: "in_progress", conclusion: null },
      ],
    },
    [`${BASE}/issues`]: (q: URLSearchParams) => ({ ok: true, status: 200, data: q.get("state") === "open" ? [issue3, { ...issue3, number: 1, pull_request: {} }] : [] }),
    [`${BASE}/commits`]: [
      { sha: "c1c1c1c1c1c1c1", html_url: "https://github.com/x/commit/c1", commit: { message: "feat: new thing\n\nbody", author: { name: "K", date: "2026-11-04T10:00:00Z" }, committer: { date: "2026-11-04T10:00:00Z" } }, author: { login: "kingwonn" } },
      { sha: "c2c2c2c2c2c2c2", html_url: "https://github.com/x/commit/c2", commit: { message: "fix: bug", author: { name: "K", date: "2026-11-03T10:00:00Z" }, committer: { date: "2026-11-03T10:00:00Z" } }, author: null },
    ],
    [`${BASE}/branches`]: [
      { name: "main", commit: { sha: "mmmm" } },
      { name: "codex/analyze", commit: { sha: "aaaa1111aaaa1111" } },
      { name: "sparkai-email", commit: { sha: "bbbb2222" } },
      { name: "merged-old", commit: { sha: "dddd" } },
    ],
    [`${BASE}/commits/aaaa1111aaaa1111`]: { sha: "aaaa1111aaaa1111", commit: { committer: { date: "2026-04-19T00:00:00Z" } } },
    [`${BASE}/commits/bbbb2222`]: { sha: "bbbb2222", commit: { committer: { date: "2026-04-01T00:00:00Z" } } },
    [`${BASE}/commits/dddd`]: { sha: "dddd", commit: { committer: { date: "2026-01-01T00:00:00Z" } } },
    [`${BASE}/compare/main...codex%2Fanalyze`]: { ahead_by: 5, behind_by: 2 },
    [`${BASE}/compare/main...sparkai-email`]: { ahead_by: 3, behind_by: 10 },
    [`${BASE}/compare/main...merged-old`]: { ahead_by: 0, behind_by: 40 },
    notifications: () => ({ ok: false, status: 403, data: undefined, error: "HTTP 403: This GitHub API path is not available" }),
    "search/issues": (q: URLSearchParams) => ({
      ok: true,
      status: 200,
      data: {
        items: q.get("q")?.includes("is:issue")
          ? [
              { ...issue3, repository_url: `https://api.github.com/repos/${REPO}` },
              { ...issue3, number: 42, title: "Elsewhere", repository_url: "https://api.github.com/repos/other/repo", html_url: "https://github.com/other/repo/issues/42" },
            ]
          : [{ ...pr1, repository_url: `https://api.github.com/repos/${REPO}` }],
      },
    }),
    ...overrides,
  };
}

function setup(api: GithubApi, config: Record<string, unknown> = {}) {
  const sensor = createGithubSensor({ api: () => api });
  const h = harness();
  const entry: SensorEntry = {
    sensor,
    config: { enabled: true, repos: [REPO], user: "kingwonn", use_gh_cli: true, include_notifications: true, include_searches: true, locale: "en", ...config },
    enabled: true,
  };
  const poll = (now = NOW) => sensor.poll(makeSensorContext(entry, { repo: h.repo, logger: silentLogger, loaded: h.loaded, now: () => now }));
  return { sensor, h, entry, poll };
}

describe("sensors/github helpers", () => {
  it("summarizes checks and review decisions", () => {
    const s = summarizeChecks("sha", [
      { id: 1, name: "a", status: "completed", conclusion: "success" },
      { id: 2, name: "b", status: "completed", conclusion: "timed_out" },
      { id: 3, name: "c", status: "queued", conclusion: null },
    ]);
    expect(s).toEqual({ sha: "sha", total: 3, success: 1, pending: 1, failing: ["b"] });
    expect(reviewDecision([{ user: { login: "a" }, state: "APPROVED" }], 0)).toBe("approved");
    expect(reviewDecision([{ user: { login: "a" }, state: "APPROVED", submitted_at: "1" }, { user: { login: "a" }, state: "CHANGES_REQUESTED", submitted_at: "2" }], 0)).toBe("changes_requested");
    expect(reviewDecision([{ user: { login: "a" }, state: "COMMENTED" }], 1)).toBe("review_required");
    expect(reviewDecision([], 0)).toBe(null);
  });

  it("gh api errors are parsed into status + message (fake runner)", async () => {
    const api = createGhCliApi(async (_cmd, args) => {
      if (args.includes("repos/x/y")) return { code: 0, stdout: '{"ok":1}', stderr: "", timedOut: false };
      return { code: 1, stdout: '{"message":"Not Found"}', stderr: "gh: Not Found (HTTP 404)\n", timedOut: false };
    });
    expect(await api.request("repos/x/y")).toMatchObject({ ok: true, data: { ok: 1 } });
    expect(await api.request("/notifications")).toMatchObject({ ok: false, status: 404, error: "HTTP 404: Not Found" });
    const missing = createGhCliApi(async () => ({ code: null, stdout: "", stderr: "", timedOut: false, error: "ENOENT: spawn gh" }));
    expect((await missing.request("x")).error).toContain("ENOENT");
  });

  it("token api uses Bearer auth via injected fetch", async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(input), auth: headers.get("authorization") };
      return new Response(JSON.stringify({ login: "me" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const api = createTokenApi("ghp_test", fetchImpl);
    const r = await api.request<{ login: string }>("user");
    expect(r.ok).toBe(true);
    expect(r.data?.login).toBe("me");
    expect(seen).toEqual({ url: "https://api.github.com/user", auth: "Bearer ghp_test" });
  });
});

describe("sensors/github poll (mocked api)", () => {
  it("emits PR, checks, issue, commits, stale branch and search signals; notifications 403 is a warning", async () => {
    const api = new FakeApi(routes());
    const s = setup(api);
    const r = await s.poll();
    const byId = Object.fromEntries(r.signals.map((x) => [x.external_id, x]));
    expect(Object.keys(byId).sort()).toEqual(
      [
        `pr:${REPO}#1`,
        `checks:${REPO}#1`,
        `issue:${REPO}#3`,
        `commits:${REPO}:main:c1c1c1c1c1c1`,
        `branch:${REPO}:codex/analyze`,
        `branch:${REPO}:sparkai-email`,
        "search:assigned:other/repo#42",
      ].sort(),
    );
    const pr = byId[`pr:${REPO}#1`];
    expect(pr.kind).toBe("pull_request");
    expect(pr.title).toBe("PR #1: Mailbox auto-resolution helper");
    expect(pr.url).toBe(`https://github.com/${REPO}/pull/1`);
    expect(pr.actor).toBe("kingwonn");
    expect(pr.body.length).toBeLessThan(2600);
    expect(pr.body).toContain("Branch: codex/analyze → sparkai-email");
    expect(pr.body).toContain("my review requested");
    expect(pr.metadata).toMatchObject({
      number: 1,
      state: "open",
      draft: false,
      mergeable_state: "clean",
      head: { ref: "codex/analyze", sha: "aaaa1111aaaa1111" },
      base: { ref: "sparkai-email" },
      review_decision: "approved",
      checks: { total: 3, success: 1, pending: 1, failing: ["test"] },
      updated_at: "2026-04-19T04:32:42Z",
      author: "kingwonn",
      review_requested: true,
      labels: ["enhancement"],
    });
    expect(byId[`checks:${REPO}#1`]).toMatchObject({ kind: "check_failure", title: `${REPO}#1: failing checks: test` });
    expect(byId[`issue:${REPO}#3`].metadata).toMatchObject({ number: 3, comments: 2, comments_delta: 0, assigned_to_me: true, labels: ["bug"] });
    expect(byId[`commits:${REPO}:main:c1c1c1c1c1c1`]).toMatchObject({ kind: "commits", title: `${REPO}: 2 new commit(s) on main`, actor: "kingwonn" });
    expect(byId[`commits:${REPO}:main:c1c1c1c1c1c1`].body).toContain("c1c1c1c feat: new thing (kingwonn)");
    expect(byId[`branch:${REPO}:codex/analyze`].metadata).toMatchObject({ ahead_by: 5, behind_by: 2, open_pr: 1, last_commit_at: "2026-04-19T00:00:00Z" });
    expect(byId[`branch:${REPO}:codex/analyze`].title).toBe(`${REPO}: branch codex/analyze has had no commits since 2026-04-19`);
    expect(byId["search:assigned:other/repo#42"]).toMatchObject({ kind: "assigned_issue", url: "https://github.com/other/repo/issues/42" });
    expect(r.warnings?.some((w) => w.includes("notifications unavailable"))).toBe(true);
    expect(s.h.repo.cursors.get("github", `updated_since:${REPO}`)).toBe(NOW.toISOString());
    expect(s.h.repo.cursors.get("github", "cap:notifications")).toBe(NOW.toISOString());
    const snap = s.h.repo.cursors.get("github", `snapshot:${REPO}`);
    expect(snap).toContain('"default_branch":"main"');
    for (const sig of r.signals) expect(s.h.repo.signals.upsert(sig).isNew).toBe(true);

    // second poll: open items re-emitted with identical fingerprints, no detail refetch, notifications skipped (cooldown)
    const before = api.calls.length;
    const r2 = await s.poll(new Date(NOW.getTime() + 60_000));
    expect(api.count(`${BASE}/pulls/1`)).toBe(1);
    expect(api.count(`${BASE}/commits/aaaa1111aaaa1111/check-runs`)).toBe(1);
    expect(api.count(`${BASE}/commits/bbbb2222`)).toBe(1);
    expect(api.countPrefix(`${BASE}/compare/`)).toBe(3);
    expect(api.count(`${BASE}/pulls/1/reviews`)).toBe(1);
    expect(api.count("notifications")).toBe(1);
    expect(api.calls.length - before).toBeLessThan(before);
    for (const sig of r2.signals) {
      const u = s.h.repo.signals.upsert(sig);
      expect(u.changed, `${sig.external_id} should be unchanged`).toBe(false);
    }
    // commits since cursor: the fake returns the same two commits regardless of `since`, so the batch id is stable
    expect(r2.signals.some((x) => x.kind === "commits")).toBe(true);
  });

  it("re-fetches details and reports comment deltas when items change", async () => {
    const api = new FakeApi(routes());
    const s = setup(api, { include_notifications: false, include_searches: false });
    await s.poll();
    // issue gets 2 more comments, PR head moves (checks now green), review requested cleared
    api.routes[`${BASE}/issues`] = (q: URLSearchParams) => ({ ok: true, status: 200, data: q.get("state") === "open" ? [{ ...issue3, comments: 4, updated_at: "2026-11-05T01:00:00Z" }] : [] });
    const pr1b = { ...pr1, head: { ...pr1.head, sha: "eeee3333" }, updated_at: "2026-11-05T02:00:00Z", requested_reviewers: [] };
    api.routes[`${BASE}/pulls`] = (q: URLSearchParams) => ({ ok: true, status: 200, data: q.get("state") === "open" ? [pr1b] : [] });
    api.routes[`${BASE}/pulls/1`] = { ...pr1b, mergeable_state: "dirty" };
    api.routes[`${BASE}/commits/eeee3333/check-runs`] = { check_runs: [{ id: 9, name: "test", status: "completed", conclusion: "success" }] };
    const r = await s.poll(new Date(NOW.getTime() + 3600_000));
    const byId = Object.fromEntries(r.signals.map((x) => [x.external_id, x]));
    expect(byId[`issue:${REPO}#3`].metadata).toMatchObject({ comments: 4, comments_delta: 2 });
    expect(byId[`pr:${REPO}#1`].metadata).toMatchObject({ mergeable_state: "dirty", checks: { sha: "eeee3333", failing: [] }, review_decision: "approved" });
    expect(byId[`checks:${REPO}#1`]).toMatchObject({ kind: "check_failure" });
    expect(byId[`checks:${REPO}#1`].metadata?.active).toBe(false);
    expect(api.count(`${BASE}/pulls/1`)).toBe(2);
    // the delta stays until the next change (stable fingerprint)
    const r3 = await s.poll(new Date(NOW.getTime() + 7200_000));
    expect(Object.fromEntries(r3.signals.map((x) => [x.external_id, x]))[`issue:${REPO}#3`].metadata).toMatchObject({ comments: 4, comments_delta: 2 });
    expect(r3.signals.some((x) => x.external_id === `checks:${REPO}#1`)).toBe(false);
  });

  it("closed items are emitted only when updated since the cursor", async () => {
    const api = new FakeApi(routes({ [`${BASE}/pulls`]: (q: URLSearchParams) => ({ ok: true, status: 200, data: q.get("state") === "closed" ? [{ ...pr1, state: "closed", merged_at: "2026-11-05T13:00:00Z", updated_at: "2026-11-05T13:00:00Z" }] : [] }) }));
    const s = setup(api, { include_notifications: false, include_searches: false });
    const r1 = await s.poll();
    expect(r1.signals.some((x) => x.kind === "pull_request")).toBe(false); // no cursor yet -> closed list not consulted
    const r2 = await s.poll(new Date(NOW.getTime() + 3600_000));
    const pr = r2.signals.find((x) => x.kind === "pull_request")!;
    expect(pr.metadata).toMatchObject({ state: "merged", number: 1 });
    expect(api.count(`${BASE}/pulls/1`)).toBe(0); // no detail fetch for closed PRs
    const r3 = await s.poll(new Date(NOW.getTime() + 7200_000));
    expect(r3.signals.some((x) => x.kind === "pull_request")).toBe(false);
  });

  it("network failures become warnings and do not advance the cursor", async () => {
    const api = new FakeApi(routes({ [`${BASE}/pulls`]: () => ({ ok: false, status: 0, data: undefined, error: "fetch failed: ECONNRESET" }) }));
    const s = setup(api, { include_notifications: false, include_searches: false });
    const r = await s.poll();
    expect(r.warnings?.some((w) => w.includes("ECONNRESET"))).toBe(true);
    expect(s.h.repo.cursors.get("github", `updated_since:${REPO}`)).toBeUndefined();
    expect(r.signals.some((x) => x.kind === "issue")).toBe(true); // the rest still ran
  });

  it("throws SensorConfigError without token or gh", async () => {
    const sensor = createGithubSensor({ hasGh: () => false });
    const h = harness();
    const entry: SensorEntry = { sensor, config: { enabled: true, repos: [REPO], token: "", use_gh_cli: true }, enabled: true };
    await expect(sensor.poll(makeSensorContext(entry, { repo: h.repo, logger: silentLogger, loaded: h.loaded }))).rejects.toBeInstanceOf(SensorConfigError);
    expect(sensor.configured({ repos: [], use_gh_cli: true })).toBe(false);
    expect(sensor.configured({ repos: [REPO], use_gh_cli: false, token: "" })).toBe(false);
    expect(sensor.configured({ repos: [REPO], use_gh_cli: false, token: "ghp_x" })).toBe(true);
  });
});

describe("sensors/github live (gh api, kingwonn/agentic-inbox)", () => {
  const live = commandExists("gh") && !process.env.TC_SKIP_LIVE;
  it.skipIf(!live)("returns at least the open PR #1 signal", async () => {
    const h = harness();
    const probe = await createGhCliApi().request(`repos/${REPO}`);
    if (!probe.ok) {
      console.warn(`skipping live github test: ${probe.error}`);
      return;
    }
    const entries = createSensors(ConfigSchema.parse({ sensors: { github: { enabled: true, repos: [REPO], user: "kingwonn", use_gh_cli: true, token: "" } } }));
    const entry = entries.find((e) => e.sensor.name === "github")!;
    expect(entry.enabled).toBe(true);
    const r = await githubSensor.poll(makeSensorContext(entry, { repo: h.repo, logger: silentLogger, loaded: h.loaded }));
    const ids = r.signals.map((s) => s.external_id);
    expect(ids).toContain(`pr:${REPO}#1`);
    const pr = r.signals.find((s) => s.external_id === `pr:${REPO}#1`)!;
    expect(pr.kind).toBe("pull_request");
    expect(pr.metadata).toMatchObject({ number: 1, state: "open", author: "kingwonn", head: { ref: "codex/analyze-project-for-sparkai-integration" }, base: { ref: "sparkai-email" } });
    expect(ids.some((id) => id.startsWith(`branch:${REPO}:`))).toBe(true);
    for (const s of r.signals) h.repo.signals.upsert(s);
    expect(h.repo.cursors.get("github", `updated_since:${REPO}`)).toBeTruthy();
    // repo-scoped token: notifications blocked -> warning, not failure
    expect(r.warnings?.some((w) => /notifications/.test(w)) || r.signals.some((s) => s.kind === "notification")).toBe(true);
  }, 120_000);
});
