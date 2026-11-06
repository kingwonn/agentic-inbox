/**
 * Shared helpers for sensors: resilient fetch, text excerpts, HTML stripping,
 * hashing and child-process execution. Everything here is dependency-free.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export const DEFAULT_TIMEOUT_MS = 20_000;

// ── Hashing ─────────────────────────────────────────────────────────

export function sha1(input: string | Buffer): string {
  return createHash("sha1").update(input).digest("hex");
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Short stable hash of any JSON-serialisable value (used for state snapshots). */
export function hashOf(value: unknown): string {
  return sha1(JSON.stringify(value)).slice(0, 16);
}

// ── Text ────────────────────────────────────────────────────────────

/** Trim, normalise newlines, collapse runs of blank lines and cut to `max` chars. */
export function excerpt(text: string | null | undefined, max = 3000): string {
  if (!text) return "";
  let t = String(text).replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (t.length > max) t = t.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
  return t;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const v = ENTITIES[code.toLowerCase()];
    return v ?? m;
  });
}

/** Convert HTML to readable plain text (block elements become newlines, links keep their text). */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  let t = String(html);
  t = t.replace(/<!--[\s\S]*?-->/g, "");
  t = t.replace(/<(script|style|head|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|table|section|article|header|footer|ul|ol)>/gi, "\n");
  t = t.replace(/<(li)\b[^>]*>/gi, "- ");
  t = t.replace(/<td\b[^>]*>/gi, " ");
  t = t.replace(/<[^>]+>/g, "");
  t = decodeEntities(t);
  t = t.replace(/ /g, " ");
  t = t
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t;
}

/** First non-empty line, for titles. */
export function firstLine(text: string, max = 120): string {
  const line = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
}

// ── Time helpers ────────────────────────────────────────────────────

export function daysAgo(days: number, from: Date = new Date()): Date {
  return new Date(from.getTime() - days * 86_400_000);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Combine an optional caller signal with a timeout. */
export function timeoutSignal(timeoutMs: number, parent?: AbortSignal | null): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  if (!parent) return t;
  return AbortSignal.any([parent, t]);
}

/** Race a promise against a timeout (the underlying operation is not cancelled). */
export async function withTimeout<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Errors ──────────────────────────────────────────────────────────

/** Thrown by sensors for configuration/auth problems (the patrol must surface these, not retry). */
export class SensorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SensorConfigError";
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause;
    const c = cause instanceof Error ? ` (${cause.message})` : "";
    return `${e.message}${c}`;
  }
  return String(e);
}

/** Heuristic: is this a transient network/server error worth retrying? */
export function isTransientError(e: unknown): boolean {
  const msg = errorMessage(e).toLowerCase();
  return /timed? ?out|econnreset|econnrefused|enotfound|eai_again|epipe|socket hang up|network|fetch failed|aborted|503|502|504|429/.test(
    msg,
  );
}

// ── HTTP ────────────────────────────────────────────────────────────

export interface SafeFetchOptions {
  /** Per-attempt timeout. Default 20s. */
  timeoutMs?: number;
  /** Retries on network errors / 429 / 5xx. Default 2. */
  retries?: number;
  /** Base backoff between retries (ms). Default 500. */
  backoffMs?: number;
  signal?: AbortSignal | null;
  /** Injected fetch (tests). */
  fetchImpl?: typeof fetch;
}

/**
 * fetch with a per-attempt timeout and bounded retries on transient failures.
 * Node's global fetch honours HTTPS_PROXY when the process runs with
 * `--use-env-proxy` / `NODE_USE_ENV_PROXY=1`, so nothing proxy-specific lives here.
 * Never throws for HTTP error statuses — callers inspect `response.ok`.
 */
export async function safeFetch(url: string, init: RequestInit = {}, opts: SafeFetchOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, opts.retries ?? 2);
  const backoff = opts.backoffMs ?? 500;
  const f = opts.fetchImpl ?? fetch;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
    try {
      const res = await f(url, { ...init, signal: timeoutSignal(timeoutMs, opts.signal) });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : backoff * 2 ** attempt, opts.signal ?? undefined);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (opts.signal?.aborted) throw e;
      if (attempt < retries && isTransientError(e)) {
        await sleep(backoff * 2 ** attempt, opts.signal ?? undefined);
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("fetch failed");
}

/** safeFetch + JSON parse. Returns {ok:false} instead of throwing on HTTP errors. */
export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {},
): Promise<{ ok: boolean; status: number; data: T | undefined; headers: Headers; error?: string }> {
  const res = await safeFetch(url, init, opts);
  const text = await res.text();
  let data: T | undefined;
  try {
    data = text ? (JSON.parse(text) as T) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const msg = (data as { message?: string } | undefined)?.message ?? text.slice(0, 200);
    return { ok: false, status: res.status, data, headers: res.headers, error: `HTTP ${res.status}${msg ? `: ${msg}` : ""}` };
  }
  return { ok: true, status: res.status, data, headers: res.headers };
}

// ── Child processes ─────────────────────────────────────────────────

export interface CommandResult {
  /** Exit code; null when killed (timeout) or when the binary could not be started. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn error (e.g. ENOENT) if any. */
  error?: string;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal | null;
  input?: string;
}

/** execFile wrapper that never throws: inspect `code`/`error`. */
export function runCommand(cmd: string, args: string[], opts: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    let settled = false;
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        if (err && (err.code === "ENOENT" || err.code === "EACCES" || typeof err.code === "string")) {
          resolve({ code: null, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut, error: `${err.code}: ${err.message}` });
          return;
        }
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : null) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut,
          error: err && typeof err.code !== "number" ? err.message : undefined,
        });
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    function onAbort() {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}

const existsCache = new Map<string, boolean>();

/** Is `cmd` on PATH (or an absolute path to an executable)? Cached per process. */
export function commandExists(cmd: string): boolean {
  const cached = existsCache.get(cmd);
  if (cached !== undefined) return cached;
  let found = false;
  const candidates: string[] = [];
  if (cmd.includes("/") || cmd.includes("\\")) candidates.push(cmd);
  else {
    const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
    for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      for (const ext of exts) candidates.push(join(dir, cmd + ext));
    }
  }
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      found = true;
      break;
    } catch {
      /* next */
    }
  }
  existsCache.set(cmd, found);
  return found;
}

/** Test hook: forget cached `commandExists` answers. */
export function resetCommandCache(): void {
  existsCache.clear();
}

// ── Misc ────────────────────────────────────────────────────────────

export function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

export function parseIsoOr(s: unknown, fallback: Date): Date {
  if (typeof s === "string" || s instanceof Date) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
}

export function toIso(d: Date | string | undefined | null, fallback?: Date): string | undefined {
  if (d === undefined || d === null) return fallback?.toISOString();
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? fallback?.toISOString() : date.toISOString();
}

/** Warnings collector with de-duplication and a bound. */
export class Warnings {
  private items: string[] = [];
  private seen = new Set<string>();
  constructor(private max = 50) {}
  add(msg: string): void {
    if (this.seen.has(msg) || this.items.length >= this.max) return;
    this.seen.add(msg);
    this.items.push(msg);
  }
  get list(): string[] {
    return this.items;
  }
  get size(): number {
    return this.items.length;
  }
}
