/**
 * HTTP API + dashboard host.
 *
 * createServer(ctx) -> { app, start(), stop() }
 *   app    Hono instance (usable with app.request() in tests)
 *   start  binds config.server.host:port (port 0 picks a free port)
 *   stop   closes SSE streams and the listener
 *
 * Middleware: JSON errors, request log, CORS for localhost dev, optional bearer
 * auth (config.server.token) for every non-GET request and the SSE stream.
 * Static: web/dist (relative to ctx.loaded.rootDir) with SPA fallback; when the
 * bundle is missing a small inline page explains `npm run build:web`.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { timingSafeEqual } from "node:crypto";
import type { AppContext } from "../core/app.js";
import { InvalidTransition } from "../core/state.js";
import { approvalsRoutes } from "./routes/approvals.js";
import { artifactsRoutes } from "./routes/artifacts.js";
import { eventsRoutes } from "./routes/events.js";
import { inboxRoutes } from "./routes/inbox.js";
import { memoriesRoutes } from "./routes/memories.js";
import { opsRoutes } from "./routes/ops.js";
import { runsRoutes } from "./routes/runs.js";
import { signalsRoutes } from "./routes/signals.js";
import { statusRoutes } from "./routes/status.js";
import { tasksRoutes } from "./routes/tasks.js";
import { HttpError } from "./util.js";

export interface ServerHandle {
  app: Hono;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

export interface CreateServerOptions {
  /** SSE heartbeat interval (ms); tests lower it. */
  heartbeatMs?: number;
  /** Override the directory that holds the built dashboard (default <rootDir>/web/dist). */
  distDir?: string;
}

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function noDistPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Task Center</title>
<style>body{font:14px/1.6 -apple-system,system-ui,"PingFang SC","Noto Sans SC",sans-serif;margin:0;background:#f6f7f9;color:#1b1f24}main{max-width:560px;margin:12vh auto;padding:28px 32px;background:#fff;border:1px solid #e3e6ea;border-radius:10px}h1{font-size:18px;margin:0 0 10px}code,pre{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f1f3f5;border-radius:4px}code{padding:1px 5px}pre{padding:10px 12px;overflow:auto}a{color:#2563eb}p{margin:8px 0}</style></head>
<body><main><h1>Task Center 看板尚未构建 (dashboard not built)</h1>
<p>API 已在运行：<a href="/api/status">/api/status</a>。要使用看板，请先构建前端：</p>
<pre>cd taskcenter
npm run build:web      # = npm --prefix web run build</pre>
<p>构建产物位于 <code>web/dist</code>，重启服务或刷新本页即可。开发时也可以运行 <code>npm --prefix web run dev</code>（Vite 会把 <code>/api</code> 代理到本服务）。</p>
</main></body></html>`;
}

export function createServer(ctx: AppContext, opts: CreateServerOptions = {}): ServerHandle {
  const app = new Hono();
  const log = ctx.logger.child("http");
  const token = ctx.config.server.token?.trim() ?? "";
  const distDir = opts.distDir ?? resolve(ctx.loaded.rootDir, "web", "dist");
  const distRoot = normalize(distDir + sep);

  // ── Errors → JSON ────────────────────────────────────────────────
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message, ...(err.details !== undefined ? { details: err.details } : {}) }, err.status as 400);
    }
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof InvalidTransition) return c.json({ error: err.message }, 409);
    const rawStatus = (err as unknown as { status?: unknown }).status;
    const status = typeof rawStatus === "number" && rawStatus >= 400 && rawStatus < 600 ? (rawStatus as 400) : 500;
    if (status >= 500) log.error(`${c.req.method} ${c.req.path}: ${err.message}`, err);
    return c.json({ error: err.message || "internal error" }, status);
  });
  app.notFound((c) => (c.req.path.startsWith("/api") ? c.json({ error: "not found" }, 404) : c.text("not found", 404)));

  // ── Request log ─────────────────────────────────────────────────
  app.use("*", async (c, next) => {
    const t0 = Date.now();
    await next();
    const ms = Date.now() - t0;
    const line = `${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`;
    if (c.req.path.startsWith("/api")) {
      if (c.res.status >= 500) log.error(line);
      else if (c.res.status >= 400) log.warn(line);
      else log.debug(line);
    }
  });

  // ── CORS (localhost dev: vite on another port) ──────────────────
  app.use(
    "/api/*",
    cors({
      origin: (origin) => (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      credentials: true,
      maxAge: 600,
    }),
  );

  // ── Auth ────────────────────────────────────────────────────────
  const auth = async (c: Context, next: Next) => {
    if (!token) return next();
    const needs = c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "OPTIONS";
    const isStream = c.req.path === "/api/events/stream";
    if (!needs && !isStream) return next();
    const header = c.req.header("authorization") ?? "";
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const query = c.req.query("token") ?? "";
    const presented = bearer || query;
    if (!presented || !safeEqual(presented, token)) {
      c.header("WWW-Authenticate", 'Bearer realm="taskcenter"');
      throw new HttpError(401, "unauthorized");
    }
    return next();
  };
  app.use("/api/*", auth);

  // ── API routes ──────────────────────────────────────────────────
  const api = new Hono();
  const events = eventsRoutes(ctx, { heartbeatMs: opts.heartbeatMs });
  api.route("/", statusRoutes(ctx));
  api.route("/", inboxRoutes(ctx));
  api.route("/", tasksRoutes(ctx));
  api.route("/", runsRoutes(ctx));
  api.route("/", approvalsRoutes(ctx));
  api.route("/", events.app);
  api.route("/", artifactsRoutes(ctx));
  api.route("/", signalsRoutes(ctx));
  api.route("/", memoriesRoutes(ctx));
  api.route("/", opsRoutes(ctx));
  app.route("/api", api);

  // ── Static dashboard (web/dist) with SPA fallback ───────────────
  app.get("/*", (c) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
    const indexPath = join(distDir, "index.html");
    if (!existsSync(indexPath)) return c.html(noDistPage());
    let urlPath = decodeURIComponent(c.req.path);
    if (urlPath.endsWith("/")) urlPath += "index.html";
    const candidate = normalize(join(distDir, urlPath));
    const inside = candidate === normalize(distDir) || candidate.startsWith(distRoot);
    if (inside && existsSync(candidate) && statSync(candidate).isFile()) return sendFile(c, candidate, urlPath.startsWith("/assets/"));
    // SPA fallback: unknown paths (no extension) get index.html; asset-looking misses are 404.
    if (extname(urlPath) && !urlPath.endsWith(".html")) return c.text("not found", 404);
    return sendFile(c, indexPath, false);
  });

  // ── Lifecycle ───────────────────────────────────────────────────
  let server: ServerType | undefined;
  return {
    app,
    async start() {
      if (server) throw new Error("server already started");
      const host = ctx.config.server.host || "127.0.0.1";
      const port = ctx.config.server.port ?? 4800;
      return new Promise((resolvePromise, reject) => {
        const s = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
          server = s;
          log.info(`dashboard listening on http://${info.address}:${info.port}${token ? " (bearer auth on)" : ""}`);
          resolvePromise({ host: info.address, port: info.port });
        });
        s.once("error", (e) => reject(e));
      });
    },
    async stop() {
      events.sse.closeAll();
      const s = server;
      server = undefined;
      if (!s) return;
      await new Promise<void>((resolveClose) => {
        s.close(() => resolveClose());
        // Idle keep-alive sockets would otherwise delay close() indefinitely.
        (s as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
    },
  };
}

function sendFile(c: Context, path: string, immutable: boolean): Response {
  const st = statSync(path);
  const mime = STATIC_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
  return c.body(stream, 200, {
    "Content-Type": mime,
    "Content-Length": String(st.size),
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
}
