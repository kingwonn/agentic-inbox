import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { pretty } from "../format";
import { APPROVAL_STATUS, INBOX_KIND, INBOX_STATUS, LEVEL, PRIORITY, RISK, RUN_STATUS, TASK_STATUS, label } from "../labels";
import { href } from "../router";
import type { ApprovalStatus, InboxKind, InboxStatus, Level, Priority, Risk, RunStatus, TaskStatus } from "../types";

// ── Badges ─────────────────────────────────────────────────────────

export function Badge({ tone = "neutral", children, title, className = "" }: { tone?: string; children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={`badge badge-${tone} ${className}`} title={title}>
      {children}
    </span>
  );
}

const TASK_TONE: Record<TaskStatus, string> = {
  todo: "neutral",
  planning: "info",
  ready: "info",
  running: "accent",
  waiting_human: "warn",
  review: "warn",
  blocked: "neutral",
  done: "success",
  failed: "danger",
  cancelled: "muted",
};
const RUN_TONE: Record<RunStatus, string> = { queued: "neutral", running: "accent", waiting_human: "warn", succeeded: "success", failed: "danger", interrupted: "warn", cancelled: "muted" };
const INBOX_TONE: Record<InboxStatus, string> = { new: "accent", triaged: "info", promoted: "success", dismissed: "muted", snoozed: "warn", done: "success" };
const KIND_TONE: Record<InboxKind, string> = { todo: "info", problem: "danger", opportunity: "success", decision: "warn", info: "neutral" };
const APPROVAL_TONE: Record<ApprovalStatus, string> = { pending: "warn", approved: "success", rejected: "danger", edited: "success", expired: "muted", cancelled: "muted" };
const PRIORITY_TONE: Record<Priority, string> = { P0: "danger", P1: "warn", P2: "neutral", P3: "muted" };
const RISK_TONE: Record<Risk, string> = { low: "success", medium: "warn", high: "danger" };

export const TaskStatusBadge = ({ s }: { s: TaskStatus }) => (
  <Badge tone={TASK_TONE[s] ?? "neutral"} className={s === "running" ? "pulse" : ""}>
    {label(TASK_STATUS, s)}
  </Badge>
);
export const RunStatusBadge = ({ s }: { s: RunStatus }) => (
  <Badge tone={RUN_TONE[s] ?? "neutral"} className={s === "running" ? "pulse" : ""}>
    {label(RUN_STATUS, s)}
  </Badge>
);
export const InboxStatusBadge = ({ s }: { s: InboxStatus }) => <Badge tone={INBOX_TONE[s] ?? "neutral"}>{label(INBOX_STATUS, s)}</Badge>;
export const KindBadge = ({ k }: { k: InboxKind }) => <Badge tone={KIND_TONE[k] ?? "neutral"}>{label(INBOX_KIND, k)}</Badge>;
export const ApprovalStatusBadge = ({ s }: { s: ApprovalStatus }) => <Badge tone={APPROVAL_TONE[s] ?? "neutral"}>{label(APPROVAL_STATUS, s)}</Badge>;
export const PriorityBadge = ({ p }: { p: Priority }) => (
  <Badge tone={PRIORITY_TONE[p] ?? "neutral"} title={label(PRIORITY, p)}>
    {p}
  </Badge>
);
export const RiskBadge = ({ r }: { r: Risk }) => <Badge tone={RISK_TONE[r] ?? "neutral"}>{label(RISK, r)}</Badge>;

export function LevelBadge({ level, reason, proposed }: { level: Level; reason?: string; proposed?: Level }) {
  const l = LEVEL[level];
  const tip = [`${l.short} ${l.name}：${l.desc}`, proposed && proposed !== level ? `模型建议 L${proposed}` : "", reason ? `原因：${reason}` : ""].filter(Boolean).join("\n");
  return (
    <span className={`level level-${level}`} title={tip}>
      {l.short}
      {proposed && proposed !== level ? <span className="level-proposed">←L{proposed}</span> : null}
    </span>
  );
}

// ── Buttons ────────────────────────────────────────────────────────

export function Button({
  children,
  onClick,
  tone = "default",
  size = "md",
  disabled,
  type = "button",
  title,
  className = "",
  busy,
}: {
  children: ReactNode;
  onClick?: () => unknown;
  tone?: "default" | "primary" | "danger" | "ghost" | "success";
  size?: "sm" | "md";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  className?: string;
  busy?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const isBusy = busy || pending;
  return (
    <button
      type={type}
      title={title}
      className={`btn btn-${tone} btn-${size} ${className}`}
      disabled={disabled || isBusy}
      onClick={
        onClick
          ? async () => {
              const r = onClick();
              if (r && typeof (r as Promise<unknown>).then === "function") {
                setPending(true);
                try {
                  await r;
                } finally {
                  setPending(false);
                }
              }
            }
          : undefined
      }
    >
      {isBusy ? <span className="spinner" /> : null}
      {children}
    </button>
  );
}

// ── Layout helpers ────────────────────────────────────────────────

export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {sub ? <div className="page-sub">{sub}</div> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function Card({ title, children, actions, className = "", style }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <section className={`card ${className}`} style={style}>
      {title !== undefined ? (
        <header className="card-head">
          <h2>{title}</h2>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Empty({ children = "暂无数据", icon = "○" }: { children?: ReactNode; icon?: string }) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

export function Loading({ error, retry }: { error?: string | null; retry?: () => void }) {
  if (error)
    return (
      <div className="error-box">
        <span>加载失败：{error}</span>
        {retry ? (
          <Button size="sm" onClick={retry}>
            重试
          </Button>
        ) : null}
      </div>
    );
  return (
    <div className="loading">
      <span className="spinner" /> 加载中…
    </div>
  );
}

export function KV({ items, cols = 2 }: { items: Array<[ReactNode, ReactNode] | null | false | undefined>; cols?: number }) {
  return (
    <dl className={`kv kv-${cols}`}>
      {items
        .filter((x): x is [ReactNode, ReactNode] => Boolean(x))
        .map(([k, v], i) => (
          <div key={i} className="kv-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: Array<{ value: T; label: ReactNode; count?: number }> }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button key={it.value} role="tab" aria-selected={it.value === value} className={`tab ${it.value === value ? "active" : ""}`} onClick={() => onChange(it.value)}>
          {it.label}
          {it.count !== undefined ? <span className="tab-count">{it.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string>({ value, onChange, options, allLabel }: { value: T | ""; onChange: (v: T | "") => void; options: Array<{ value: T; label: string }>; allLabel?: string }) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value as T | "")}>
      {allLabel !== undefined ? <option value="">{allLabel}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Link({ to, children, className = "", title }: { to: string; children: ReactNode; className?: string; title?: string }) {
  return (
    <a href={href(to)} className={`link ${className}`} title={title}>
      {children}
    </a>
  );
}

// ── Overlays ──────────────────────────────────────────────────────

export function Drawer({ open, onClose, title, children, width = 560, footer }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer" style={{ width }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <header className="drawer-head">
          <div className="drawer-title">{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer ? <footer className="drawer-foot">{footer}</footer> : null}
      </aside>
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 520 }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay overlay-center" onClick={onClose}>
      <div className="modal" style={{ width }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        {title ? (
          <header className="modal-head">
            <div className="modal-title">{title}</div>
            <button className="icon-btn" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </header>
        ) : null}
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

// ── Data display ──────────────────────────────────────────────────

export function JsonView({ value, maxHeight = 320 }: { value: unknown; maxHeight?: number }) {
  return (
    <pre className="json" style={{ maxHeight }}>
      {pretty(value)}
    </pre>
  );
}

/** Tiny text renderer: paragraphs, bullet lists, inline code, and auto-linked URLs. */
export function TextBlock({ text, className = "" }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  const flushList = () => {
    if (list.length) {
      out.push(
        <ul key={`ul${out.length}`}>
          {list.map((l, i) => (
            <li key={i}>{inline(l)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  lines.forEach((raw, i) => {
    if (raw.trim().startsWith("```")) {
      if (code) {
        out.push(
          <pre key={`pre${i}`} className="json">
            {code.join("\n")}
          </pre>,
        );
        code = null;
      } else {
        flushList();
        code = [];
      }
      return;
    }
    if (code) {
      code.push(raw);
      return;
    }
    const m = /^\s*[-*•]\s+(.*)$/.exec(raw);
    if (m) {
      list.push(m[1]);
      return;
    }
    flushList();
    const h = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (h) {
      out.push(
        <div key={i} className={`tb-h tb-h${h[1].length}`}>
          {inline(h[2])}
        </div>,
      );
      return;
    }
    if (raw.trim() === "") return;
    out.push(<p key={i}>{inline(raw)}</p>);
  });
  flushList();
  return <div className={`textblock ${className}`}>{out}</div>;
}

function inline(s: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(https?:\/\/[^\s)]+)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    if (m[1])
      parts.push(
        <a key={k++} href={m[1]} target="_blank" rel="noreferrer">
          {m[1]}
        </a>,
      );
    else if (m[2]) parts.push(<code key={k++}>{m[2]}</code>);
    else if (m[3]) parts.push(<strong key={k++}>{m[3]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

export function Meter({ ratio, warn, danger }: { ratio: number; warn?: boolean; danger?: boolean }) {
  const w = Math.min(100, Math.max(0, ratio * 100));
  return (
    <div className={`meter ${danger ? "meter-danger" : warn ? "meter-warn" : ""}`}>
      <div className="meter-fill" style={{ width: `${w}%` }} />
    </div>
  );
}

export function Dot({ tone = "neutral", pulse = false }: { tone?: string; pulse?: boolean }) {
  return <span className={`dot dot-${tone} ${pulse ? "pulse" : ""}`} />;
}
