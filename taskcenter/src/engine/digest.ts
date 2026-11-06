/**
 * Daily digest + context refresh services (thin wrappers over the brain functions).
 */
import type { AppContext } from "../core/app.js";
import type { ContextRefreshDeps, DigestDeps } from "./types.js";
import { errMsg, trimText } from "./util.js";

export interface DigestService {
  build(): Promise<string>;
  send(): Promise<void>;
}

export function createDigestService(ctx: AppContext, deps: DigestDeps): DigestService {
  const { repo, config, bus } = ctx;
  const logger = ctx.logger.child("digest");
  async function build(): Promise<string> {
    const context = deps.loadContext();
    return deps.buildDigest({ repo, config, context, llm: deps.llm, logger });
  }
  async function send(): Promise<void> {
    const text = await build();
    const notifier = ctx.services.notifier;
    const zh = config.locale.toLowerCase().startsWith("zh");
    const title = zh ? `每日摘要 · ${new Date().toISOString().slice(0, 10)}` : `Daily digest · ${new Date().toISOString().slice(0, 10)}`;
    if (notifier) {
      try {
        await notifier.notify({ kind: "digest", title, body: text, priority: "low" });
      } catch (e) {
        logger.error(`digest notify failed: ${errMsg(e)}`);
      }
    } else {
      process.stderr.write(text + "\n");
    }
    bus.record({ type: "notification", message: "digest sent", payload: { length: text.length, preview: trimText(text, 300) } });
  }
  return { build, send };
}

export interface ContextRefreshService {
  runOnce(): Promise<{ memoriesAdded: number }>;
}

export function createContextRefresh(ctx: AppContext, deps: ContextRefreshDeps): ContextRefreshService {
  const { repo, config, loaded, bus } = ctx;
  const logger = ctx.logger.child("context-refresh");
  return {
    async runOnce() {
      const out = await deps.refreshContext({ repo, config, loaded, llm: deps.llm, logger });
      bus.record({ type: "memory", message: `context refresh: ${out.memoriesAdded} memories added`, payload: { ...out } });
      return out;
    },
  };
}
