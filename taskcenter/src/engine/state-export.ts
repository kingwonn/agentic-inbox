/**
 * State export/import: one JSONL file per table plus a manifest. Used for backups
 * and the cloud<->local sync (`taskcenter-state` branch). Secrets never live in the
 * database, and every exported line is passed through the log redactor anyway.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { AppContext } from "../core/app.js";
import { redact } from "../core/logger.js";
import { DAY } from "../core/time.js";
import { errMsg } from "./util.js";

export interface TableSpec {
  name: string;
  pk: string[];
  /** Column used for "newest wins" merges; null = insert-only (append tables). */
  updated: string | null;
  /** Extra unique key that can conflict on import (signals). */
  altKey?: string[];
  /** Time column used by `sinceDays` filtering. */
  ts?: string;
  /** budgets: take the max of counters instead of replacing. */
  merge?: "max";
}

export const TABLES: TableSpec[] = [
  { name: "signals", pk: ["id"], updated: "updated_at", altKey: ["source", "external_id"] },
  { name: "inbox_items", pk: ["id"], updated: "updated_at" },
  { name: "tasks", pk: ["id"], updated: "updated_at" },
  { name: "runs", pk: ["id"], updated: "updated_at" },
  { name: "events", pk: ["id"], updated: null, ts: "ts" },
  { name: "approvals", pk: ["id"], updated: "updated_at" },
  { name: "artifacts", pk: ["id"], updated: null, ts: "created_at" },
  { name: "notifications", pk: ["id"], updated: null, ts: "sent_at" },
  { name: "memories", pk: ["id"], updated: "updated_at" },
  { name: "sensor_cursors", pk: ["sensor", "key"], updated: "updated_at" },
  { name: "schedules", pk: ["name"], updated: null },
  { name: "budgets", pk: ["day"], updated: null, merge: "max" },
  { name: "meta", pk: ["key"], updated: null },
];

export interface ExportManifest {
  version: 1;
  exported_at: string;
  host: string;
  since: string | null;
  tables: Record<string, { file: string; rows: number }>;
}

export interface ExportReport {
  dir: string;
  manifest: ExportManifest;
}

export function exportState(ctx: AppContext, dir?: string, opts: { sinceDays?: number; now?: Date } = {}): ExportReport {
  const now = opts.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const target = resolve(dir ?? join(ctx.dataDir, "exports", stamp));
  mkdirSync(target, { recursive: true });
  const since = opts.sinceDays ? new Date(now.getTime() - opts.sinceDays * DAY).toISOString() : null;
  const manifest: ExportManifest = { version: 1, exported_at: now.toISOString(), host: hostname(), since, tables: {} };
  for (const t of TABLES) {
    let rows: Record<string, unknown>[];
    if (since && t.ts) rows = ctx.repo.db.all(`SELECT * FROM ${t.name} WHERE ${t.ts} >= ? ORDER BY ${t.ts}`, since);
    else rows = ctx.repo.db.all(`SELECT * FROM ${t.name}`);
    const file = `${t.name}.jsonl`;
    const lines = rows.map((r) => redact(JSON.stringify(r)));
    writeFileSync(join(target, file), lines.length ? lines.join("\n") + "\n" : "");
    manifest.tables[t.name] = { file, rows: rows.length };
  }
  writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest, null, 2));
  ctx.bus.record({ type: "system", message: `state exported to ${target}`, payload: { dir: target, tables: Object.fromEntries(Object.entries(manifest.tables).map(([k, v]) => [k, v.rows])) } });
  return { dir: target, manifest };
}

export interface ImportReport {
  dir: string;
  tables: Record<string, { read: number; applied: number; skipped: number; errors: number }>;
}

function tableColumns(ctx: AppContext, table: string): Set<string> {
  return new Set(ctx.repo.db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name));
}

function buildUpsert(t: TableSpec, cols: string[]): string {
  const nonPk = cols.filter((c) => !t.pk.includes(c));
  const insert = `INSERT INTO ${t.name} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
  if (!nonPk.length) return `${insert} ON CONFLICT(${t.pk.join(", ")}) DO NOTHING`;
  let set: string;
  if (t.merge === "max") set = nonPk.map((c) => `${c} = MAX(${t.name}.${c}, excluded.${c})`).join(", ");
  else set = nonPk.map((c) => `${c} = excluded.${c}`).join(", ");
  const where = t.updated && cols.includes(t.updated) ? ` WHERE excluded.${t.updated} >= ${t.name}.${t.updated}` : "";
  const clauses: string[] = [];
  if (t.updated === null && t.merge !== "max" && t.name !== "meta" && t.name !== "schedules") {
    clauses.push(`ON CONFLICT(${t.pk.join(", ")}) DO NOTHING`);
  } else {
    clauses.push(`ON CONFLICT(${t.pk.join(", ")}) DO UPDATE SET ${set}${where}`);
  }
  if (t.altKey) {
    const altSet = nonPk.filter((c) => !t.altKey!.includes(c)).map((c) => `${c} = excluded.${c}`).join(", ");
    clauses.push(`ON CONFLICT(${t.altKey.join(", ")}) DO UPDATE SET ${altSet}${where}`);
  }
  return `${insert} ${clauses.join(" ")}`;
}

export function importState(ctx: AppContext, dir: string): ImportReport {
  const target = resolve(dir);
  if (!existsSync(target)) throw new Error(`export directory not found: ${target}`);
  const files = new Set(readdirSync(target));
  const report: ImportReport = { dir: target, tables: {} };
  for (const t of TABLES) {
    const file = `${t.name}.jsonl`;
    if (!files.has(file)) continue;
    const stat = { read: 0, applied: 0, skipped: 0, errors: 0 };
    report.tables[t.name] = stat;
    const known = tableColumns(ctx, t.name);
    const text = readFileSync(join(target, file), "utf8");
    const rows: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      stat.read++;
      try {
        rows.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        stat.errors++;
      }
    }
    ctx.repo.transaction(() => {
      for (const row of rows) {
        const cols = Object.keys(row).filter((c) => known.has(c));
        if (!t.pk.every((k) => cols.includes(k))) {
          stat.skipped++;
          continue;
        }
        try {
          const r = ctx.repo.db.run(buildUpsert(t, cols), ...cols.map((c) => normalize(row[c])));
          if (r.changes > 0) stat.applied++;
          else stat.skipped++;
        } catch (e) {
          stat.errors++;
          ctx.logger.warn(`import ${t.name} row failed: ${errMsg(e)}`);
        }
      }
    });
  }
  ctx.bus.record({ type: "system", message: `state imported from ${target}`, payload: { dir: target, tables: report.tables } });
  return report;
}

function normalize(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return JSON.stringify(v);
}
