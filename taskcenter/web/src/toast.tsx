import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  text: string;
}

interface ToastApi {
  push: (kind: Toast["kind"], text: string) => void;
  success: (text: string) => void;
  error: (text: string) => void;
  info: (text: string) => void;
  /** Run an action with optimistic feedback: shows `pending`, then success/error. */
  run: <T>(fn: () => Promise<T>, msgs: { ok?: string; fail?: string }) => Promise<T | undefined>;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++seq.current;
    setItems((xs) => [...xs, { id, kind, text }]);
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3000);
  }, []);
  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (t) => push("success", t),
      error: (t) => push("error", t),
      info: (t) => push("info", t),
      run: async (fn, msgs) => {
        try {
          const r = await fn();
          if (msgs.ok) push("success", msgs.ok);
          return r;
        } catch (e) {
          push("error", `${msgs.fail ?? "操作失败"}：${(e as Error).message}`);
          return undefined;
        }
      },
    }),
    [push],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("ToastProvider missing");
  return v;
}
