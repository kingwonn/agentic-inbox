import { describe, expect, it } from "vitest";
import { flagBool, flagNum, flagStr, parseArgs } from "../src/cli/args.js";
import { clip, displayWidth, formatTable } from "../src/cli/format.js";
import { makeT } from "../src/cli/i18n.js";
import { parseUntil } from "../src/engine/util.js";

describe("cli/args", () => {
  it("parses positionals, --k v, --k=v, booleans and --no-k", () => {
    const a = parseArgs(["tasks", "create", "Fix the build", "--level", "3", "--priority=P1", "--json", "--description", "multi word", "--no-serve", "--limit", "20"]);
    expect(a._).toEqual(["tasks", "create", "Fix the build"]);
    expect(a.flags).toEqual({ level: "3", priority: "P1", json: true, description: "multi word", serve: false, limit: "20" });
    expect(flagNum(a, "level")).toBe(3);
    expect(flagStr(a, "priority")).toBe("P1");
    expect(flagBool(a, "json")).toBe(true);
    expect(flagBool(a, "dry")).toBe(false);
  });

  it("treats known boolean flags as flags even when followed by a positional", () => {
    const a = parseArgs(["patrol", "--once", "--sensor", "github", "--dry"]);
    expect(a._).toEqual(["patrol"]);
    expect(a.flags).toEqual({ once: true, sensor: "github", dry: true });
    const b = parseArgs(["approvals", "approve", "apr_1", "--json", "looks good"]);
    expect(b._).toEqual(["approvals", "approve", "apr_1", "looks good"]);
    const c = parseArgs(["inbox", "snooze", "inb_1", "3d", "-h"]);
    expect(c.flags.help).toBe(true);
    const d = parseArgs(["events", "--task", "tsk_1", "--", "--literal"]);
    expect(d._).toEqual(["events", "--literal"]);
    expect(d.flags.task).toBe("tsk_1");
    const e = parseArgs(["status", "--config"]);
    expect(e.flags.config).toBe(true);
  });

  it("parses snooze durations", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    expect(parseUntil("1d", base)).toBe("2026-01-02T00:00:00.000Z");
    expect(parseUntil("2h", base)).toBe("2026-01-01T02:00:00.000Z");
    expect(parseUntil("1w", base)).toBe("2026-01-08T00:00:00.000Z");
    expect(parseUntil("2026-03-01T10:00:00Z", base)).toBe("2026-03-01T10:00:00.000Z");
    expect(parseUntil("soon", base)).toBeUndefined();
  });
});

describe("cli/format + i18n", () => {
  it("formats tables with CJK-aware widths", () => {
    expect(displayWidth("任务")).toBe(4);
    expect(displayWidth("abc")).toBe(3);
    expect(clip("一二三四五", 5)).toBe("一二…");
    const table = formatTable(
      [
        { id: "a", title: "标题一", n: 1 },
        { id: "bb", title: "x", n: 10 },
      ],
      [
        { key: "id", label: "ID" },
        { key: "title", label: "标题" },
        { key: "n", label: "N", align: "right" },
      ],
    );
    const lines = table.split("\n");
    expect(lines[0]).toBe("ID  标题     N");
    expect(lines[2]).toBe("a   标题一   1");
    expect(lines[3]).toBe("bb  x       10");
    expect(formatTable([], [{ key: "id", label: "ID" }], { empty: "nothing" })).toBe("nothing");
  });

  it("switches headers by locale", () => {
    expect(makeT("zh-CN")("title")).toBe("标题");
    expect(makeT("en")("title")).toBe("Title");
    expect(makeT(undefined)("status")).toBe("Status");
  });
});
