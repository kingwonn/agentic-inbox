import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_PATTERNS = [
  /(ghp_[A-Za-z0-9]{20,})/g,
  /(github_pat_[A-Za-z0-9_]{20,})/g,
  /(sk-ant-[A-Za-z0-9\-_]{20,})/g,
  /(xox[abp]-[A-Za-z0-9-]{20,})/g,
  /(\d{6,}:[A-Za-z0-9_-]{30,})/g, // telegram bot token
  /("?password"?\s*[:=]\s*)("[^"]+"|'[^']+'|\S+)/gi,
];

export function redact(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, (_m, a: string, b: unknown) => (typeof b === "string" ? `${a}***` : "***"));
  }
  return out;
}

export interface Logger {
  level: LogLevel;
  child(scope: string): Logger;
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  file?: string; // JSONL file; created on demand
  scope?: string;
  stderr?: boolean;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? ((process.env.TC_LOG_LEVEL as LogLevel) || "info");
  const file = opts.file;
  const scope = opts.scope ?? "tc";
  const toStderr = opts.stderr ?? true;
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      /* ignore */
    }
  }
  function write(l: LogLevel, msg: string, data?: unknown) {
    if (ORDER[l] < ORDER[level]) return;
    const rec = { ts: new Date().toISOString(), level: l, scope, msg: redact(msg), data: data === undefined ? undefined : safe(data) };
    if (toStderr) {
      const line = `${rec.ts} ${l.toUpperCase().padEnd(5)} [${scope}] ${rec.msg}${data !== undefined ? " " + redact(JSON.stringify(rec.data)) : ""}`;
      process.stderr.write(line + "\n");
    }
    if (file) {
      try {
        appendFileSync(file, redact(JSON.stringify(rec)) + "\n");
      } catch {
        /* ignore */
      }
    }
  }
  const logger: Logger = {
    level,
    child: (s) => createLogger({ ...opts, scope: `${scope}:${s}`, level }),
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
  };
  return logger;
}

function safe(v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
  try {
    JSON.stringify(v);
    return v;
  } catch {
    return String(v);
  }
}

export const silentLogger: Logger = {
  level: "error",
  child: () => silentLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
