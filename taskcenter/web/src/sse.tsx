/**
 * Live updates over SSE (/api/events/stream). One EventSource for the whole app;
 * views subscribe with `useLive(kinds, cb)` and get a debounced callback.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { API_BASE, getToken } from "./api";
import type { Event } from "./types";

export type LiveKind = "event" | "task.changed" | "run.changed" | "approval.requested" | "approval.decided" | "inbox.changed" | "signal.new";

export interface LiveMessage {
  kind: LiveKind;
  data: unknown;
}

interface LiveApi {
  connected: boolean;
  lastEventAt: number | null;
  subscribe: (fn: (m: LiveMessage) => void) => () => void;
}

const Ctx = createContext<LiveApi>({ connected: false, lastEventAt: null, subscribe: () => () => {} });
const KINDS: LiveKind[] = ["event", "task.changed", "run.changed", "approval.requested", "approval.decided", "inbox.changed", "signal.new"];

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const subs = useRef(new Set<(m: LiveMessage) => void>());

  useEffect(() => {
    let es: EventSource | null = null;
    let retry = 1000;
    let timer: number | undefined;
    let stopped = false;
    const open = () => {
      if (stopped) return;
      const token = getToken();
      es = new EventSource(`${API_BASE}/events/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`);
      es.onopen = () => {
        setConnected(true);
        retry = 1000;
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        es = null;
        timer = window.setTimeout(open, retry);
        retry = Math.min(retry * 2, 15_000);
      };
      for (const kind of KINDS) {
        es.addEventListener(kind, (ev) => {
          let data: unknown = null;
          try {
            data = JSON.parse((ev as MessageEvent).data);
          } catch {
            data = (ev as MessageEvent).data;
          }
          setLastEventAt(Date.now());
          for (const fn of subs.current) {
            try {
              fn({ kind, data });
            } catch {
              /* subscriber errors must not kill the stream */
            }
          }
        });
      }
      es.addEventListener("heartbeat", () => setConnected(true));
    };
    open();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      es?.close();
    };
  }, []);

  const api = useMemo<LiveApi>(
    () => ({
      connected,
      lastEventAt,
      subscribe: (fn) => {
        subs.current.add(fn);
        return () => {
          subs.current.delete(fn);
        };
      },
    }),
    [connected, lastEventAt],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useLiveStatus(): { connected: boolean; lastEventAt: number | null } {
  const { connected, lastEventAt } = useContext(Ctx);
  return { connected, lastEventAt };
}

/** Call `cb` (debounced) whenever a live message of one of `kinds` arrives. */
export function useLive(kinds: LiveKind[] | "all", cb: (m: LiveMessage) => void, debounceMs = 400): void {
  const { subscribe } = useContext(Ctx);
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const key = kinds === "all" ? "all" : kinds.join(",");
  useEffect(() => {
    let timer: number | undefined;
    let last: LiveMessage | null = null;
    const un = subscribe((m) => {
      if (kinds !== "all" && !kinds.includes(m.kind)) return;
      last = m;
      if (debounceMs <= 0) {
        cbRef.current(m);
        return;
      }
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        if (last) cbRef.current(last);
      }, debounceMs);
    });
    return () => {
      un();
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, debounceMs, subscribe]);
}

/** Subscribe to raw persisted events (type `event`), un-debounced, e.g. for the live log. */
export function useLiveEvents(cb: (e: Event) => void): void {
  useLive(["event"], (m) => cb(m.data as Event), 0);
}
