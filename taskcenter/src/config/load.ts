import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, type Config } from "./schema.js";

export interface LoadedConfig {
  config: Config;
  configPath: string | null;
  rootDir: string; // directory config paths are relative to (taskcenter/)
  resolve(p: string): string; // resolve a config-relative path
}

/** Replace ${VAR} and ${VAR:-default} with environment values. */
export function substituteEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_m, name: string, def?: string) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    return def ?? "";
  });
}

function findRoot(start: string): string {
  // taskcenter root = nearest ancestor containing package.json with name @agentic-inbox/taskcenter, else start
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const pj = resolve(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const name = JSON.parse(readFileSync(pj, "utf8")).name;
        if (name === "@agentic-inbox/taskcenter") return dir;
      } catch {
        /* ignore */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export function loadConfig(opts: { configPath?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}): LoadedConfig {
  const cwd = opts.cwd ?? process.cwd();
  const rootDir = process.env.TC_ROOT ? resolve(process.env.TC_ROOT) : findRoot(cwd);
  // Load .env from root (never overrides existing env)
  const envFile = resolve(rootDir, ".env");
  if (existsSync(envFile)) {
    try {
      const mode = statSync(envFile).mode & 0o077;
      if (mode !== 0) process.stderr.write(`[tc] warning: ${envFile} is readable by other users (chmod 600 recommended)\n`);
    } catch {
      /* ignore */
    }
    loadDotenv({ path: envFile, override: false });
  }
  const env = opts.env ?? process.env;
  const candidates = [
    opts.configPath,
    env.TC_CONFIG,
    resolve(rootDir, "config/taskcenter.yaml"),
    resolve(rootDir, "config/taskcenter.example.yaml"),
  ].filter(Boolean) as string[];
  let configPath: string | null = null;
  let raw: unknown = {};
  for (const c of candidates) {
    const p = isAbsolute(c) ? c : resolve(cwd, c);
    if (existsSync(p)) {
      configPath = p;
      raw = parseYaml(substituteEnv(readFileSync(p, "utf8"), env)) ?? {};
      break;
    }
  }
  const config = ConfigSchema.parse(raw);
  const resolver = (p: string) => (isAbsolute(p) ? p : resolve(rootDir, p));
  return { config, configPath, rootDir, resolve: resolver };
}

/** Which optional capabilities are configured (used by the policy engine). */
export function availableCapabilities(config: Config): string[] {
  const caps: string[] = [];
  const s = config.sensors;
  const n = config.notifications.channels;
  if (s.github.token || s.github.use_gh_cli) caps.push("github_token");
  if (s.imap.enabled && s.imap.user && s.imap.password) caps.push("imap");
  if (n.email.enabled && n.email.smtp_host && n.email.smtp_user) caps.push("smtp");
  if (s.ics.enabled && s.ics.urls.filter(Boolean).length) caps.push("calendar_ics");
  if (n.telegram.enabled && n.telegram.bot_token) caps.push("telegram");
  if (n.ntfy.enabled && n.ntfy.topic) caps.push("ntfy");
  caps.push("web_fetch");
  return caps;
}
