/** Thin fetch wrapper for /api with bearer token from localStorage ("tc_token"). */
import { useCallback, useEffect, useRef, useState } from "react";

export const TOKEN_KEY = "tc_token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(t: string): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const API_BASE = "/api";

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...((init.headers as Record<string, string>) ?? {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body && typeof init.body === "string" && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(API_BASE + path, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
  }
  if (!res.ok) {
    const err = (body as { error?: string; details?: unknown }) ?? {};
    throw new ApiError(res.status, err.error ?? `HTTP ${res.status}`, err.details);
  }
  return body as T;
}

export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T,>(path: string, body?: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) });
export const del = <T,>(path: string) => api<T>(path, { method: "DELETE" });

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (v: T | undefined | ((prev: T | undefined) => T | undefined)) => void;
}

/** Fetch on mount and whenever `deps` change; `reload()` refetches in the background. */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    let alive = true;
    setLoading(true);
    fnRef
      .current()
      .then((d) => {
        if (!alive || id !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => {
        if (!alive || id !== seq.current) return;
        setError(e.message);
      })
      .finally(() => {
        if (alive && id === seq.current) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

/** Download URL for an artifact (adds the token as a query parameter when set). */
export function artifactDownloadUrl(id: string): string {
  const token = getToken();
  return `${API_BASE}/artifacts/${encodeURIComponent(id)}?download=1${token ? `&token=${encodeURIComponent(token)}` : ""}`;
}
