export function nowIso(): string {
  return new Date().toISOString();
}

export function isoPlus(ms: number, from: Date = new Date()): string {
  return new Date(from.getTime() + ms).toISOString();
}

export function dayKey(d: Date = new Date(), timeZone?: string): string {
  // YYYY-MM-DD in the given timezone (defaults to local)
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function parseDurationMs(s: string | number | undefined, fallback: number): number {
  if (s === undefined || s === null) return fallback;
  if (typeof s === "number") return s;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(s.trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * MINUTE;
    case "h":
      return n * HOUR;
    case "d":
      return n * DAY;
    default:
      return n * 1000;
  }
}
