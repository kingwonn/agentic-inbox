import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import type { AppContext } from "../../core/app.js";
import { HttpError, intParam, notFound, pageOf } from "../util.js";

const MIME: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".patch": "text/x-diff; charset=utf-8",
  ".diff": "text/x-diff; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".js": "text/plain; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
};

/** True when `target` (after symlink resolution) lives inside one of `roots`. */
export function isInside(target: string, roots: string[]): boolean {
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return false;
  }
  for (const r of roots) {
    let root: string;
    try {
      root = realpathSync(r);
    } catch {
      continue;
    }
    if (real === root || real.startsWith(root.endsWith(sep) ? root : root + sep)) return true;
  }
  return false;
}

export function artifactsRoutes(ctx: AppContext) {
  const app = new Hono();
  const { repo } = ctx;

  /** Roots an artifact file may be served from: data dir and the workspace root. */
  const allowedRoots = () => [ctx.dataDir, ctx.loaded.resolve(ctx.config.executor.workspace_root)];

  app.get("/artifacts", (c) => {
    const limit = intParam(c, "limit", 100, 500, 1);
    const offset = intParam(c, "offset", 0);
    const task_id = c.req.query("task_id") || undefined;
    const rows = task_id ? repo.artifacts.listByTask(task_id) : repo.artifacts.list({ limit, offset });
    const items = rows.map((a) => ({ ...a, task_title: repo.tasks.get(a.task_id)?.title ?? null }));
    return c.json(pageOf(items, limit, offset));
  });

  app.get("/artifacts/:id", (c) => {
    const artifact = repo.artifacts.get(c.req.param("id"));
    if (!artifact) throw notFound("artifact not found");
    const download = c.req.query("download");
    if (!download || download === "0") {
      const task = repo.tasks.get(artifact.task_id) ?? null;
      let downloadable = false;
      if (artifact.path) {
        const abs = isAbsolute(artifact.path) ? artifact.path : resolve(ctx.dataDir, artifact.path);
        downloadable = existsSync(abs) && isInside(abs, allowedRoots());
      }
      return c.json({ artifact, task, downloadable });
    }
    // ── download: inline content first, then the file on disk (guarded) ──
    if (artifact.content !== null && artifact.content !== undefined && !artifact.path) {
      const mime = artifact.mime ?? "text/plain; charset=utf-8";
      return c.body(artifact.content, 200, {
        "Content-Type": mime.includes("charset") ? mime : `${mime}; charset=utf-8`,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.title || artifact.id)}`,
      });
    }
    if (!artifact.path) throw notFound("artifact has no file");
    // Relative paths are resolved against the data dir; absolute paths must still be inside an allowed root.
    const abs = isAbsolute(artifact.path) ? artifact.path : resolve(ctx.dataDir, artifact.path);
    if (abs.includes("\0")) throw new HttpError(400, "invalid path");
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      if (artifact.content) return c.body(artifact.content, 200, { "Content-Type": artifact.mime ?? "text/plain; charset=utf-8" });
      throw notFound("artifact file not found");
    }
    if (!isInside(abs, allowedRoots())) throw new HttpError(403, "artifact path is outside the allowed roots");
    const st = statSync(abs);
    const mime = artifact.mime ?? MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
    const stream = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream;
    return c.body(stream, 200, {
      "Content-Type": mime,
      "Content-Length": String(st.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(abs))}`,
    });
  });

  return app;
}
