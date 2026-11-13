/**
 * startDaemon: recovery → inbound channels → executor → scheduler → HTTP server →
 * initial patrol. Handles SIGINT/SIGTERM gracefully; never crashes on an
 * unhandled rejection; exits 1 on uncaught exceptions (the supervisor restarts).
 */
import { join } from "node:path";
import type { AppContext } from "../core/app.js";
import { acquireLock } from "./lock.js";
import { runRecovery } from "./recovery.js";
import { getWired, type Wired } from "./wiring.js";
import { errMsg } from "./util.js";

export interface DaemonOptions {
  serve?: boolean;
  /** Install SIGINT/SIGTERM/unhandledRejection handlers (default true). */
  handleSignals?: boolean;
  /** Delay before the first patrol (default 5s; 0 disables). */
  initialPatrolDelayMs?: number;
}

export interface DaemonHandle {
  stop(): Promise<void>;
  url: string | null;
}

export async function startDaemon(ctx: AppContext, opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const wired = getWired(ctx);
  if (!wired) throw new Error("context is not wired; use createApp()");
  const w: Wired = wired;
  const logger = ctx.logger.child("daemon");
  const serve = opts.serve ?? true;
  const lock = acquireLock(join(ctx.dataDir, "taskcenter.lock"));

  const recovery = runRecovery(ctx, { expireApprovals: w.approvals.expireDue ? (now?: Date) => w.approvals.expireDue!(now) : undefined });

  if (w.notifier.start) {
    try {
      await w.notifier.start(w.createInboundHandler());
    } catch (e) {
      logger.error(`notifier inbound start failed: ${errMsg(e)}`);
    }
  }
  w.executor.start?.();
  w.scheduler.start();

  let server: { stop(): Promise<void> } | undefined;
  let url: string | null = null;
  if (serve) {
    if (!w.createServer) logger.warn("HTTP server module not available; running without API/dashboard");
    else {
      const s = w.createServer(ctx);
      const { host, port } = await s.start();
      server = s;
      url = `http://${host}:${port}`;
    }
  }

  const delay = opts.initialPatrolDelayMs ?? 5000;
  let initial: NodeJS.Timeout | undefined;
  if (delay > 0) {
    initial = setTimeout(() => {
      w.patrol.runOnce().catch((e) => logger.error(`initial patrol failed: ${errMsg(e)}`));
    }, delay);
    initial.unref?.();
  }

  ctx.bus.record({ type: "system", message: `daemon started (pid ${process.pid})${url ? ` — dashboard ${url}` : ""}`, payload: { pid: process.pid, url, recovery, dry: w.dry, modules: w.modules } });
  logger.info(`ready${url ? ` — dashboard ${url}` : ""} (pid ${process.pid}, provider ${ctx.config.brain.provider}${w.dry ? " [dry]" : ""})`);

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    logger.info("stopping…");
    if (initial) clearTimeout(initial);
    removeHandlers();
    try {
      w.scheduler.stop();
    } catch (e) {
      logger.warn(`scheduler stop: ${errMsg(e)}`);
    }
    try {
      await w.executor.stop?.();
    } catch (e) {
      logger.warn(`executor stop: ${errMsg(e)}`);
    }
    try {
      await w.notifier.stop?.();
    } catch (e) {
      logger.warn(`notifier stop: ${errMsg(e)}`);
    }
    try {
      await server?.stop();
    } catch (e) {
      logger.warn(`server stop: ${errMsg(e)}`);
    }
    try {
      ctx.bus.record({ type: "system", message: "daemon stopped", payload: { pid: process.pid } });
    } catch {
      /* db may be closing */
    }
    lock.release();
    await ctx.shutdown();
    logger.info("stopped");
  }

  const onSignal = (sig: NodeJS.Signals) => {
    logger.info(`received ${sig}`);
    stop()
      .catch((e) => logger.error(`stop failed: ${errMsg(e)}`))
      .finally(() => process.exit(0));
  };
  const onRejection = (reason: unknown) => logger.error(`unhandled rejection: ${errMsg(reason)}`, reason);
  const onException = (err: Error) => {
    logger.error(`uncaught exception: ${errMsg(err)}`, err);
    stop()
      .catch(() => {})
      .finally(() => process.exit(1));
  };
  function removeHandlers() {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  }
  if (opts.handleSignals ?? true) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("unhandledRejection", onRejection);
    process.on("uncaughtException", onException);
  }

  return { stop, url };
}
