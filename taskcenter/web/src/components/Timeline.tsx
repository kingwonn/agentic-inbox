import { useState, type ReactNode } from "react";
import { durationMs, fmtDate, fmtTime, pretty, shortId } from "../format";
import { EVENT_TYPE, TASK_STATUS, RUN_STATUS, label } from "../labels";
import type { Event, EventType } from "../types";
import { Empty, Link } from "./ui";

const ICON: Record<EventType, string> = {
  tool_call: "⚙",
  tool_result: "↩",
  assistant_message: "💬",
  status_change: "→",
  approval_requested: "✋",
  approval_decided: "✔",
  notification: "🔔",
  error: "✖",
  cost: "$",
  sensor_poll: "📡",
  triage: "🧭",
  plan: "🗺",
  run_started: "▶",
  run_finished: "■",
  artifact: "📎",
  memory: "🧠",
  system: "·",
};

function toolSummary(ev: Event): ReactNode {
  const p = ev.payload as { tool?: string; input?: Record<string, unknown>; ok?: boolean; duration_ms?: number; output?: unknown };
  const tool = p.tool ?? ev.message;
  if (ev.type === "tool_call") {
    const input = p.input ?? {};
    const brief = typeof input.command === "string" ? input.command : typeof input.file_path === "string" ? input.file_path : typeof input.url === "string" ? input.url : typeof input.pattern === "string" ? input.pattern : "";
    return (
      <>
        <span className="tool-chip">{tool}</span>
        {brief ? <span className="tool-cmd truncate">{brief}</span> : null}
      </>
    );
  }
  return (
    <>
      <span className="tool-chip">{tool}</span>
      <span className={p.ok === false ? "danger-text" : "success-text"}>{p.ok === false ? "失败" : "完成"}</span>
      {typeof p.duration_ms === "number" ? <span className="muted small">{durationMs(p.duration_ms)}</span> : null}
    </>
  );
}

/**
 * Stable chronological order. Events written within the same millisecond share a
 * `ts`; the repo tiebreaks on the (random-tailed) id, so we fall back to the
 * writer's `payload.seq` when present and keep the incoming order otherwise.
 */
export function sortChrono(events: Event[]): Event[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.ts !== b.e.ts) return a.e.ts < b.e.ts ? -1 : 1;
      const sa = typeof a.e.payload?.seq === "number" ? (a.e.payload.seq as number) : null;
      const sb = typeof b.e.payload?.seq === "number" ? (b.e.payload.seq as number) : null;
      if (sa !== null && sb !== null && sa !== sb) return sa - sb;
      return a.i - b.i;
    })
    .map((x) => x.e);
}

export function Timeline({ events, showTask = false, emptyText = "暂无事件", dense = false }: { events: Event[]; showTask?: boolean; emptyText?: string; dense?: boolean }) {
  if (!events.length) return <Empty>{emptyText}</Empty>;
  const sorted = sortChrono(events);
  let lastDay = "";
  const rows: ReactNode[] = [];
  for (const ev of sorted) {
    const day = ev.ts.slice(0, 10);
    if (day !== lastDay) {
      lastDay = day;
      rows.push(
        <div key={`day-${day}`} className="tl-day">
          {fmtDate(ev.ts).slice(0, 5)}
        </div>,
      );
    }
    rows.push(<TimelineItem key={ev.id} ev={ev} showTask={showTask} />);
  }
  return <div className={`timeline ${dense ? "dense" : ""}`}>{rows}</div>;
}

function TimelineItem({ ev, showTask }: { ev: Event; showTask: boolean }) {
  const [open, setOpen] = useState(false);
  const isTool = ev.type === "tool_call" || ev.type === "tool_result";
  const human = ev.payload?.by === "human";
  const hasDetail = isTool || (ev.payload && Object.keys(ev.payload).length > 0 && !["status_change", "run_started", "run_finished", "cost"].includes(ev.type)) || ev.type === "error";
  const p = ev.payload as Record<string, unknown>;
  let body: ReactNode;
  if (isTool) body = toolSummary(ev);
  else if (ev.type === "status_change") {
    const entity = p.entity === "run" ? "运行" : "任务";
    const map = p.entity === "run" ? RUN_STATUS : TASK_STATUS;
    body = (
      <span className="tl-msg">
        {entity}：{label(map as Record<string, string>, String(p.from))} → <b>{label(map as Record<string, string>, String(p.to))}</b>
        {p.reason ? <span className="muted">（{String(p.reason)}）</span> : null}
      </span>
    );
  } else body = <span className="tl-msg">{ev.message}</span>;

  return (
    <div className={`tl-item level-${ev.level} type-${ev.type} ${human ? "human" : ""}`}>
      <div className="tl-time" title={ev.ts}>
        {fmtTime(ev.ts)}
      </div>
      <div className="tl-icon" title={label(EVENT_TYPE, ev.type)}>
        {ICON[ev.type] ?? "·"}
      </div>
      <div className="tl-main">
        <div className={`tl-head ${hasDetail ? "expandable" : ""}`} onClick={hasDetail ? () => setOpen((o) => !o) : undefined}>
          {hasDetail ? <span className="muted small">{open ? "▾" : "▸"}</span> : null}
          {!isTool && ev.type !== "status_change" ? <span className="tl-type">{human ? "人工" : label(EVENT_TYPE, ev.type)}</span> : null}
          {body}
          {showTask && ev.task_id ? (
            <Link to={`/tasks/${ev.task_id}`} className="small muted">
              {shortId(ev.task_id)}
            </Link>
          ) : null}
          {showTask && ev.run_id ? (
            <Link to={`/runs/${ev.run_id}`} className="small muted">
              {shortId(ev.run_id)}
            </Link>
          ) : null}
        </div>
        {open && hasDetail ? <EventDetail ev={ev} /> : null}
      </div>
    </div>
  );
}

function EventDetail({ ev }: { ev: Event }) {
  const p = ev.payload as { input?: unknown; output?: unknown; [k: string]: unknown };
  if (ev.type === "tool_call") {
    return (
      <div className="tl-detail">
        <div>
          <div className="lbl">输入 (input)</div>
          <pre className="json" style={{ maxHeight: 260 }}>
            {pretty(p.input ?? {})}
          </pre>
        </div>
      </div>
    );
  }
  if (ev.type === "tool_result") {
    const { output, ...rest } = p;
    return (
      <div className="tl-detail">
        <div>
          <div className="lbl">输出 (output)</div>
          <pre className="json" style={{ maxHeight: 260 }}>
            {output === undefined ? "(无输出)" : pretty(output)}
          </pre>
        </div>
        {Object.keys(rest).filter((k) => !["tool", "ok", "duration_ms", "seq"].includes(k)).length ? (
          <pre className="json" style={{ maxHeight: 160 }}>
            {pretty(rest)}
          </pre>
        ) : null}
      </div>
    );
  }
  return (
    <div className="tl-detail">
      <pre className="json" style={{ maxHeight: 220 }}>
        {pretty(ev.payload)}
      </pre>
    </div>
  );
}
