import { afterEach, describe, expect, it } from "vitest";
import { createPatrol, failureKey } from "../src/engine/patrol.js";
import { makeCtx, sig, stubSensor, type TestCtx } from "./engine-helpers.js";

describe("engine/patrol", () => {
  let t: TestCtx;
  afterEach(async () => t?.cleanup());

  it("upserts new/changed signals, dedupes unchanged ones and wakes triage", async () => {
    t = await makeCtx();
    const s = stubSensor("alpha", [
      [sig("1", "one", "a"), sig("2", "two", "b")],
      [sig("1", "one", "a"), sig("2", "two", "changed")],
    ]);
    const patrol = createPatrol(t.ctx, [s]);
    const wakes: string[] = [];
    t.ctx.bus.on("wake", ({ reason }) => wakes.push(reason));
    const r1 = await patrol.runOnce();
    expect(r1.totalNew).toBe(2);
    expect(r1.totalChanged).toBe(0);
    expect(r1.sensors[0].ok).toBe(true);
    const r2 = await patrol.runOnce();
    expect(r2.totalNew).toBe(0);
    expect(r2.totalChanged).toBe(1);
    expect(t.ctx.repo.signals.count()).toBe(2);
    expect(t.ctx.repo.events.list({ type: "sensor_poll" }).length).toBe(2);
    expect(wakes).toContain("patrol");
    expect(t.ctx.repo.meta.get(failureKey("alpha"))).toBe("0");
  });

  it("isolates a failing sensor and counts consecutive failures", async () => {
    t = await makeCtx();
    const bad = stubSensor("bad", [new Error("boom")]);
    const good = stubSensor("good", [[sig("x", "fine")]]);
    const patrol = createPatrol(t.ctx, [bad, good]);
    const r = await patrol.runOnce();
    const badRep = r.sensors.find((x) => x.name === "bad")!;
    const goodRep = r.sensors.find((x) => x.name === "good")!;
    expect(badRep.ok).toBe(false);
    expect(badRep.error).toContain("boom");
    expect(goodRep.ok).toBe(true);
    expect(goodRep.newSignals).toBe(1);
    await patrol.runOnce();
    expect(t.ctx.repo.meta.get(failureKey("bad"))).toBe("2");
    expect(t.ctx.repo.events.list({ type: "error" }).length).toBe(2);
    expect(patrol.sensors().find((x) => x.name === "bad")?.failures).toBe(2);
  });

  it("skips disabled/unconfigured sensors and honours an explicit name list", async () => {
    t = await makeCtx();
    const off = stubSensor("off", [[sig("1", "x")]]);
    off.enabled = false;
    const unconf = stubSensor("unconf", [[sig("1", "x")]], { configured: false });
    const on = stubSensor("on", [[sig("1", "x")]]);
    const patrol = createPatrol(t.ctx, [off, unconf, on]);
    const r = await patrol.runOnce();
    expect(r.sensors.map((s) => s.name).sort()).toEqual(["on", "unconf"]);
    expect(r.sensors.find((s) => s.name === "unconf")?.summary).toContain("not configured");
    const r2 = await patrol.runOnce(["off"]);
    expect(r2.sensors.map((s) => s.name)).toEqual(["off"]);
    expect(off.polls).toBe(1);
  });

  it("times out a hanging sensor", async () => {
    t = await makeCtx();
    const hang: ReturnType<typeof stubSensor> = { ...stubSensor("hang", [[]]), polls: 0 };
    hang.sensor = { ...hang.sensor, poll: () => new Promise(() => {}) };
    const patrol = createPatrol(t.ctx, [hang], { timeoutMs: 50 });
    const r = await patrol.runOnce();
    expect(r.sensors[0].ok).toBe(false);
    expect(r.sensors[0].error).toMatch(/timed out/);
  });
});
