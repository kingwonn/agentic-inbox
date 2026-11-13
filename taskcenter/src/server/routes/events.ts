import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppContext } from "../../core/app.js";
import type { BusEvents } from "../../core/events.js";
import { EVENT_LEVELS, EVENT_TYPES } from "../../core/types.js";
import { intParam, listParam, oneOf, pageOf, strParam } from "../util.js";

export const SSE_HEARTBEAT_MS = 20_000;

/** Bus events forwarded to SSE clients as named events (in addition to `event`). */
const NAMED: Array<keyof BusEvents> = ["task.changed", "run.changed", "approval.requested", "approval.decided", "inbox.changed", "signal.new"];

export interface SseRegistry {
  /** Close every open stream (used by stop()). */
  closeAll(): void;
  size(): number;
}

export function eventsRoutes(ctx: AppContext, opts: { heartbeatMs?: number } = {}): { app: Hono; sse: SseRegistry } {
  const app = new Hono();
  const { repo, bus } = ctx;
  const heartbeatMs = opts.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const open = new Set<() => void>();

  app.get("/events", (c) => {
    const type = oneOf(listParam(c, "type"), EVENT_TYPES, "type");
    const level = oneOf(listParam(c, "level"), EVENT_LEVELS, "level")?.[0];
    const limit = intParam(c, "limit", 200, 2000, 1);
    const offset = intParam(c, "offset", 0);
    const items = repo.events.list({
      task_id: strParam(c, "task_id"),
      run_id: strParam(c, "run_id"),
      type,
      level,
      since: strParam(c, "since"),
      after_id: strParam(c, "after_id"),
      limit,
      offset,
    });
    return c.json(pageOf(items, limit, offset));
  });

  app.get("/events/stream", (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false;
      let wake: (() => void) | undefined;
      const listeners: Array<[keyof BusEvents, (...args: never[]) => void]> = [];

      const close = () => {
        if (closed) return;
        closed = true;
        for (const [name, fn] of listeners) bus.off(name, fn as never);
        open.delete(close);
        wake?.();
      };
      const send = (event: string, data: unknown, id?: string) => {
        if (closed) return;
        stream.writeSSE({ event, data: JSON.stringify(data), id }).catch(close);
      };

      const onEvent = (ev: BusEvents["event"][0]) => send("event", ev, ev.id);
      bus.on("event", onEvent);
      listeners.push(["event", onEvent]);
      for (const name of NAMED) {
        const fn = (payload: unknown) => send(name, payload);
        bus.on(name, fn as never);
        listeners.push([name, fn]);
      }
      open.add(close);
      stream.onAbort(close);
      c.req.raw.signal?.addEventListener("abort", close);

      await stream.writeSSE({ event: "hello", data: JSON.stringify({ startedAt: ctx.startedAt, now: new Date().toISOString(), heartbeatMs }), retry: 3000 });
      while (!closed) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, heartbeatMs);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        if (closed) break;
        try {
          await stream.writeSSE({ event: "heartbeat", data: new Date().toISOString() });
        } catch {
          close();
        }
      }
    });
  });

  return {
    app,
    sse: {
      closeAll: () => {
        for (const close of [...open]) close();
      },
      size: () => open.size,
    },
  };
}
