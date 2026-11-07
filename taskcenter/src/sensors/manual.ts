/**
 * Manual capture sensor.
 *
 * 1. Drop folder: every `*.md` / `*.txt` file in `<data_dir>/capture/` becomes a
 *    `manual` signal (external_id = file name, body = file content) and is then
 *    moved to `<data_dir>/capture/processed/`.
 * 2. `captureSignal()` upserts a manual signal directly (CLI `tc capture`, HTTP API,
 *    Telegram free-text messages).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Repo } from "../core/repo.js";
import type { NewSignal, Signal } from "../core/types.js";
import type { Sensor, SensorContext, SensorPollResult } from "./types.js";
import { errorMessage, excerpt, firstLine, sha1, Warnings } from "./util.js";

export const MANUAL_SOURCE = "manual";
const MAX_BODY = 16_000;
const EXTENSIONS = new Set([".md", ".txt", ".markdown"]);

export interface CaptureOptions {
  title?: string;
  url?: string;
  /** Signal kind; default "manual". */
  kind?: string;
  metadata?: Record<string, unknown>;
  /** Override the external id (defaults to a hash of text + time, i.e. every capture is a new signal). */
  externalId?: string;
  occurredAt?: string;
}

/** Build (without storing) the NewSignal for a free-text capture. */
export function buildCaptureSignal(text: string, by: string, opts: CaptureOptions = {}, now: Date = new Date()): NewSignal {
  const body = excerpt(text, MAX_BODY);
  const title = opts.title?.trim() || firstLine(body) || "Manual capture";
  const externalId = opts.externalId ?? `capture:${now.getTime().toString(36)}-${sha1(body).slice(0, 8)}`;
  return {
    source: MANUAL_SOURCE,
    external_id: externalId,
    kind: opts.kind ?? "manual",
    title,
    body,
    url: opts.url ?? null,
    actor: by,
    occurred_at: opts.occurredAt ?? now.toISOString(),
    metadata: { by, via: "capture", length: body.length, ...(opts.metadata ?? {}) },
  };
}

/** Upsert a manual signal directly. Used by CLI/API/Telegram. */
export function captureSignal(repo: Repo, text: string, by: string, opts: CaptureOptions = {}): Signal {
  if (!text || !text.trim()) throw new Error("captureSignal: text is empty");
  const input = buildCaptureSignal(text, by, opts);
  return repo.signals.upsert(input).signal;
}

function captureDirOf(ctx: SensorContext): string {
  const dir = (ctx.config.capture_dir as string | undefined) || "./data/capture";
  return ctx.resolvePath(dir);
}

export const manualSensor: Sensor = {
  name: MANUAL_SOURCE,
  description: "Drop-folder capture (data/capture/*.md|*.txt) and direct captures from CLI/API/Telegram",

  configured(): boolean {
    return true;
  },

  async poll(ctx: SensorContext): Promise<SensorPollResult> {
    const warnings = new Warnings();
    const dir = captureDirOf(ctx);
    const processed = join(dir, "processed");
    const signals: NewSignal[] = [];
    try {
      mkdirSync(processed, { recursive: true });
    } catch (e) {
      warnings.add(`cannot create capture dir ${dir}: ${errorMessage(e)}`);
      return { signals, warnings: warnings.list, summary: "capture dir unavailable" };
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).filter((f) => EXTENSIONS.has(extname(f).toLowerCase())).sort();
    } catch (e) {
      warnings.add(`cannot read ${dir}: ${errorMessage(e)}`);
      return { signals, warnings: warnings.list };
    }
    let moved = 0;
    for (const name of entries) {
      const file = join(dir, name);
      try {
        const st = statSync(file);
        if (!st.isFile()) continue;
        const raw = readFileSync(file, "utf8");
        const body = excerpt(raw, MAX_BODY);
        if (!body) {
          ctx.logger.debug(`skipping empty capture file ${name}`);
          moveToProcessed(file, processed, name);
          continue;
        }
        const title = firstLine(body) || basename(name, extname(name));
        signals.push({
          source: MANUAL_SOURCE,
          external_id: name,
          kind: "manual",
          title,
          body,
          url: null,
          actor: "user",
          occurred_at: st.mtime.toISOString(),
          metadata: { by: "user", via: "drop_folder", file: name, size: st.size, mtime: st.mtime.toISOString() },
        });
        moveToProcessed(file, processed, name);
        moved++;
      } catch (e) {
        warnings.add(`capture file ${name}: ${errorMessage(e)}`);
      }
    }
    if (signals.length) ctx.logger.info(`captured ${signals.length} file(s) from ${dir}`);
    return { signals, warnings: warnings.list, summary: `${signals.length} captured, ${moved} moved to processed/` };
  },
};

function moveToProcessed(file: string, processedDir: string, name: string): void {
  let target = join(processedDir, name);
  if (existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    target = join(processedDir, `${basename(name, extname(name))}.${stamp}${extname(name)}`);
  }
  renameSync(file, target);
}
