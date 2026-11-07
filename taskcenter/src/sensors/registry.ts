/**
 * Sensor registry: maps config sections to Sensor implementations and builds
 * the per-sensor SensorContext (cursor store scoped by sensor name, child logger).
 */
import type { Config } from "../config/schema.js";
import type { LoadedConfig } from "../config/load.js";
import type { Logger } from "../core/logger.js";
import type { Repo } from "../core/repo.js";
import { githubSensor } from "./github.js";
import { imapSensor } from "./imap.js";
import { icsSensor } from "./ics.js";
import { localgitSensor } from "./localgit.js";
import { fsdocsSensor } from "./fsdocs.js";
import { manualSensor } from "./manual.js";
import { makeCursorStore, type Sensor, type SensorContext } from "./types.js";

export interface SensorEntry {
  sensor: Sensor;
  config: Record<string, unknown>;
  enabled: boolean;
}

/** All built-in sensors in patrol order. */
export const ALL_SENSORS: readonly Sensor[] = [manualSensor, localgitSensor, githubSensor, imapSensor, icsSensor, fsdocsSensor];

export function getSensor(name: string): Sensor | undefined {
  return ALL_SENSORS.find((s) => s.name === name);
}

/** Build the sensor config section handed to each sensor (its own section + the few global keys it needs). */
export function sensorConfigFor(name: string, config: Config): Record<string, unknown> {
  const sections = config.sensors as unknown as Record<string, Record<string, unknown> | undefined>;
  const own = { ...(sections[name] ?? {}) };
  if (name === "manual") {
    own.capture_dir ??= `${config.data_dir.replace(/\/+$/, "")}/capture`;
  }
  if (name === "localgit") {
    own.repo_root ??= config.executor.repo_root;
  }
  own.locale ??= config.locale;
  own.timezone ??= config.timezone;
  return own;
}

/**
 * One entry per built-in sensor. `enabled` = config.enabled && sensor.configured(cfg),
 * so a sensor that is switched on but lacks credentials simply shows as disabled
 * (the patrol reports it) instead of failing every poll.
 */
export function createSensors(config: Config): SensorEntry[] {
  return ALL_SENSORS.map((sensor) => {
    const cfg = sensorConfigFor(sensor.name, config);
    const wanted = cfg.enabled === true;
    let configured = false;
    try {
      configured = wanted && sensor.configured(cfg);
    } catch {
      configured = false;
    }
    return { sensor, config: cfg, enabled: wanted && configured };
  });
}

export function makeSensorContext(
  entry: SensorEntry,
  deps: { repo: Repo; logger: Logger; loaded: LoadedConfig; now?: () => Date },
): SensorContext {
  const name = entry.sensor.name;
  const cursors = makeCursorStore(
    (k) => deps.repo.cursors.get(name, k),
    (k, v) => deps.repo.cursors.set(name, k, v),
  );
  return {
    config: entry.config,
    cursors,
    logger: deps.logger.child(`sensor:${name}`),
    now: deps.now ?? (() => new Date()),
    rootDir: deps.loaded.rootDir,
    resolvePath: (p: string) => deps.loaded.resolve(p),
  };
}
