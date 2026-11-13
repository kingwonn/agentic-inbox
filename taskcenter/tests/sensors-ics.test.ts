import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";
import type { LoadedConfig } from "../src/config/load.js";
import { openDb } from "../src/core/db.js";
import { silentLogger } from "../src/core/logger.js";
import { Repo } from "../src/core/repo.js";
import { createIcsSensor, expandCalendar, icsSensor } from "../src/sensors/ics.js";
import { makeSensorContext, type SensorEntry } from "../src/sensors/registry.js";
import ical from "node-ical";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = resolve(ROOT, "tests/fixtures/calendar.ics");
const NOW = new Date("2026-11-09T08:00:00Z");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function harness() {
  const repo = new Repo(openDb(":memory:"));
  const loaded: LoadedConfig = { config: ConfigSchema.parse({}), configPath: null, rootDir: ROOT, resolve: (p) => (p.startsWith("/") ? p : resolve(ROOT, p)) };
  return { repo, loaded };
}

function entryFor(urls: string[], locale = "en"): SensorEntry {
  return { sensor: icsSensor, config: { enabled: true, urls, horizon_days: 7, locale, timezone: "UTC" }, enabled: true };
}

describe("sensors/ics", () => {
  it("expands RRULE with EXDATE inside the horizon", () => {
    const data = ical.sync.parseFile(FIXTURE);
    const events = expandCalendar(data, NOW, new Date(NOW.getTime() + 7 * 86_400_000));
    const keys = events.map((e) => e.key);
    expect(keys).toContain("standup-uid@2026-11-09T09:00:00.000Z");
    expect(keys).toContain("standup-uid@2026-11-13T09:00:00.000Z");
    expect(keys).not.toContain("standup-uid@2026-11-11T09:00:00.000Z"); // EXDATE
    expect(keys).toContain("dentist-uid@2026-11-10T14:00:00.000Z");
    expect(keys.some((k) => k.startsWith("allday-uid@2026-11-12"))).toBe(true);
    expect(keys.some((k) => k.startsWith("past-uid"))).toBe(false);
    expect(keys.some((k) => k.startsWith("far-uid"))).toBe(false);
    const standup = events.find((e) => e.key.startsWith("standup-uid@2026-11-09"))!;
    expect(standup.recurring).toBe(true);
    expect(standup.attendees).toEqual([{ email: "bob@example.com", name: "Bob", status: "ACCEPTED", role: "REQ-PARTICIPANT" }]);
    expect(standup.organizer?.email).toBe("alice@example.com");
    const allday = events.find((e) => e.key.startsWith("allday-uid"))!;
    expect(allday.allDay).toBe(true);
  });

  it("emits new/updated/cancelled/removed signals via snapshot diff", async () => {
    const h = harness();
    const dir = mkdtempSync(join(tmpdir(), "tc-ics-"));
    dirs.push(dir);
    const file = join(dir, "cal.ics");
    writeFileSync(file, readFileSync(FIXTURE, "utf8"));
    const entry = entryFor([file]);
    const ctx = () => makeSensorContext(entry, { repo: h.repo, logger: silentLogger, loaded: h.loaded, now: () => NOW });

    const r1 = await icsSensor.poll(ctx());
    expect(r1.warnings ?? []).toEqual([]);
    const ids1 = r1.signals.map((s) => s.external_id).sort();
    expect(ids1).toEqual(
      ["allday-uid@2026-11-12T00:00:00.000Z", "dentist-uid@2026-11-10T14:00:00.000Z", "standup-uid@2026-11-09T09:00:00.000Z", "standup-uid@2026-11-13T09:00:00.000Z"].sort(),
    );
    expect(r1.signals.every((s) => s.kind === "calendar_event" && s.metadata?.changed === "new")).toBe(true);
    const dentist = r1.signals.find((s) => s.external_id.startsWith("dentist"))!;
    expect(dentist.title).toBe("Dentist");
    expect(dentist.url).toBe("https://example.com/dentist");
    expect(dentist.metadata).toMatchObject({ location: "Clinic A", status: "CONFIRMED", allDay: false, calendar: "Test Calendar", start: "2026-11-10T14:00:00.000Z", end: "2026-11-10T15:00:00.000Z" });
    expect(dentist.body).toContain("Where: Clinic A");
    expect(dentist.occurred_at).toBe("2026-11-10T14:00:00.000Z");
    for (const s of r1.signals) h.repo.signals.upsert(s);

    // unchanged feed -> nothing
    const r2 = await icsSensor.poll(ctx());
    expect(r2.signals).toEqual([]);

    // change location, drop the all-day event, cancel the Nov 13 standup via RECURRENCE-ID override
    let ics = readFileSync(FIXTURE, "utf8").replace("LOCATION:Clinic A", "LOCATION:Clinic B");
    ics = ics.replace(/BEGIN:VEVENT\nUID:allday-uid[\s\S]*?END:VEVENT\n/, "");
    ics = ics.replace(
      "END:VCALENDAR",
      "BEGIN:VEVENT\nUID:standup-uid\nRECURRENCE-ID:20261113T090000Z\nDTSTAMP:20261108T000000Z\nDTSTART:20261113T090000Z\nDTEND:20261113T091500Z\nSUMMARY:Team standup\nSTATUS:CANCELLED\nEND:VEVENT\nEND:VCALENDAR",
    );
    writeFileSync(file, ics);
    const r3 = await icsSensor.poll(ctx());
    const byId = Object.fromEntries(r3.signals.map((s) => [s.external_id, s]));
    expect(Object.keys(byId).sort()).toEqual(["allday-uid@2026-11-12T00:00:00.000Z", "dentist-uid@2026-11-10T14:00:00.000Z", "standup-uid@2026-11-13T09:00:00.000Z"]);
    expect(byId["dentist-uid@2026-11-10T14:00:00.000Z"]).toMatchObject({ kind: "calendar_event", title: "Event changed: Dentist" });
    expect(byId["dentist-uid@2026-11-10T14:00:00.000Z"].metadata).toMatchObject({ changed: "updated", location: "Clinic B" });
    expect(byId["allday-uid@2026-11-12T00:00:00.000Z"]).toMatchObject({ kind: "calendar_event_removed", title: "Event removed: Offsite day" });
    expect(byId["standup-uid@2026-11-13T09:00:00.000Z"].metadata?.changed).toBe("cancelled");
    expect(byId["standup-uid@2026-11-13T09:00:00.000Z"].title).toBe("Event cancelled: Team standup");
    // the removed signal updates the existing row (same external_id, kind changes)
    const up = h.repo.signals.upsert(byId["allday-uid@2026-11-12T00:00:00.000Z"]);
    expect(up.isNew).toBe(false);
    expect(up.changed).toBe(true);
    expect(up.signal.kind).toBe("calendar_event_removed");

    // stable afterwards
    const r4 = await icsSensor.poll(ctx());
    expect(r4.signals).toEqual([]);
  });

  it("reports fetch problems as warnings, never throws", async () => {
    const h = harness();
    const entry = entryFor(["/nonexistent/calendar.ics"]);
    const r = await icsSensor.poll(makeSensorContext(entry, { repo: h.repo, logger: silentLogger, loaded: h.loaded, now: () => NOW }));
    expect(r.signals).toEqual([]);
    expect(r.warnings?.length).toBe(1);
    const failing = createIcsSensor({
      load: async () => {
        throw new Error("503 Service Unavailable");
      },
    });
    const r2 = await failing.poll(makeSensorContext({ ...entry, sensor: failing, config: { ...entry.config, urls: ["https://calendar.google.com/calendar/ical/x/private-abc/basic.ics"] } }, { repo: h.repo, logger: silentLogger, loaded: h.loaded }));
    expect(r2.warnings?.[0]).toContain("private-***");
    expect(r2.warnings?.[0]).toContain("503");
  });

  it("configured() requires at least one non-empty url", () => {
    expect(icsSensor.configured({ urls: [] })).toBe(false);
    expect(icsSensor.configured({ urls: ["", "https://x/y.ics"] })).toBe(true);
  });
});
