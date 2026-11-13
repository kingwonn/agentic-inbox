/**
 * Small helpers shared by the HTTP routes: query parsing, pagination,
 * typed errors and body validation.
 */
import type { Context } from "hono";
import { z, type ZodType } from "zod";
import type { Repo } from "../core/repo.js";
import type { Level } from "../core/types.js";

/** zod schema for an autonomy level 1..5 (typed as Level). */
export const LevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]) as unknown as ZodType<Level>;

/** Error carrying an HTTP status; the app-level error handler turns it into JSON. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (what = "not found") => new HttpError(404, what);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const unavailable = (what = "service unavailable") => new HttpError(503, what);

/** Parse a bounded integer query parameter. */
export function intParam(c: Context, name: string, def: number, max = 1000, min = 0): number {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function strParam(c: Context, name: string): string | undefined {
  const raw = c.req.query(name);
  return raw === undefined || raw === "" ? undefined : raw;
}

/** `?status=a,b` or repeated `?status=a&status=b` -> ["a","b"]. */
export function listParam(c: Context, name: string): string[] | undefined {
  const raw = c.req.queries(name);
  if (!raw || raw.length === 0) return undefined;
  const out = raw.flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

/** Validate that every value is a member of an allowed set (400 otherwise). */
export function oneOf<T extends string>(values: string[] | undefined, allowed: readonly T[], name: string): T[] | undefined {
  if (!values) return undefined;
  for (const v of values) if (!(allowed as readonly string[]).includes(v)) throw badRequest(`invalid ${name}: ${v}`);
  return values as T[];
}

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  /** True when the page is full (another page may exist). */
  more: boolean;
}

export function pageOf<T>(items: T[], limit: number, offset: number): Page<T> {
  return { items, limit, offset, more: items.length >= limit };
}

/** Parse + validate a JSON body with zod (empty body -> {}). */
export async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text.trim().length > 0) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw badRequest("invalid JSON body");
    }
  }
  const res = schema.safeParse(raw);
  if (!res.success) throw badRequest("invalid body", res.error.issues);
  return res.data;
}

/** Group counts by status for tables the repo does not expose counts for. */
export function countsByStatus(repo: Repo, table: "runs" | "inbox_items" | "tasks" | "approvals"): Record<string, number> {
  const rows = repo.db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) n FROM ${table} GROUP BY status`);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export function sumCounts(c: Record<string, number>): number {
  return Object.values(c).reduce((a, b) => a + b, 0);
}

/**
 * Stable chronological order for events. Events recorded in the same millisecond
 * share `ts` and the repo tiebreaks on the random-tailed id, so bursts (tool_call
 * + tool_result, run_started + status_change) can come back scrambled. Writers
 * that emit bursts include a monotonic `payload.seq`; we honour it and otherwise
 * keep the incoming order.
 */
export function sortChrono<T extends { ts: string; payload: Record<string, unknown> }>(events: T[]): T[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.ts !== b.e.ts) return a.e.ts < b.e.ts ? -1 : 1;
      const sa = typeof a.e.payload?.seq === "number" ? (a.e.payload.seq as number) : null;
      const sb = typeof b.e.payload?.seq === "number" ? (b.e.payload.seq as number) : null;
      if (sa !== null && sb !== null && sa !== sb) return sa - sb;
      return a.i - b.i;
    })
    .map((x) => x.e);
}

/** Resolve a value that may be a thenable or plain. */
export async function maybeAsync<T>(v: T | Promise<T>): Promise<T> {
  return await v;
}
