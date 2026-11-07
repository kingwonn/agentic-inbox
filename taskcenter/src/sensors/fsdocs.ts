/**
 * Filesystem documents sensor: scans configured folders for new/changed files and
 * emits `document` signals with a text excerpt and extracted open items (TODO /
 * FIXME / `- [ ]`). Change detection: (mtime, size) first, then sha256 of the
 * content; the cursor keeps `{ relPath: { mtime, size, hash } }` per root.
 * `.md/.txt`-like files are read directly; other extensions (docx, pdf, pptx, …)
 * go through `markitdown <file>` when it is installed, otherwise they are skipped
 * with a warning.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { NewSignal } from "../core/types.js";
import { t } from "./i18n.js";
import type { Sensor, SensorContext, SensorPollResult } from "./types.js";
import { commandExists, errorMessage, excerpt, firstLine, runCommand, sha1, Warnings } from "./util.js";

export const FSDOCS_SOURCE = "fsdocs";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".cache", ".obsidian", ".trash", "__pycache__", ".venv", "venv"]);
const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "text", "rst", "org", "adoc", "csv", "json", "yaml", "yml", "html", "htm"]);
const EXCERPT_CHARS = 3000;
const MAX_TODOS = 20;
const MAX_FILES_PER_POLL = 200;
const MAX_DEPTH = 12;

interface FileRecord {
  mtime: number;
  size: number;
  hash: string;
}

export interface ScannedFile {
  abs: string;
  rel: string;
  ext: string;
  size: number;
  mtimeMs: number;
}

export function extractTodos(text: string, max = MAX_TODOS): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-*+]\s*\[ \]/.test(line) || /\b(TODO|FIXME|XXX|HACK)\b/.test(line)) {
      out.push(line.length > 200 ? line.slice(0, 199) + "…" : line);
      if (out.length >= max) break;
    }
  }
  return out;
}

export function walk(root: string, extensions: Set<string>, maxBytes: number, onSkipLarge?: (f: string) => void): ScannedFile[] {
  const out: ScannedFile[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const name = ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
        visit(join(dir, name), depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      if (name.startsWith(".") || name.startsWith("~$")) continue;
      const ext = extname(name).slice(1).toLowerCase();
      if (!extensions.has(ext)) continue;
      const abs = join(dir, name);
      try {
        const st = statSync(abs);
        if (st.size > maxBytes) {
          onSkipLarge?.(abs);
          continue;
        }
        out.push({ abs, rel: relative(root, abs), ext, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* vanished */
      }
    }
  };
  visit(root, 0);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export type Extractor = (file: ScannedFile) => Promise<string | undefined>;

export async function defaultExtract(file: ScannedFile, opts: { markitdown: boolean; timeoutMs?: number }): Promise<string | undefined> {
  if (TEXT_EXTENSIONS.has(file.ext)) {
    const raw = readFileSync(file.abs, "utf8");
    return raw;
  }
  if (!opts.markitdown) return undefined;
  const r = await runCommand("markitdown", [file.abs], { timeoutMs: opts.timeoutMs ?? 60_000 });
  if (r.error || r.code !== 0) throw new Error(`markitdown failed: ${r.error ?? r.stderr.trim().slice(0, 200) ?? `exit ${r.code}`}`);
  return r.stdout;
}

export interface FsDocsSensorOptions {
  extract?: Extractor;
  /** Override markitdown availability (tests). */
  hasMarkitdown?: () => boolean;
}

export function createFsDocsSensor(opts: FsDocsSensorOptions = {}): Sensor {
  const hasMarkitdown = opts.hasMarkitdown ?? (() => commandExists("markitdown"));
  return {
    name: FSDOCS_SOURCE,
    description: "Local document folders: new/changed notes and documents with excerpts and open items",

    configured(config): boolean {
      const paths = (config.paths as string[] | undefined) ?? [];
      return paths.filter(Boolean).length > 0;
    },

    async poll(ctx: SensorContext): Promise<SensorPollResult> {
      const warnings = new Warnings();
      const signals: NewSignal[] = [];
      const locale = String(ctx.config.locale ?? "zh-CN");
      const paths = ((ctx.config.paths as string[] | undefined) ?? []).filter(Boolean);
      const extensions = new Set(((ctx.config.extensions as string[] | undefined) ?? ["md", "txt"]).map((e) => e.replace(/^\./, "").toLowerCase()));
      const maxBytes = Math.max(1, Number(ctx.config.max_file_kb ?? 512)) * 1024;
      const markitdown = hasMarkitdown();
      const extract: Extractor = opts.extract ?? ((f) => defaultExtract(f, { markitdown }));
      const now = ctx.now();
      let budget = MAX_FILES_PER_POLL;
      let scanned = 0;
      let skippedNoExtractor = 0;

      for (const p of paths) {
        const root = ctx.resolvePath(p.startsWith("~/") ? join(process.env.HOME ?? "", p.slice(2)) : p);
        let st;
        try {
          st = statSync(root);
        } catch {
          warnings.add(`path not found: ${p}`);
          continue;
        }
        if (!st.isDirectory()) {
          warnings.add(`not a directory: ${p}`);
          continue;
        }
        const cursorKey = `files:${sha1(root).slice(0, 12)}`;
        const prev = ctx.cursors.getJson<Record<string, FileRecord>>(cursorKey, {});
        const next: Record<string, FileRecord> = {};
        const files = walk(root, extensions, maxBytes, (f) => ctx.logger.debug(`skipping large file ${f}`));
        scanned += files.length;
        let deferred = false;
        for (const file of files) {
          const old = prev[file.rel];
          if (old && old.mtime === file.mtimeMs && old.size === file.size) {
            next[file.rel] = old;
            continue;
          }
          if (budget <= 0) {
            deferred = true;
            if (old) next[file.rel] = old; // keep old record so it is re-examined next poll
            continue;
          }
          let hash: string;
          try {
            hash = createHash("sha256").update(readFileSync(file.abs)).digest("hex");
          } catch (e) {
            warnings.add(`${file.rel}: ${errorMessage(e)}`);
            continue;
          }
          if (old && old.hash === hash) {
            next[file.rel] = { mtime: file.mtimeMs, size: file.size, hash };
            continue;
          }
          budget--;
          let text: string | undefined;
          try {
            text = await extract(file);
          } catch (e) {
            warnings.add(`${file.rel}: ${errorMessage(e)}`);
            next[file.rel] = { mtime: file.mtimeMs, size: file.size, hash }; // don't retry a broken file every poll
            continue;
          }
          if (text === undefined) {
            skippedNoExtractor++;
            continue; // not recorded: picked up once an extractor becomes available
          }
          next[file.rel] = { mtime: file.mtimeMs, size: file.size, hash };
          const body = excerpt(text, EXCERPT_CHARS);
          const todos = extractTodos(text);
          const name = basename(file.abs);
          const heading = TEXT_EXTENSIONS.has(file.ext) ? firstLine(text, 100) : "";
          const changed = old ? "updated" : "new";
          signals.push({
            source: FSDOCS_SOURCE,
            external_id: file.abs,
            kind: "document",
            title: t(locale, changed === "new" ? "docs.new" : "docs.updated", { name: heading && heading !== name ? `${name} — ${heading}` : name }),
            body: [body, todos.length ? `\n${t(locale, "docs.label.todos")}:\n${todos.map((x) => `- ${x}`).join("\n")}` : ""].join("").trim(),
            url: null,
            actor: null,
            occurred_at: new Date(file.mtimeMs).toISOString(),
            metadata: {
              path: file.abs,
              root,
              rel: file.rel,
              name,
              ext: file.ext,
              size: file.size,
              mtime: new Date(file.mtimeMs).toISOString(),
              hash: hash.slice(0, 16),
              changed,
              todos,
              todo_count: todos.length,
              chars: text.length,
              observed_at: now.toISOString(),
            },
          });
        }
        if (deferred) warnings.add(`${p}: more than ${MAX_FILES_PER_POLL} changed files, remaining ones are processed next poll`);
        ctx.cursors.setJson(cursorKey, next);
      }
      if (skippedNoExtractor > 0) warnings.add(`${skippedNoExtractor} file(s) need \`markitdown\` (pipx install 'markitdown[all]') and were skipped`);
      return { signals, warnings: warnings.list, summary: `${scanned} files scanned, ${signals.length} new/changed` };
    },
  };
}

export const fsdocsSensor = createFsDocsSensor();
