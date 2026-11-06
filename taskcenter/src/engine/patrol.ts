/**
 * Patrol: poll every enabled sensor, upsert signals, isolate failures, then wake triage.
 */
import type { AppContext, PatrolReport } from "../core/app.js";
import { nowIso } from "../core/time.js";
import { makeCursorStore, type SensorContext } from "../sensors/types.js";
import type { PatrolDeps, SensorEntry } from "./types.js";
import { errMsg, mapPool, withTimeout } from "./util.js";

export interface PatrolService {
  runOnce(sensorNames?: string[]): Promise<PatrolReport>;
  sensors(): Array<{ name: string; enabled: boolean; configured: boolean; description: string; failures: number }>;
}

export function failureKey(name: string): string {
  return `sensor_failures:${name}`;
}

/** Default SensorContext built from core only (the sensors registry provides a richer one). */
export function defaultSensorContext(ctx: AppContext, entry: SensorEntry): SensorContext {
  const name = entry.sensor.name;
  return {
    config: entry.config,
    cursors: makeCursorStore(
      (k) => ctx.repo.cursors.get(name, k),
      (k, v) => ctx.repo.cursors.set(name, k, v),
    ),
    logger: ctx.logger.child(`sensor:${name}`),
    now: () => new Date(),
    rootDir: ctx.loaded.rootDir,
    resolvePath: (p) => ctx.loaded.resolve(p),
  };
}

export function createPatrol(ctx: AppContext, sensors: SensorEntry[], deps: PatrolDeps = {}): PatrolService {
  const { repo, bus } = ctx;
  const logger = ctx.logger.child("patrol");
  const timeoutMs = deps.timeoutMs ?? 120_000;
  const parallelism = deps.parallelism ?? 3;
  const makeCtx = deps.makeSensorContext ?? ((entry: SensorEntry) => defaultSensorContext(ctx, entry));
  let inFlight: Promise<PatrolReport> | null = null;

  function failures(name: string): number {
    return Number(repo.meta.get(failureKey(name)) ?? 0) || 0;
  }

  async function pollOne(entry: SensorEntry): Promise<PatrolReport["sensors"][number]> {
    const name = entry.sensor.name;
    const t0 = Date.now();
    const base = { name, newSignals: 0, changedSignals: 0 };
    if (!entry.sensor.configured(entry.config)) {
      return { ...base, ok: true, summary: "skipped: not configured", durationMs: Date.now() - t0 };
    }
    try {
      const sctx = makeCtx(entry);
      const res = await withTimeout(entry.sensor.poll(sctx), timeoutMs, `sensor ${name}`);
      const newIds: string[] = [];
      let changed = 0;
      repo.transaction(() => {
        for (const s of res.signals ?? []) {
          if (!s || !s.external_id || !s.title) continue;
          const r = repo.signals.upsert({ ...s, source: s.source || name });
          if (r.isNew) newIds.push(r.signal.id);
          else if (r.changed) changed++;
        }
      });
      const durationMs = Date.now() - t0;
      const warnings = res.warnings ?? [];
      bus.record({
        type: "sensor_poll",
        level: warnings.length ? "warn" : "info",
        message: `${name}: ${newIds.length} new, ${changed} changed${res.summary ? ` — ${res.summary}` : ""}`,
        payload: { sensor: name, new: newIds.length, changed, warnings, durationMs, summary: res.summary ?? null },
      });
      for (const id of newIds) bus.emit("signal.new", { signal_id: id, source: name });
      repo.meta.set(failureKey(name), "0");
      return { ...base, ok: true, newSignals: newIds.length, changedSignals: changed, summary: res.summary, durationMs };
    } catch (e) {
      const durationMs = Date.now() - t0;
      const n = failures(name) + 1;
      repo.meta.set(failureKey(name), String(n));
      const error = errMsg(e);
      logger.error(`sensor ${name} failed (${n} consecutive): ${error}`);
      bus.record({ type: "error", level: "error", message: `sensor ${name} failed: ${error}`, payload: { sensor: name, consecutiveFailures: n, durationMs } });
      return { ...base, ok: false, error, durationMs };
    }
  }

  async function runOnce(sensorNames?: string[]): Promise<PatrolReport> {
    const startedAt = nowIso();
    const selected = sensors.filter((e) => (sensorNames?.length ? sensorNames.includes(e.sensor.name) : e.enabled));
    const reports = await mapPool(selected, parallelism, (e) => pollOne(e));
    const report: PatrolReport = {
      startedAt,
      finishedAt: nowIso(),
      sensors: reports,
      totalNew: reports.reduce((n, r) => n + r.newSignals, 0),
      totalChanged: reports.reduce((n, r) => n + r.changedSignals, 0),
    };
    logger.info(`patrol done: ${report.totalNew} new, ${report.totalChanged} changed across ${reports.length} sensors`);
    if (repo.signals.listUntriaged(1).length > 0) bus.wake("patrol");
    return report;
  }

  return {
    runOnce(sensorNames) {
      // coalesce concurrent calls (scheduler + manual)
      if (inFlight && !sensorNames) return inFlight;
      const p = runOnce(sensorNames).finally(() => {
        if (inFlight === p) inFlight = null;
      });
      if (!sensorNames) inFlight = p;
      return p;
    },
    sensors() {
      return sensors.map((e) => ({
        name: e.sensor.name,
        enabled: e.enabled,
        configured: e.sensor.configured(e.config),
        description: e.sensor.description,
        failures: failures(e.sensor.name),
      }));
    },
  };
}
