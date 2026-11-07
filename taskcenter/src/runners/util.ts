/**
 * Small helpers shared by runners: an async queue that bridges callbacks
 * (hooks, child-process events) into an AsyncIterable, output truncation and
 * env preparation.
 */
import { cleanClaudeEnv } from "../brain/providers/util.js";

export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as unknown as T, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as unknown as T, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export const TOOL_OUTPUT_MAX = 4000;

export function truncateOutput(v: unknown, max = TOOL_OUTPUT_MAX): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + `…[+${v.length - max} chars]` : v;
  try {
    const s = JSON.stringify(v);
    if (s.length <= max) return v;
    return s.slice(0, max) + `…[+${s.length - max} chars]`;
  } catch {
    return String(v).slice(0, max);
  }
}

/** Environment for agent subprocesses (SDK and CLI runners). */
export function agentEnv(extra: Record<string, string> = {}): Record<string, string> {
  return cleanClaudeEnv({
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "2",
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
    DISABLE_TELEMETRY: "1",
    ...extra,
  });
}

/** Tools the gate never sees: the SDK's own plumbing and harmless bookkeeping. */
export const UNGATED_TOOLS = new Set(["StructuredOutput", "TodoWrite", "ToolSearch", "BashOutput", "KillShell", "ListMcpResourcesTool", "ReadMcpResourceTool"]);

/**
 * Error text of a resume whose session does not exist on this machine. Verified outputs:
 * - claude CLI / Agent SDK 2.1.x: result `error_during_execution` with
 *   `errors: ["No conversation found with session ID: <id>"]` (same line on stderr, exit 1);
 * - codex exec 0.167: stderr `thread/resume failed: no rollout found for thread id <id>` (exit 1).
 */
const SESSION_NOT_FOUND_RE = /no conversation found with session id|no rollout found for (?:thread|session|conversation) id/i;

export function isSessionNotFoundError(...texts: Array<string | undefined | null>): boolean {
  return texts.some((t) => !!t && SESSION_NOT_FOUND_RE.test(t));
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : JSON.stringify(e);
}
