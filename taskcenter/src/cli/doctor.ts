/**
 * `tc doctor`: environment checks. Pure checks (no app context needed) plus optional
 * module/runner probes. `--probe` makes one real haiku call through `claude -p`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../config/load.js";
import { openDb } from "../core/db.js";
import { silentLogger } from "../core/logger.js";
import { Policy } from "../core/policy.js";
import { readLock } from "../engine/lock.js";
import { errMsg } from "../engine/util.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface DoctorOptions {
  configPath?: string;
  cwd?: string;
  probe?: boolean;
  dry?: boolean;
  /** Skip sibling-module probes (fast mode). */
  skipModules?: boolean;
}

function run(cmd: string, args: string[], timeoutMs = 10_000): { ok: boolean; out: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, env: { ...process.env, NO_COLOR: "1" } });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    return { ok: r.status === 0, out };
  } catch (e) {
    return { ok: false, out: errMsg(e) };
  }
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorCheck["status"], detail: string) => checks.push({ name, status, detail });

  // 1. node
  const [maj, min] = process.versions.node.split(".").map(Number);
  add("node", maj > 22 || (maj === 22 && min >= 12) ? "ok" : "fail", `v${process.versions.node} (need >= 22.12 for node:sqlite)`);

  // 2. config
  let loaded: ReturnType<typeof loadConfig> | undefined;
  try {
    loaded = loadConfig({ configPath: opts.configPath, cwd: opts.cwd });
    const p = loaded.configPath ?? "(defaults)";
    const isExample = p.endsWith("taskcenter.example.yaml");
    add("config", isExample || !loaded.configPath ? "warn" : "ok", isExample ? `${p} — run \`tc init\` to create config/taskcenter.yaml` : p);
  } catch (e) {
    add("config", "fail", errMsg(e));
    return { checks, ok: false };
  }
  const { config } = loaded;
  const root = loaded.rootDir;

  // 3. policy / profile
  const policyPath = loaded.resolve(config.policy_path);
  try {
    const pol = Policy.load(policyPath);
    add("policy", "ok", `${policyPath} (auto_promote L>=${pol.cfg.levels.auto_promote.min_level} ${pol.cfg.levels.auto_promote.max_priority}, ${Object.keys(pol.cfg.categories).length} categories)`);
  } catch (e) {
    add("policy", "fail", `${policyPath}: ${errMsg(e)}`);
  }
  const profilePath = loaded.resolve(config.profile_path);
  if (existsSync(profilePath)) {
    try {
      const prof = (parseYaml(readFileSync(profilePath, "utf8")) ?? {}) as Record<string, unknown>;
      const identity = prof.identity as Record<string, unknown> | undefined;
      add("profile", "ok", `${profilePath}${identity?.name ? ` (${identity.name})` : ""}`);
    } catch (e) {
      add("profile", "fail", `${profilePath}: ${errMsg(e)}`);
    }
  } else add("profile", "warn", `${profilePath} missing — copy config/profile.example.yaml`);

  // 4. .env
  const envFile = resolve(root, ".env");
  if (existsSync(envFile)) {
    const mode = statSync(envFile).mode & 0o777;
    add(".env", (mode & 0o077) === 0 ? "ok" : "warn", `${envFile} mode ${mode.toString(8)}${(mode & 0o077) !== 0 ? " — chmod 600 recommended" : ""}`);
  } else add(".env", "warn", `${envFile} missing (optional; needed for tokens)`);

  // 5. data dir + db
  const dataDir = loaded.resolve(config.data_dir);
  try {
    mkdirSync(dataDir, { recursive: true });
    const probeFile = join(dataDir, `.doctor-${process.pid}`);
    writeFileSync(probeFile, "ok");
    rmSync(probeFile, { force: true });
    add("data_dir", "ok", dataDir);
  } catch (e) {
    add("data_dir", "fail", `${dataDir}: ${errMsg(e)}`);
  }
  try {
    const db = openDb(join(dataDir, "taskcenter.db"));
    const n = db.get<{ n: number }>("SELECT COUNT(*) n FROM migrations")?.n ?? 0;
    const tasks = db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks")?.n ?? 0;
    db.close();
    add("database", "ok", `${join(dataDir, "taskcenter.db")} (${n} migrations, ${tasks} tasks)`);
  } catch (e) {
    add("database", "fail", errMsg(e));
  }

  // 6. daemon
  const lock = readLock(join(dataDir, "taskcenter.lock"));
  add("daemon", lock?.alive ? "ok" : "warn", lock?.alive ? `running (pid ${lock.pid}, since ${lock.startedAt})` : lock ? `stale lock (pid ${lock.pid}) — will be cleaned on next start` : "not running");

  // 7. brain provider / claude CLI
  const provider = opts.dry ? "dry" : config.brain.provider;
  if (provider === "dry") add("brain", "ok", "provider dry (no LLM calls)");
  else if (provider === "anthropic-api") add("brain", process.env.ANTHROPIC_API_KEY ? "ok" : "fail", process.env.ANTHROPIC_API_KEY ? "provider anthropic-api (ANTHROPIC_API_KEY set)" : "provider anthropic-api but ANTHROPIC_API_KEY is empty");
  else {
    const v = run("claude", ["--version"]);
    add("claude CLI", v.ok ? "ok" : "fail", v.ok ? `${v.out.split("\n")[0]} (provider ${provider})` : `claude not found or failed: ${v.out || "install Claude Code and log in"}`);
    if (opts.probe) {
      if (v.ok) {
        const p = run("claude", ["-p", "Reply with exactly: OK", "--model", "haiku", "--output-format", "json", "--max-turns", "1"], 90_000);
        let detail = p.out.slice(0, 200);
        try {
          const j = JSON.parse(p.out) as { result?: string; total_cost_usd?: number; is_error?: boolean };
          detail = `result=${String(j.result ?? "").slice(0, 40)} cost=$${(j.total_cost_usd ?? 0).toFixed(4)}`;
          add("claude auth probe", p.ok && !j.is_error ? "ok" : "fail", detail);
        } catch {
          add("claude auth probe", p.ok ? "ok" : "fail", detail);
        }
      } else add("claude auth probe", "fail", "skipped: claude CLI unavailable");
    }
  }

  // 8. git / gh
  const git = run("git", ["--version"]);
  add("git", git.ok ? "ok" : "warn", git.ok ? git.out.split("\n")[0] : "git not found (worktrees disabled)");
  const gh = run("gh", ["--version"]);
  if (gh.ok) {
    const auth = run("gh", ["auth", "status"], 15_000);
    add("gh CLI", auth.ok ? "ok" : "warn", auth.ok ? `${gh.out.split("\n")[0]} — authenticated` : `${gh.out.split("\n")[0]} — not logged in (gh auth login) or no network`);
  } else add("gh CLI", config.sensors.github.enabled && !config.sensors.github.token ? "warn" : "ok", "gh not found" + (config.sensors.github.enabled && !config.sensors.github.token ? " — github sensor needs GITHUB_TOKEN or gh" : ""));

  // 9. channels
  const ch = config.notifications.channels;
  const chans: string[] = [];
  const chanWarn: string[] = [];
  if (ch.console.enabled) chans.push("console");
  if (ch.telegram.enabled) (ch.telegram.bot_token && ch.telegram.chat_id ? chans : chanWarn).push("telegram");
  if (ch.ntfy.enabled) (ch.ntfy.topic ? chans : chanWarn).push("ntfy");
  if (ch.email.enabled) (ch.email.smtp_host && ch.email.smtp_user && ch.email.to ? chans : chanWarn).push("email");
  if (ch.webhook.enabled) (ch.webhook.url ? chans : chanWarn).push("webhook");
  add("channels", chanWarn.length ? "warn" : chans.length ? "ok" : "warn", `${chans.join(", ") || "none"}${chanWarn.length ? ` — enabled but missing credentials: ${chanWarn.join(", ")}` : ""}`);

  // 10. sensors
  const s = config.sensors;
  const on: string[] = [];
  const sWarn: string[] = [];
  if (s.github.enabled) (s.github.token || s.github.use_gh_cli ? on : sWarn).push("github");
  if (s.imap.enabled) (s.imap.user && s.imap.password ? on : sWarn).push("imap");
  if (s.ics.enabled) (s.ics.urls.length ? on : sWarn).push("ics");
  if (s.localgit.enabled) (s.localgit.repos.length ? on : sWarn).push("localgit");
  if (s.fsdocs.enabled) (s.fsdocs.paths.length ? on : sWarn).push("fsdocs");
  if (s.manual.enabled) on.push("manual");
  add("sensors", sWarn.length ? "warn" : "ok", `${on.join(", ") || "none"}${sWarn.length ? ` — enabled but not configured: ${sWarn.join(", ")}` : ""}`);

  // 11. modules + runner
  if (!opts.skipModules) {
    try {
      const { probeModules } = await import("../engine/wiring.js");
      const mods = await probeModules(silentLogger);
      const bad = Object.entries(mods).filter(([, v]) => v !== "ok");
      add("modules", bad.length ? "warn" : "ok", bad.length ? bad.map(([k, v]) => `${k}: ${v}`).join("; ") : `${Object.keys(mods).length} modules load`);
      if (mods["runners/registry"] === "ok") {
        try {
          const runners = await import("../runners/registry.js");
          const r = await runners.selectRunner(opts.dry ? { ...config, brain: { ...config.brain, provider: "dry" } } : config, silentLogger);
          const a = await r.available();
          add("runner", a.ok ? "ok" : "warn", `${r.name}${a.reason ? ` — ${a.reason}` : ""}`);
        } catch (e) {
          add("runner", "warn", errMsg(e));
        }
      }
    } catch (e) {
      add("modules", "warn", errMsg(e));
    }
  }

  const ok = checks.every((c) => c.status !== "fail");
  return { checks, ok };
}
