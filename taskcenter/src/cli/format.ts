/** Compact table / value formatting for the CLI (CJK-aware column widths). */

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x200b || cp < 0x20) continue;
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
        ? 2
        : 1;
  }
  return w;
}

export function pad(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

export function clip(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

export interface Column {
  key: string;
  label: string;
  max?: number;
  align?: "left" | "right";
  format?: (v: unknown, row: Record<string, unknown>) => string;
}

export function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(v < 1 ? 4 : 2);
  if (Array.isArray(v)) return v.map((x) => cell(x)).join(",");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).replace(/\s+/g, " ");
}

export function formatTable(rows: Record<string, unknown>[], columns: Column[], opts: { empty?: string } = {}): string {
  if (!rows.length) return opts.empty ?? "(none)";
  const cells = rows.map((r) => columns.map((c) => clip((c.format ? c.format(r[c.key], r) : cell(r[c.key])) ?? "", c.max ?? 60)));
  const widths = columns.map((c, i) => Math.max(displayWidth(c.label), ...cells.map((row) => displayWidth(row[i]))));
  const line = (parts: string[]) => parts.map((p, i) => (columns[i].align === "right" ? " ".repeat(Math.max(0, widths[i] - displayWidth(p))) + p : pad(p, widths[i]))).join("  ").trimEnd();
  const out = [line(columns.map((c) => c.label)), line(widths.map((w) => "-".repeat(w)))];
  for (const row of cells) out.push(line(row));
  return out.join("\n");
}

export function formatKv(obj: Record<string, unknown>, opts: { indent?: number } = {}): string {
  const ind = " ".repeat(opts.indent ?? 0);
  const keys = Object.keys(obj);
  const w = Math.max(0, ...keys.map((k) => displayWidth(k)));
  return keys
    .map((k) => {
      const v = obj[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const inner = formatKv(v as Record<string, unknown>, { indent: (opts.indent ?? 0) + 2 });
        return `${ind}${k}:\n${inner}`;
      }
      return `${ind}${pad(k, w)}  ${cell(v)}`;
    })
    .join("\n");
}

export function shortTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(" ", " ");
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
