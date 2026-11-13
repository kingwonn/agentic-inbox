/**
 * Small helpers shared by the engine modules. No dependencies outside node.
 */
import { createHash } from "node:crypto";
import { isoPlus, DAY, HOUR, MINUTE } from "../core/time.js";
import type { Level } from "../core/types.js";

export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Trim a string to `max` characters, noting how much was cut. */
export function trimText(s: string | null | undefined, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… [+${s.length - max} chars]`;
}

/** Keep an event payload under `maxBytes` of JSON. */
export function trimPayload(v: unknown, maxBytes = 8 * 1024): unknown {
  let json: string;
  try {
    json = JSON.stringify(v);
  } catch {
    return { _truncated: true, preview: trimText(String(v), maxBytes) };
  }
  if (json === undefined || json.length <= maxBytes) return v;
  if (typeof v === "string") return trimText(v, maxBytes);
  return { _truncated: true, bytes: json.length, preview: json.slice(0, maxBytes) };
}

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${Math.round(ms / 1000)}s`);
    this.name = "TimeoutError";
  }
}

/** Race a promise against a timer. The underlying work is not cancelled. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Run `fn` over `items` with at most `n` in flight; results keep input order. */
export async function mapPool<T, R>(items: T[], n: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function clampLevel(n: number): Level {
  return Math.max(1, Math.min(5, Math.round(Number(n) || 1))) as Level;
}

/** "1d" | "3d" | "7d" | "2h" | "30m" | ISO date -> ISO timestamp in the future. */
export function parseUntil(s: string, from: Date = new Date()): string | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/i.exec(s.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit === "m" ? n * MINUTE : unit === "h" ? n * HOUR : unit === "d" ? n * DAY : n * 7 * DAY;
    return isoPlus(ms, from);
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return undefined;
}

export function firstLine(s: string, max = 120): string {
  const line = (s ?? "").split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return trimText(line.trim(), max);
}

/** Safe nested read for task.context values. */
export function ctxGet<T>(ctx: Record<string, unknown> | undefined, key: string): T | undefined {
  if (!ctx) return undefined;
  return ctx[key] as T | undefined;
}
