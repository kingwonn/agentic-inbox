/**
 * GitHub sensor. Signals for configured repos (open PRs/issues, failing checks,
 * commits on the default branch, stale branches) plus, when the token allows,
 * notifications and "assigned to me" / "review requested" searches.
 *
 * Auth: `token` -> fetch with Bearer; otherwise `use_gh_cli` -> `gh api <path>`.
 * A repo-scoped token (e.g. the one Claude Code sessions get) only serves
 * `repos/{owner}/{repo}/...`; `/notifications`, `search/*` etc. are reported as
 * warnings and retried after a cool-down, never as failures.
 *
 * Cursors per repo: `updated_since:<repo>` (ISO of the last poll) and
 * `snapshot:<repo>` (last seen PR/issue/branch state, incl. cached details so
 * `pulls/{n}`, reviews and check-runs are only re-fetched when the PR changed).
 * Open items are emitted every poll from list data (repo.signals.upsert dedupes
 * by fingerprint); closed items only when they changed since the cursor.
 */
import type { NewSignal } from "../core/types.js";
import { t } from "./i18n.js";
import type { Sensor, SensorContext, SensorPollResult } from "./types.js";
import { commandExists, errorMessage, excerpt, fetchJson, runCommand, SensorConfigError, truncate, Warnings } from "./util.js";

export const GITHUB_SOURCE = "github";
const API_BASE = "https://api.github.com";
const MAX_CALLS_PER_POLL = 160;
const STALE_BRANCH_DAYS = 14;
const MAX_BRANCH_DETAILS_PER_POLL = 30;
const CAPABILITY_COOLDOWN_MS = 6 * 3600_000;
const BODY_CHARS = 2000;
const FIRST_RUN_LOOKBACK_DAYS = 7;

// ── API abstraction ─────────────────────────────────────────────────

export interface GithubApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | undefined;
  error?: string;
}

export interface GithubApi {
  readonly mode: "token" | "gh";
  request<T = unknown>(path: string): Promise<GithubApiResult<T>>;
}

export function createTokenApi(token: string, fetchImpl?: typeof fetch): GithubApi {
  return {
    mode: "token",
    async request<T>(path: string): Promise<GithubApiResult<T>> {
      const url = path.startsWith("http") ? path : `${API_BASE}/${path.replace(/^\/+/, "")}`;
      try {
        const r = await fetchJson<T>(
          url,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "taskcenter-sensor/0.1",
            },
          },
          { fetchImpl, timeoutMs: 20_000, retries: 2 },
        );
        return { ok: r.ok, status: r.status, data: r.data, error: r.error };
      } catch (e) {
        return { ok: false, status: 0, data: undefined, error: errorMessage(e) };
      }
    },
  };
}

export function createGhCliApi(run: typeof runCommand = runCommand): GithubApi {
  return {
    mode: "gh",
    async request<T>(path: string): Promise<GithubApiResult<T>> {
      const p = path.replace(/^\/+/, "");
      const r = await run("gh", ["api", "--method", "GET", "-H", "Accept: application/vnd.github+json", p], {
        timeoutMs: 25_000,
        env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
      });
      if (r.error) return { ok: false, status: 0, data: undefined, error: `gh: ${r.error}` };
      let data: T | undefined;
      try {
        data = r.stdout.trim() ? (JSON.parse(r.stdout) as T) : undefined;
      } catch {
        data = undefined;
      }
      if (r.timedOut) return { ok: false, status: 0, data, error: "gh api timed out" };
      if (r.code !== 0) {
        const m = /\(HTTP (\d{3})\)/.exec(r.stderr);
        const status = m ? Number(m[1]) : 0;
        const msg = (data as { message?: string } | undefined)?.message ?? r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`;
        return { ok: false, status, data, error: `HTTP ${status || "?"}: ${truncate(msg, 200)}` };
      }
      return { ok: true, status: 200, data };
    },
  };
}

// ── GitHub payload shapes (subset) ──────────────────────────────────

interface GhUser {
  login: string;
}
interface GhLabel {
  name: string;
}
interface GhPr {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft?: boolean;
  html_url: string;
  user: GhUser | null;
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
  base: { ref: string; sha: string };
  labels?: GhLabel[];
  assignees?: GhUser[];
  requested_reviewers?: GhUser[];
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  merged_at?: string | null;
  mergeable_state?: string;
  mergeable?: boolean | null;
  merged?: boolean;
  comments?: number;
  review_comments?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}
interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  user: GhUser | null;
  labels?: GhLabel[];
  assignees?: GhUser[];
  milestone?: { title: string } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  pull_request?: unknown;
  repository_url?: string;
  state_reason?: string | null;
}
interface GhReview {
  user: GhUser | null;
  state: string;
  submitted_at?: string;
}
interface GhCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  completed_at?: string | null;
}
interface GhCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author?: { name?: string; date?: string } | null; committer?: { name?: string; date?: string } | null };
  author?: GhUser | null;
}
interface GhBranch {
  name: string;
  commit: { sha: string };
  protected?: boolean;
}
interface GhNotification {
  id: string;
  reason: string;
  unread: boolean;
  updated_at: string;
  subject: { title: string; url: string | null; type: string };
  repository: { full_name: string; html_url?: string };
}

// ── Snapshot ────────────────────────────────────────────────────────

interface ChecksSummary {
  sha: string;
  total: number;
  success: number;
  pending: number;
  failing: string[];
}

interface PrSnap {
  updated_at: string;
  state: string;
  head: string;
  mergeable_state: string | null;
  review_decision: string | null;
  checks: ChecksSummary | null;
  checks_failing_emitted?: boolean;
}
interface IssueSnap {
  updated_at: string;
  state: string;
  comments: number;
  prev_comments: number;
}
interface BranchSnap {
  sha: string;
  date: string | null;
  ahead: number | null;
  behind: number | null;
  compared_against: string | null;
}
interface RepoSnapshot {
  default_branch?: string;
  prs: Record<string, PrSnap>;
  issues: Record<string, IssueSnap>;
  branches: Record<string, BranchSnap>;
}

function emptySnapshot(): RepoSnapshot {
  return { prs: {}, issues: {}, branches: {} };
}

// ── Helpers ─────────────────────────────────────────────────────────

const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

export function summarizeChecks(sha: string, runs: GhCheckRun[]): ChecksSummary {
  const failing = runs.filter((r) => r.conclusion && FAILING_CONCLUSIONS.has(r.conclusion)).map((r) => r.name);
  const success = runs.filter((r) => r.conclusion === "success" || r.conclusion === "neutral" || r.conclusion === "skipped").length;
  const pending = runs.filter((r) => r.status !== "completed").length;
  return { sha, total: runs.length, success, pending, failing };
}

export function reviewDecision(reviews: GhReview[], requestedReviewers: number): string | null {
  const latest = new Map<string, string>();
  const sorted = [...reviews].sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""));
  for (const r of sorted) {
    const login = r.user?.login ?? "?";
    const state = r.state?.toUpperCase();
    if (state === "COMMENTED") continue;
    if (state === "DISMISSED") latest.delete(login);
    else latest.set(login, state);
  }
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED")) return "approved";
  if (requestedReviewers > 0) return "review_required";
  return null;
}

function apiToHtmlUrl(apiUrl: string | null): string | null {
  if (!apiUrl) return null;
  return apiUrl.replace("https://api.github.com/repos/", "https://github.com/").replace("/pulls/", "/pull/").replace("/commits/", "/commit/");
}

function repoFromApiUrl(url: string | undefined): string {
  if (!url) return "";
  const m = /repos\/([^/]+\/[^/]+)/.exec(url);
  return m ? m[1] : "";
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor(Math.abs(a.getTime() - b.getTime()) / 86_400_000);
}

class CallBudget {
  calls = 0;
  constructor(
    private api: GithubApi,
    private max: number,
    private warnings: Warnings,
  ) {}
  get exhausted(): boolean {
    return this.calls >= this.max;
  }
  async get<T>(path: string): Promise<GithubApiResult<T>> {
    if (this.exhausted) {
      this.warnings.add(`api call budget (${this.max}) exhausted; remaining work deferred to next poll`);
      return { ok: false, status: 0, data: undefined, error: "budget exhausted" };
    }
    this.calls++;
    return this.api.request<T>(path);
  }
  /** Paginated GET (per_page must already be in the path). */
  async list<T>(path: string, maxPages: number): Promise<{ items: T[]; ok: boolean; error?: string; status: number }> {
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const r = await this.get<T[]>(`${path}${sep}page=${page}`);
      if (!r.ok) return { items, ok: items.length > 0, error: r.error, status: r.status };
      const batch = Array.isArray(r.data) ? r.data : [];
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return { items, ok: true, status: 200 };
  }
}

// ── Sensor ──────────────────────────────────────────────────────────

export interface GithubSensorOptions {
  /** Build the API client from the sensor config (tests inject a fake). */
  api?: (config: Record<string, unknown>) => GithubApi;
  hasGh?: () => boolean;
  fetchImpl?: typeof fetch;
}

function parseRepo(full: string): { owner: string; name: string; full: string } | null {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(full.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, ""));
  return m ? { owner: m[1], name: m[2], full: `${m[1]}/${m[2]}` } : null;
}

export function createGithubSensor(opts: GithubSensorOptions = {}): Sensor {
  const hasGh = opts.hasGh ?? (() => commandExists("gh"));

  function buildApi(config: Record<string, unknown>): GithubApi {
    if (opts.api) return opts.api(config);
    const token = typeof config.token === "string" ? config.token.trim() : "";
    if (token) return createTokenApi(token, opts.fetchImpl);
    if (config.use_gh_cli !== false && hasGh()) return createGhCliApi();
    throw new SensorConfigError("github: set sensors.github.token or install/authenticate the `gh` CLI (use_gh_cli)");
  }

  return {
    name: GITHUB_SOURCE,
    description: "GitHub: open PRs/issues, failing checks, new commits, stale branches, notifications and @me searches",

    configured(config): boolean {
      const repos = ((config.repos as string[] | undefined) ?? []).filter(Boolean);
      const token = typeof config.token === "string" && config.token.trim().length > 0;
      const gh = config.use_gh_cli !== false;
      return repos.length > 0 && (token || gh);
    },

    async poll(ctx: SensorContext): Promise<SensorPollResult> {
      const warnings = new Warnings();
      const signals: NewSignal[] = [];
      const locale = String(ctx.config.locale ?? "zh-CN");
      const now = ctx.now();
      const repos = ((ctx.config.repos as string[] | undefined) ?? []).map(parseRepo).filter((r): r is NonNullable<typeof r> => r !== null);
      if (repos.length === 0) throw new SensorConfigError("github: sensors.github.repos is empty");
      const api = buildApi(ctx.config);
      const budget = new CallBudget(api, MAX_CALLS_PER_POLL, warnings);
      const configured = new Set(repos.map((r) => r.full));
      const user = typeof ctx.config.user === "string" && ctx.config.user.trim() ? ctx.config.user.trim() : "@me";

      const capabilityOk = (key: string): boolean => {
        const last = ctx.cursors.get(`cap:${key}`);
        if (!last) return true;
        const ts = new Date(last).getTime();
        return !(Number.isFinite(ts) && now.getTime() - ts < CAPABILITY_COOLDOWN_MS);
      };
      const capabilityFailed = (key: string, what: string, err: string | undefined) => {
        ctx.cursors.set(`cap:${key}`, now.toISOString());
        warnings.add(`${what} unavailable with this token (${err ?? "error"}); retrying in ${CAPABILITY_COOLDOWN_MS / 3600_000}h`);
        ctx.logger.warn(`github ${what} unavailable`, { error: err });
      };

      // ── searches (first, so repo signals can carry the flags) ──
      const assignedToMe = new Set<string>();
      const reviewRequested = new Set<string>();
      if (ctx.config.include_searches !== false && capabilityOk("search")) {
        const queries: Array<{ key: "assigned" | "review"; q: string; kind: string; set: Set<string> }> = [
          { key: "assigned", q: `is:issue is:open assignee:${user}`, kind: "assigned_issue", set: assignedToMe },
          { key: "review", q: `is:pr is:open review-requested:${user}`, kind: "review_request", set: reviewRequested },
        ];
        for (const q of queries) {
          const r = await budget.get<{ items?: GhIssue[] }>(`search/issues?q=${encodeURIComponent(q.q)}&per_page=50&sort=updated`);
          if (!r.ok) {
            capabilityFailed("search", "search", r.error);
            break;
          }
          for (const item of r.data?.items ?? []) {
            const repo = repoFromApiUrl(item.repository_url);
            const ref = `${repo}#${item.number}`;
            q.set.add(ref);
            if (configured.has(repo)) continue; // flagged on the repo signal instead
            signals.push({
              source: GITHUB_SOURCE,
              external_id: `search:${q.key}:${ref}`,
              kind: q.kind,
              title: `${repo}#${item.number}: ${item.title}`,
              body: [
                `${t(locale, q.key === "assigned" ? "gh.label.assignedToMe" : "gh.label.reviewRequested")} · ${t(locale, "gh.label.author")}: ${item.user?.login ?? "?"} · ${t(locale, "gh.label.updated")}: ${item.updated_at}`,
                "",
                excerpt(item.body, BODY_CHARS),
              ].join("\n"),
              url: item.html_url,
              actor: item.user?.login ?? null,
              occurred_at: item.updated_at,
              metadata: {
                repo,
                number: item.number,
                state: item.state,
                labels: (item.labels ?? []).map((l) => l.name),
                author: item.user?.login ?? null,
                updated_at: item.updated_at,
                comments: item.comments,
                search: q.key,
              },
            });
          }
        }
      }

      // ── per repo ──
      let repoOk = 0;
      for (const repo of repos) {
        if (budget.exhausted) break;
        const cursorKey = `updated_since:${repo.full}`;
        const since = ctx.cursors.get(cursorKey) ?? null;
        const snapKey = `snapshot:${repo.full}`;
        const snap = ctx.cursors.getJson<RepoSnapshot>(snapKey, emptySnapshot());
        snap.prs ??= {};
        snap.issues ??= {};
        snap.branches ??= {};
        const base = `repos/${repo.owner}/${repo.name}`;
        const pollStart = now.toISOString();
        let healthy = true;
        const fail = (what: string, err: string | undefined) => {
          healthy = false;
          warnings.add(`${repo.full} ${what}: ${err ?? "error"}`);
        };

        // default branch
        if (!snap.default_branch) {
          const r = await budget.get<{ default_branch?: string }>(base);
          if (r.ok && r.data?.default_branch) snap.default_branch = r.data.default_branch;
          else if (r.status === 404 || r.status === 401 || r.status === 403) {
            fail("repo", r.error);
            ctx.logger.warn(`github repo ${repo.full} not accessible`, { error: r.error });
            continue;
          } else fail("repo", r.error);
        }
        const defaultBranch = snap.default_branch ?? "main";

        // ── pull requests ──
        const openPrs = await budget.list<GhPr>(`${base}/pulls?state=open&per_page=100&sort=updated&direction=desc`, 3);
        if (!openPrs.ok) fail("pulls", openPrs.error);
        let closedPrs: GhPr[] = [];
        if (since) {
          const r = await budget.get<GhPr[]>(`${base}/pulls?state=closed&per_page=30&sort=updated&direction=desc`);
          if (r.ok) closedPrs = (r.data ?? []).filter((p) => p.updated_at > since);
          else fail("pulls(closed)", r.error);
        }
        const openPrNumbers = new Set(openPrs.items.map((p) => p.number));
        const openPrHeads = new Map<string, number>();
        for (const pr of [...openPrs.items, ...closedPrs]) {
          const key = String(pr.number);
          const prev = snap.prs[key];
          const changed = !prev || prev.updated_at !== pr.updated_at || prev.state !== pr.state || prev.head !== pr.head.sha;
          if (pr.state === "open") openPrHeads.set(pr.head.ref, pr.number);
          let mergeableState = prev?.mergeable_state ?? null;
          let decision = prev?.review_decision ?? null;
          let checks = prev?.checks ?? null;
          if (pr.state === "open" && (changed || !checks || checks.sha !== pr.head.sha)) {
            const detail = await budget.get<GhPr>(`${base}/pulls/${pr.number}`);
            if (detail.ok && detail.data) mergeableState = detail.data.mergeable_state ?? null;
            const reviews = await budget.get<GhReview[]>(`${base}/pulls/${pr.number}/reviews?per_page=100`);
            if (reviews.ok) decision = reviewDecision(reviews.data ?? [], (pr.requested_reviewers ?? []).length);
            const cr = await budget.get<{ check_runs?: GhCheckRun[] }>(`${base}/commits/${pr.head.sha}/check-runs?per_page=100`);
            checks = cr.ok ? summarizeChecks(pr.head.sha, cr.data?.check_runs ?? []) : cr.status === 404 ? summarizeChecks(pr.head.sha, []) : checks;
          }
          const ref = `${repo.full}#${pr.number}`;
          const labels = (pr.labels ?? []).map((l) => l.name);
          const flags: string[] = [];
          if (pr.draft) flags.push(t(locale, "gh.label.draft"));
          if (assignedToMe.has(ref)) flags.push(t(locale, "gh.label.assignedToMe"));
          if (reviewRequested.has(ref)) flags.push(t(locale, "gh.label.reviewRequested"));
          const checksText = checks
            ? checks.total === 0
              ? "—"
              : `${checks.success}/${checks.total} ok${checks.pending ? `, ${checks.pending} pending` : ""}${checks.failing.length ? `, failing: ${checks.failing.join(", ")}` : ""}`
            : "?";
          const facts = [
            `${t(locale, "gh.label.state")}: ${pr.merged_at ? "merged" : pr.state}${flags.length ? ` (${flags.join(", ")})` : ""}`,
            `${t(locale, "gh.label.branch")}: ${pr.head.ref} → ${pr.base.ref}`,
            `${t(locale, "gh.label.author")}: ${pr.user?.login ?? "?"} · ${t(locale, "gh.label.updated")}: ${pr.updated_at}`,
            `${t(locale, "gh.label.checks")}: ${checksText}`,
            `${t(locale, "gh.label.review")}: ${decision ?? "—"}`,
            ...(mergeableState ? [`${t(locale, "gh.label.mergeable")}: ${mergeableState}`] : []),
            ...(labels.length ? [`${t(locale, "gh.label.labels")}: ${labels.join(", ")}`] : []),
          ];
          if (pr.state === "open" || changed) {
            signals.push({
              source: GITHUB_SOURCE,
              external_id: `pr:${ref}`,
              kind: "pull_request",
              title: t(locale, "gh.pr.title", { n: pr.number, title: pr.title }),
              body: `${facts.join("\n")}\n\n${excerpt(pr.body, BODY_CHARS)}`.trim(),
              url: pr.html_url,
              actor: pr.user?.login ?? null,
              occurred_at: pr.updated_at,
              metadata: {
                repo: repo.full,
                number: pr.number,
                state: pr.merged_at ? "merged" : pr.state,
                draft: Boolean(pr.draft),
                mergeable_state: mergeableState,
                head: { ref: pr.head.ref, sha: pr.head.sha, repo: pr.head.repo?.full_name ?? repo.full },
                base: { ref: pr.base.ref, sha: pr.base.sha },
                review_decision: decision,
                checks,
                updated_at: pr.updated_at,
                created_at: pr.created_at,
                closed_at: pr.closed_at ?? null,
                merged_at: pr.merged_at ?? null,
                author: pr.user?.login ?? null,
                labels,
                assignees: (pr.assignees ?? []).map((u) => u.login),
                requested_reviewers: (pr.requested_reviewers ?? []).map((u) => u.login),
                assigned_to_me: assignedToMe.has(ref),
                review_requested: reviewRequested.has(ref),
              },
            });
          }
          // failing checks on open PR heads
          const failingNow = pr.state === "open" && checks !== null && checks.failing.length > 0;
          const wasFailing = prev?.checks_failing_emitted === true;
          if (failingNow || (wasFailing && pr.state === "open")) {
            signals.push({
              source: GITHUB_SOURCE,
              external_id: `checks:${ref}`,
              kind: "check_failure",
              title: failingNow
                ? t(locale, "gh.checks.failing.title", { repo: repo.full, n: pr.number, names: checks!.failing.slice(0, 5).join(", ") })
                : `${repo.full}#${pr.number}: ${t(locale, "gh.label.checks")} ok`,
              body: `${pr.title}\n${pr.head.ref} @ ${pr.head.sha.slice(0, 7)}\n${checksText}`,
              url: `${pr.html_url}/checks`,
              actor: pr.user?.login ?? null,
              occurred_at: pr.updated_at,
              metadata: { repo: repo.full, number: pr.number, head: pr.head.sha, checks, active: failingNow },
            });
          }
          snap.prs[key] = {
            updated_at: pr.updated_at,
            state: pr.state,
            head: pr.head.sha,
            mergeable_state: mergeableState,
            review_decision: decision,
            checks,
            checks_failing_emitted: failingNow,
          };
        }
        // prune closed PRs from the snapshot after a month
        for (const [k, v] of Object.entries(snap.prs)) {
          if (!openPrNumbers.has(Number(k)) && v.state !== "open" && daysBetween(now, new Date(v.updated_at)) > 30) delete snap.prs[k];
        }

        // ── issues ──
        const openIssues = await budget.list<GhIssue>(`${base}/issues?state=open&per_page=100&sort=updated&direction=desc`, 3);
        if (!openIssues.ok) fail("issues", openIssues.error);
        let closedIssues: GhIssue[] = [];
        if (since) {
          const r = await budget.get<GhIssue[]>(`${base}/issues?state=closed&since=${encodeURIComponent(since)}&per_page=30&sort=updated&direction=desc`);
          if (r.ok) closedIssues = r.data ?? [];
          else fail("issues(closed)", r.error);
        }
        const openIssueNumbers = new Set<number>();
        for (const issue of [...openIssues.items, ...closedIssues]) {
          if (issue.pull_request) continue;
          const key = String(issue.number);
          if (issue.state === "open") openIssueNumbers.add(issue.number);
          const prev = snap.issues[key];
          const changed = !prev || prev.updated_at !== issue.updated_at || prev.state !== issue.state || prev.comments !== issue.comments;
          const prevComments = prev ? (prev.comments !== issue.comments ? prev.comments : prev.prev_comments) : issue.comments;
          const delta = issue.comments - prevComments;
          const ref = `${repo.full}#${issue.number}`;
          const labels = (issue.labels ?? []).map((l) => l.name);
          const assignees = (issue.assignees ?? []).map((u) => u.login);
          if (issue.state === "open" || changed) {
            const facts = [
              `${t(locale, "gh.label.state")}: ${issue.state}${issue.state_reason ? ` (${issue.state_reason})` : ""}${assignedToMe.has(ref) ? ` (${t(locale, "gh.label.assignedToMe")})` : ""}`,
              `${t(locale, "gh.label.author")}: ${issue.user?.login ?? "?"} · ${t(locale, "gh.label.updated")}: ${issue.updated_at}`,
              `${t(locale, "gh.label.comments")}: ${issue.comments}${delta > 0 ? ` (+${delta})` : ""}`,
              ...(assignees.length ? [`${t(locale, "gh.label.assignees")}: ${assignees.join(", ")}`] : []),
              ...(labels.length ? [`${t(locale, "gh.label.labels")}: ${labels.join(", ")}`] : []),
            ];
            signals.push({
              source: GITHUB_SOURCE,
              external_id: `issue:${ref}`,
              kind: "issue",
              title: t(locale, "gh.issue.title", { n: issue.number, title: issue.title }),
              body: `${facts.join("\n")}\n\n${excerpt(issue.body, BODY_CHARS)}`.trim(),
              url: issue.html_url,
              actor: issue.user?.login ?? null,
              occurred_at: issue.updated_at,
              metadata: {
                repo: repo.full,
                number: issue.number,
                state: issue.state,
                state_reason: issue.state_reason ?? null,
                comments: issue.comments,
                comments_delta: delta,
                labels,
                assignees,
                milestone: issue.milestone?.title ?? null,
                author: issue.user?.login ?? null,
                updated_at: issue.updated_at,
                created_at: issue.created_at,
                closed_at: issue.closed_at ?? null,
                assigned_to_me: assignedToMe.has(ref),
              },
            });
          }
          snap.issues[key] = { updated_at: issue.updated_at, state: issue.state, comments: issue.comments, prev_comments: prevComments };
        }
        for (const [k, v] of Object.entries(snap.issues)) {
          if (!openIssueNumbers.has(Number(k)) && v.state !== "open" && daysBetween(now, new Date(v.updated_at)) > 30) delete snap.issues[k];
        }

        // ── commits on the default branch since the cursor ──
        const commitsSince = since ?? new Date(now.getTime() - FIRST_RUN_LOOKBACK_DAYS * 86_400_000).toISOString();
        const commits = await budget.get<GhCommit[]>(`${base}/commits?sha=${encodeURIComponent(defaultBranch)}&since=${encodeURIComponent(commitsSince)}&per_page=50`);
        if (!commits.ok) {
          if (commits.status !== 409) fail("commits", commits.error); // 409 = empty repository
        } else if (commits.data && commits.data.length > 0) {
          const list = commits.data;
          const newest = list[0];
          const lines = list.map((c) => `${c.sha.slice(0, 7)} ${truncate(c.commit.message.split("\n")[0] ?? "", 100)} (${c.author?.login ?? c.commit.author?.name ?? "?"})`);
          signals.push({
            source: GITHUB_SOURCE,
            external_id: `commits:${repo.full}:${defaultBranch}:${newest.sha.slice(0, 12)}`,
            kind: "commits",
            title: t(locale, "gh.commits.title", { repo: repo.full, branch: defaultBranch, n: list.length }),
            body: truncate(lines.join("\n"), 4000),
            url: `https://github.com/${repo.full}/commits/${defaultBranch}`,
            actor: newest.author?.login ?? newest.commit.author?.name ?? null,
            occurred_at: newest.commit.committer?.date ?? newest.commit.author?.date ?? pollStart,
            metadata: {
              repo: repo.full,
              branch: defaultBranch,
              count: list.length,
              since: commitsSince,
              commits: list.slice(0, 50).map((c) => ({
                sha: c.sha,
                message: truncate(c.commit.message.split("\n")[0] ?? "", 200),
                author: c.author?.login ?? c.commit.author?.name ?? null,
                date: c.commit.committer?.date ?? c.commit.author?.date ?? null,
                url: c.html_url,
              })),
            },
          });
        }

        // ── branches ──
        const branches = await budget.get<GhBranch[]>(`${base}/branches?per_page=100`);
        if (!branches.ok) fail("branches", branches.error);
        else {
          const list = branches.data ?? [];
          const defaultSha = list.find((b) => b.name === defaultBranch)?.commit.sha ?? null;
          const seen = new Set<string>();
          let details = 0;
          for (const b of list) {
            seen.add(b.name);
            if (b.name === defaultBranch) {
              snap.branches[b.name] = { sha: b.commit.sha, date: snap.branches[b.name]?.date ?? null, ahead: 0, behind: 0, compared_against: defaultSha };
              continue;
            }
            const prev = snap.branches[b.name];
            const entry: BranchSnap = prev && prev.sha === b.commit.sha ? { ...prev } : { sha: b.commit.sha, date: null, ahead: null, behind: null, compared_against: null };
            if (details < MAX_BRANCH_DETAILS_PER_POLL && !budget.exhausted) {
              if (!entry.date) {
                details++;
                const c = await budget.get<GhCommit>(`${base}/commits/${b.commit.sha}`);
                if (c.ok && c.data) entry.date = c.data.commit.committer?.date ?? c.data.commit.author?.date ?? null;
              }
              if (defaultSha && entry.compared_against !== defaultSha && entry.date && daysBetween(now, new Date(entry.date)) > STALE_BRANCH_DAYS) {
                details++;
                const cmp = await budget.get<{ ahead_by?: number; behind_by?: number }>(`${base}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(b.name)}`);
                if (cmp.ok && cmp.data) {
                  entry.ahead = cmp.data.ahead_by ?? null;
                  entry.behind = cmp.data.behind_by ?? null;
                  entry.compared_against = defaultSha;
                }
              }
            }
            snap.branches[b.name] = entry;
            if (!entry.date) continue;
            const age = daysBetween(now, new Date(entry.date));
            const merged = entry.ahead === 0;
            if (age > STALE_BRANCH_DAYS && !merged) {
              const openPr = openPrHeads.get(b.name) ?? null;
              signals.push({
                source: GITHUB_SOURCE,
                external_id: `branch:${repo.full}:${b.name}`,
                kind: "branch",
                title: t(locale, "gh.branch.stale.title", { repo: repo.full, branch: b.name, date: entry.date.slice(0, 10) }),
                body: [
                  `${t(locale, "gh.label.branch")}: ${b.name} @ ${b.commit.sha.slice(0, 7)}`,
                  entry.ahead !== null ? t(locale, "gh.branch.label.aheadBehind", { base: defaultBranch, ahead: entry.ahead, behind: entry.behind ?? 0 }) : "",
                  openPr ? `${t(locale, "gh.branch.label.openPr")}: #${openPr}` : "",
                ]
                  .filter(Boolean)
                  .join("\n"),
                url: `https://github.com/${repo.full}/tree/${b.name}`,
                actor: null,
                occurred_at: entry.date,
                metadata: {
                  repo: repo.full,
                  name: b.name,
                  sha: b.commit.sha,
                  last_commit_at: entry.date,
                  ahead_by: entry.ahead,
                  behind_by: entry.behind,
                  base: defaultBranch,
                  open_pr: openPr,
                  protected: Boolean(b.protected),
                },
              });
            }
          }
          for (const name of Object.keys(snap.branches)) if (!seen.has(name)) delete snap.branches[name];
        }

        ctx.cursors.setJson(snapKey, snap);
        if (healthy) {
          ctx.cursors.set(cursorKey, pollStart);
          repoOk++;
        }
        ctx.logger.debug(`github ${repo.full}: ${openPrs.items.length} open PRs, ${openIssues.items.length} open issues, ${budget.calls} calls so far`);
      }

      // ── notifications ──
      if (ctx.config.include_notifications !== false && capabilityOk("notifications") && !budget.exhausted) {
        const nsince = ctx.cursors.get("notifications_since");
        const r = await budget.get<GhNotification[]>(`notifications?all=false&per_page=50${nsince ? `&since=${encodeURIComponent(nsince)}` : ""}`);
        if (!r.ok) {
          if (r.status === 304) {
            /* nothing new */
          } else capabilityFailed("notifications", "notifications", r.error);
        } else {
          let newest = nsince ?? "";
          for (const n of r.data ?? []) {
            if (n.updated_at > newest) newest = n.updated_at;
            const html = apiToHtmlUrl(n.subject.url) ?? n.repository.html_url ?? null;
            signals.push({
              source: GITHUB_SOURCE,
              external_id: `notif:${n.id}`,
              kind: "notification",
              title: t(locale, "gh.notification.title", { reason: n.reason, title: n.subject.title }),
              body: `${n.repository.full_name} · ${n.subject.type} · ${n.reason}${n.unread ? " · unread" : ""}\n${html ?? ""}`.trim(),
              url: html,
              actor: null,
              occurred_at: n.updated_at,
              metadata: { id: n.id, reason: n.reason, subject_type: n.subject.type, repo: n.repository.full_name, unread: n.unread, updated_at: n.updated_at, subject_url: n.subject.url },
            });
          }
          if (newest) ctx.cursors.set("notifications_since", newest);
        }
      }

      const summary = `${repoOk}/${repos.length} repos via ${api.mode}, ${budget.calls} api calls, ${signals.length} signals`;
      ctx.logger.info(`github poll: ${summary}`);
      return { signals, warnings: warnings.list, summary };
    },
  };
}

export const githubSensor = createGithubSensor();
