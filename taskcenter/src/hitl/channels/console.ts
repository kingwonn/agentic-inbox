/**
 * Console channel: prints a boxed message to stderr and appends to data/logs/notifications.log.
 * Always present so every notification is visible somewhere.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Channel, NotifyMessage } from "../types.js";

export interface ConsoleChannelOptions {
  /** Absolute data dir; the log goes to <dataDir>/logs/notifications.log. */
  dataDir?: string;
  /** Print to stderr (default true). The file log is always written when dataDir is set. */
  stderr?: boolean;
  width?: number;
}

function wrap(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut < width * 0.5) cut = width;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

export function boxMessage(msg: NotifyMessage, width = 76): string {
  const inner = width - 4;
  const lines = [`${msg.title}`, "".padEnd(inner, "─"), ...msg.body.split("\n")].flatMap((l) => wrap(l, inner));
  if (msg.url) lines.push("", msg.url);
  const top = `┌${"".padEnd(width - 2, "─")}┐`;
  const bottom = `└${"".padEnd(width - 2, "─")}┘`;
  const body = lines.map((l) => `│ ${l.padEnd(inner)} │`);
  return [top, ...body, bottom].join("\n");
}

export class ConsoleChannel implements Channel {
  readonly name = "console";
  private readonly logPath?: string;
  private readonly toStderr: boolean;
  private readonly width: number;

  constructor(opts: ConsoleChannelOptions = {}) {
    this.logPath = opts.dataDir ? join(opts.dataDir, "logs", "notifications.log") : undefined;
    this.toStderr = opts.stderr ?? true;
    this.width = opts.width ?? 76;
  }

  configured(): boolean {
    return true;
  }

  async send(msg: NotifyMessage): Promise<{ ok: boolean; externalRef?: string; error?: string }> {
    const box = boxMessage(msg, this.width);
    if (this.toStderr) process.stderr.write(`\n${box}\n`);
    if (this.logPath) {
      try {
        mkdirSync(dirname(this.logPath), { recursive: true });
        const rec = { ts: new Date().toISOString(), kind: msg.kind, priority: msg.priority ?? "normal", title: msg.title, approval_id: msg.approval?.id ?? null, task_id: msg.task?.id ?? null, body: msg.body, url: msg.url ?? null };
        appendFileSync(this.logPath, JSON.stringify(rec) + "\n");
      } catch (e) {
        return { ok: true, error: `log append failed: ${(e as Error).message}` };
      }
    }
    return { ok: true };
  }
}
