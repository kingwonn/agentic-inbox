/** Tiny hash router: #/tasks/tsk_123?tab=runs */
import { useEffect, useState } from "react";

export interface Route {
  path: string; // "/tasks/tsk_123"
  parts: string[]; // ["tasks", "tsk_123"]
  query: URLSearchParams;
}

export function parseHash(hash = window.location.hash): Route {
  let h = hash.replace(/^#/, "");
  if (!h.startsWith("/")) h = "/" + h;
  const [p, q = ""] = h.split("?");
  const path = p.replace(/\/+$/, "") || "/";
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  return { path, parts, query: new URLSearchParams(q) };
}

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const target = path.startsWith("#") ? path : `#${path.startsWith("/") ? path : "/" + path}`;
  if (opts.replace) window.history.replaceState(null, "", target);
  else window.location.hash = target;
  if (opts.replace) window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash());
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const href = (path: string) => `#${path.startsWith("/") ? path : "/" + path}`;
