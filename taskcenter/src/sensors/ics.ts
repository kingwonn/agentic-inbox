/**
 * ICS calendar sensor (node-ical). For each configured URL (or local .ics path),
 * expands events in [now, now + horizon_days] and diffs them against the previous
 * snapshot `{ "<uid>@<startIso>": { hash, ... } }`:
 *   new / updated / cancelled  -> kind "calendar_event"        (metadata.changed)
 *   disappeared while future   -> kind "calendar_event_removed"
 * external_id = `<uid>@<startIso>` for both kinds, so one signal tracks one instance.
 */
import ical, { expandRecurringEvent, type CalendarResponse, type EventInstance, type VEvent } from "node-ical";
import type { NewSignal } from "../core/types.js";
import { t } from "./i18n.js";
import type { Sensor, SensorContext, SensorPollResult } from "./types.js";
import { errorMessage, excerpt, hashOf, isTransientError, sha1, sleep, timeoutSignal, truncate, Warnings } from "./util.js";

export const ICS_SOURCE = "ics";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_ATTENDEES = 25;

interface SnapshotEntry {
  hash: string;
  uid: string;
  start: string;
  end: string | null;
  summary: string;
  status: string | null;
}
type Snapshot = Record<string, SnapshotEntry>;

export interface Attendee {
  email: string | null;
  name: string | null;
  status: string | null; // PARTSTAT
  role: string | null;
}

export interface ExpandedEvent {
  key: string;
  uid: string;
  summary: string;
  description: string;
  location: string | null;
  start: Date;
  end: Date | null;
  allDay: boolean;
  tz: string | null;
  status: string | null;
  attendees: Attendee[];
  organizer: Attendee | null;
  url: string | null;
  recurring: boolean;
  override: boolean;
  sequence: number | null;
  lastModified: string | null;
}

export type CalendarLoader = (source: string, ctx: SensorContext) => Promise<CalendarResponse>;

function pv(x: unknown): string {
  if (x === undefined || x === null) return "";
  if (typeof x === "string") return x;
  if (typeof x === "object" && "val" in (x as object)) return String((x as { val: unknown }).val ?? "");
  return String(x);
}

function params(x: unknown): Record<string, string> {
  if (x && typeof x === "object" && "params" in (x as object)) {
    const p = (x as { params?: Record<string, string> }).params;
    return p && typeof p === "object" ? p : {};
  }
  return {};
}

function toAttendee(x: unknown): Attendee | null {
  const val = pv(x).trim();
  if (!val) return null;
  const p = params(x);
  const email = val.replace(/^mailto:/i, "").trim() || null;
  return { email, name: p.CN ?? null, status: p.PARTSTAT ?? null, role: p.ROLE ?? null };
}

function attendeesOf(ev: VEvent): Attendee[] {
  const raw = ev.attendee;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map(toAttendee).filter((a): a is Attendee => a !== null).slice(0, MAX_ATTENDEES);
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

export const defaultLoader: CalendarLoader = async (source, ctx) => {
  if (!isHttpUrl(source)) {
    return ical.async.parseFile(ctx.resolvePath(source));
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fromURL = ical.async.fromURL as unknown as (url: string, options: Record<string, unknown>) => Promise<CalendarResponse>;
      return await fromURL(source, { signal: timeoutSignal(FETCH_TIMEOUT_MS), headers: { "user-agent": "taskcenter-ics/0.1" } });
    } catch (e) {
      lastErr = e;
      if (attempt < 2 && isTransientError(e)) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
};

/** Expand every VEVENT of a parsed calendar into instances within [from, to]. */
export function expandCalendar(data: CalendarResponse, from: Date, to: Date): ExpandedEvent[] {
  const out: ExpandedEvent[] = [];
  for (const comp of Object.values(data)) {
    if (!comp || typeof comp !== "object" || (comp as { type?: string }).type !== "VEVENT") continue;
    const ev = comp as VEvent;
    if (!ev.uid || !ev.start) continue;
    let instances: EventInstance[];
    try {
      instances = expandRecurringEvent(ev, { from, to, includeOverrides: true, excludeExdates: true, expandOngoing: true });
    } catch {
      continue;
    }
    for (const inst of instances) {
      const src = (inst.event ?? ev) as VEvent;
      const start = inst.start as Date;
      if (!(start instanceof Date) || Number.isNaN(start.getTime())) continue;
      const end = inst.end instanceof Date && !Number.isNaN(inst.end.getTime()) ? inst.end : null;
      const startIso = start.toISOString();
      out.push({
        key: `${ev.uid}@${startIso}`,
        uid: ev.uid,
        summary: pv(inst.summary ?? src.summary ?? ev.summary).trim() || "(untitled)",
        description: pv(src.description ?? ev.description),
        location: pv(src.location ?? ev.location).trim() || null,
        start,
        end,
        allDay: Boolean(inst.isFullDay),
        tz: (start as Date & { tz?: string }).tz ?? null,
        status: src.status ? String(src.status).toUpperCase() : ev.status ? String(ev.status).toUpperCase() : null,
        attendees: attendeesOf(src.attendee ? src : ev),
        organizer: toAttendee(src.organizer ?? ev.organizer),
        url: typeof (src.url ?? ev.url) === "string" ? (src.url ?? ev.url)! : null,
        recurring: Boolean(inst.isRecurring),
        override: Boolean(inst.isOverride),
        sequence: typeof src.sequence === "number" ? src.sequence : typeof ev.sequence === "number" ? ev.sequence : null,
        lastModified: src.lastmodified instanceof Date ? src.lastmodified.toISOString() : ev.lastmodified instanceof Date ? ev.lastmodified.toISOString() : null,
      });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function eventHash(e: ExpandedEvent): string {
  return hashOf([
    e.summary,
    e.start.toISOString(),
    e.end?.toISOString() ?? null,
    e.allDay,
    e.location,
    excerpt(e.description, 2000),
    e.status,
    e.attendees.map((a) => `${a.email}:${a.status}`).sort(),
    e.url,
  ]);
}

function formatWhen(e: ExpandedEvent, locale: string, timeZone: string | undefined): string {
  const tz = timeZone || e.tz || undefined;
  try {
    if (e.allDay) {
      const f = new Intl.DateTimeFormat(locale, { timeZone: "UTC", dateStyle: "medium" });
      const s = f.format(e.start);
      const endDay = e.end ? new Date(e.end.getTime() - 1) : null;
      const en = endDay && endDay.toISOString().slice(0, 10) !== e.start.toISOString().slice(0, 10) ? ` – ${f.format(endDay)}` : "";
      return `${s}${en} (${t(locale, "ics.allDay")})`;
    }
    const f = new Intl.DateTimeFormat(locale, { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
    const ft = new Intl.DateTimeFormat(locale, { timeZone: tz, timeStyle: "short" });
    const sameDay = e.end && new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short" }).format(e.start) === new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short" }).format(e.end);
    return `${f.format(e.start)}${e.end ? ` – ${sameDay ? ft.format(e.end) : f.format(e.end)}` : ""}${tz ? ` ${tz}` : ""}`;
  } catch {
    return `${e.start.toISOString()}${e.end ? ` – ${e.end.toISOString()}` : ""}`;
  }
}

function buildBody(e: ExpandedEvent, locale: string, timeZone: string | undefined): string {
  const lines: string[] = [];
  lines.push(`${t(locale, "ics.label.when")}: ${formatWhen(e, locale, timeZone)}`);
  if (e.location) lines.push(`${t(locale, "ics.label.where")}: ${e.location}`);
  if (e.organizer?.email || e.organizer?.name) lines.push(`${t(locale, "ics.label.organizer")}: ${e.organizer.name ?? ""} ${e.organizer.email ? `<${e.organizer.email}>` : ""}`.trim());
  if (e.attendees.length) {
    lines.push(
      `${t(locale, "ics.label.attendees")}: ${e.attendees
        .slice(0, 10)
        .map((a) => `${a.name ?? a.email ?? "?"}${a.status ? ` (${a.status.toLowerCase()})` : ""}`)
        .join(", ")}${e.attendees.length > 10 ? ` +${e.attendees.length - 10}` : ""}`,
    );
  }
  if (e.status && e.status !== "CONFIRMED") lines.push(`${t(locale, "ics.label.status")}: ${e.status}`);
  const desc = excerpt(e.description, 1500);
  if (desc) lines.push("", desc);
  return truncate(lines.join("\n"), 4000);
}

function metadataOf(e: ExpandedEvent, changed: string, calendar: string): Record<string, unknown> {
  return {
    uid: e.uid,
    start: e.start.toISOString(),
    end: e.end?.toISOString() ?? null,
    allDay: e.allDay,
    tz: e.tz,
    location: e.location,
    attendees: e.attendees,
    organizer: e.organizer,
    description: excerpt(e.description, 1000),
    status: e.status,
    changed,
    recurring: e.recurring,
    override: e.override,
    sequence: e.sequence,
    last_modified: e.lastModified,
    calendar,
  };
}

export interface IcsSensorOptions {
  load?: CalendarLoader;
}

export function createIcsSensor(opts: IcsSensorOptions = {}): Sensor {
  const load = opts.load ?? defaultLoader;
  return {
    name: ICS_SOURCE,
    description: "ICS calendar feeds (Google secret iCal URL, Outlook, local .ics): upcoming event changes",

    configured(config): boolean {
      const urls = (config.urls as string[] | undefined) ?? [];
      return urls.filter((u) => typeof u === "string" && u.trim().length > 0).length > 0;
    },

    async poll(ctx: SensorContext): Promise<SensorPollResult> {
      const warnings = new Warnings();
      const signals: NewSignal[] = [];
      const urls = ((ctx.config.urls as string[] | undefined) ?? []).filter((u) => typeof u === "string" && u.trim());
      const horizonDays = Math.max(1, Number(ctx.config.horizon_days ?? 7));
      const locale = String(ctx.config.locale ?? "zh-CN");
      const timeZone = typeof ctx.config.timezone === "string" && ctx.config.timezone ? ctx.config.timezone : undefined;
      const now = ctx.now();
      const to = new Date(now.getTime() + horizonDays * 86_400_000);
      let totalInstances = 0;

      for (const url of urls) {
        const calId = sha1(url).slice(0, 12);
        const cursorKey = `snapshot:${calId}`;
        let data: CalendarResponse;
        try {
          data = await load(url, ctx);
        } catch (e) {
          const safe = isHttpUrl(url) ? url.replace(/(private-)[^/]+/, "$1***") : url;
          warnings.add(`calendar ${safe}: ${errorMessage(e)}`);
          ctx.logger.warn(`ics fetch failed`, { url: safe, error: errorMessage(e) });
          continue;
        }
        const calName = String((data.vcalendar as { "WR-CALNAME"?: string } | undefined)?.["WR-CALNAME"] ?? "") || calId;
        const events = expandCalendar(data, now, to);
        totalInstances += events.length;
        const prev = ctx.cursors.getJson<Snapshot>(cursorKey, {});
        const next: Snapshot = {};
        const seen = new Set<string>();

        for (const e of events) {
          if (seen.has(e.key)) continue;
          seen.add(e.key);
          const hash = eventHash(e);
          const entry: SnapshotEntry = { hash, uid: e.uid, start: e.start.toISOString(), end: e.end?.toISOString() ?? null, summary: e.summary, status: e.status };
          next[e.key] = entry;
          const old = prev[e.key];
          const cancelled = e.status === "CANCELLED";
          let changed: "new" | "updated" | "cancelled" | null = null;
          if (!old) changed = cancelled ? null : "new";
          else if (old.hash !== hash) changed = cancelled && old.status !== "CANCELLED" ? "cancelled" : cancelled ? null : "updated";
          if (!changed) continue;
          const title = changed === "new" ? e.summary : t(locale, changed === "cancelled" ? "ics.cancelled.title" : "ics.updated.title", { summary: e.summary });
          signals.push({
            source: ICS_SOURCE,
            external_id: e.key,
            kind: "calendar_event",
            title,
            body: buildBody(e, locale, timeZone),
            url: e.url,
            actor: e.organizer?.email ?? null,
            occurred_at: e.start.toISOString(),
            metadata: metadataOf(e, changed, calName),
          });
        }

        // instances that vanished while still in the future
        for (const [key, old] of Object.entries(prev)) {
          if (next[key]) continue;
          const start = new Date(old.start);
          if (Number.isNaN(start.getTime()) || start.getTime() <= now.getTime()) continue; // past: just forget it
          if (start.getTime() > to.getTime()) continue; // outside horizon now (horizon shrank): not a removal
          if (old.status === "CANCELLED") continue;
          signals.push({
            source: ICS_SOURCE,
            external_id: key,
            kind: "calendar_event_removed",
            title: t(locale, "ics.removed.title", { summary: old.summary }),
            body: `${t(locale, "ics.label.when")}: ${old.start}${old.end ? ` – ${old.end}` : ""}`,
            url: null,
            actor: null,
            occurred_at: old.start,
            metadata: { uid: old.uid, start: old.start, end: old.end, changed: "removed", calendar: calName, previous_status: old.status },
          });
        }
        ctx.cursors.setJson(cursorKey, next);
        ctx.logger.debug(`calendar ${calName}: ${events.length} instances in horizon`);
      }
      return { signals, warnings: warnings.list, summary: `${urls.length} calendar(s), ${totalInstances} upcoming instances, ${signals.length} changes` };
    },
  };
}

export const icsSensor = createIcsSensor();
