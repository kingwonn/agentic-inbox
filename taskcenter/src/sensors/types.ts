import type { Logger } from "../core/logger.js";
import type { NewSignal } from "../core/types.js";

/** Key/value cursor store scoped to one sensor. */
export interface CursorStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  getJson<T>(key: string, fallback: T): T;
  setJson(key: string, value: unknown): void;
}

export interface SensorContext {
  /** The sensor's own config section (already env-substituted and validated). */
  config: Record<string, unknown>;
  cursors: CursorStore;
  logger: Logger;
  now(): Date;
  /** Root dir of the taskcenter package (for resolving relative paths). */
  rootDir: string;
  /** Resolve a config-relative path. */
  resolvePath(p: string): string;
}

export interface SensorPollResult {
  signals: NewSignal[];
  /** Human-readable summary for the sensor_poll event. */
  summary?: string;
  /** Non-fatal warnings. */
  warnings?: string[];
}

/**
 * A Sensor turns an external information source into Signals.
 * Rules: idempotent (stable external_id), cursor-based (never re-emit unchanged items),
 * and resilient (throw only on configuration/auth errors; network blips -> warnings).
 */
export interface Sensor {
  readonly name: string;
  readonly description: string;
  /** true when the config has everything needed to run. */
  configured(config: Record<string, unknown>): boolean;
  poll(ctx: SensorContext): Promise<SensorPollResult>;
}

export function makeCursorStore(get: (k: string) => string | undefined, set: (k: string, v: string) => void): CursorStore {
  return {
    get,
    set,
    getJson<T>(key: string, fallback: T): T {
      const v = get(key);
      if (v === undefined) return fallback;
      try {
        return JSON.parse(v) as T;
      } catch {
        return fallback;
      }
    },
    setJson(key: string, value: unknown) {
      set(key, JSON.stringify(value));
    },
  };
}
