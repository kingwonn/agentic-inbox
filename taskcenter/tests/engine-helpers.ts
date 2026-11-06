import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { createApp } from "../src/engine/app.js";
import { getWired, type Wired } from "../src/engine/wiring.js";
import type { SensorEntry } from "../src/engine/types.js";
import type { AppContext } from "../src/core/app.js";
import { silentLogger } from "../src/core/logger.js";
import type { NewSignal } from "../src/core/types.js";
import type { Sensor, SensorPollResult } from "../src/sensors/types.js";

export const ROOT = resolve(import.meta.dirname, "..");

export interface TestCtx {
  ctx: AppContext;
  wired: Wired;
  dir: string;
  cleanup(): Promise<void>;
}

export async function makeCtx(opts: { config?: Record<string, unknown>; sensors?: SensorEntry[]; brain?: Record<string, unknown>; executor?: Record<string, unknown> } = {}): Promise<TestCtx> {
  const dir = mkdtempSync(join(tmpdir(), "tc-engine-"));
  const cfg = {
    data_dir: join(dir, "data"),
    timezone: "UTC",
    locale: "en",
    brain: { provider: "dry", daily_budget_usd: 20, timeout_seconds: 10, ...(opts.brain ?? {}) },
    executor: { concurrency: 2, max_attempts: 3, backoff_seconds: [1, 2, 3], workspace_root: join(dir, "ws"), repo_root: dir, ...(opts.executor ?? {}) },
    approval: { wait_seconds: 1, expire_hours: 72 },
    sensors: { github: { enabled: false }, localgit: { enabled: false }, manual: { enabled: true } },
    notifications: { channels: { console: { enabled: true } }, digest: { enabled: true, cron: "30 8 * * *" } },
    ...(opts.config ?? {}),
  };
  const configPath = join(dir, "taskcenter.yaml");
  writeFileSync(configPath, stringify(cfg));
  const ctx = await createApp({ configPath, cwd: ROOT, dbPath: ":memory:", isolated: true, logger: silentLogger, sensors: opts.sensors ?? [] });
  const wired = getWired(ctx)!;
  return {
    ctx,
    wired,
    dir,
    async cleanup() {
      await ctx.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A scriptable sensor: each poll returns the next batch (last batch repeats). */
export function stubSensor(name: string, batches: Array<NewSignal[] | Error>, opts: { configured?: boolean } = {}): SensorEntry & { polls: number } {
  let i = 0;
  const entry = {
    polls: 0,
    enabled: true,
    config: {},
    sensor: {
      name,
      description: `stub ${name}`,
      configured: () => opts.configured ?? true,
      async poll(): Promise<SensorPollResult> {
        entry.polls++;
        const b = batches[Math.min(i, batches.length - 1)];
        i++;
        if (b instanceof Error) throw b;
        return { signals: b.map((s) => ({ ...s, source: name })), summary: `${b.length} items` };
      },
    } satisfies Sensor,
  };
  return entry;
}

export function sig(external_id: string, title: string, body = ""): NewSignal {
  return { source: "stub", external_id, kind: "item", title, body };
}

export async function waitFor(fn: () => boolean, ms = 5000, step = 20): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error("waitFor timed out");
}
