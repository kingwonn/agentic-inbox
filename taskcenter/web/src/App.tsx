import { useEffect, type ReactNode } from "react";
import { get, useApi } from "./api";
import { Dot, Meter } from "./components/ui";
import { money } from "./format";
import { Artifacts } from "./pages/Artifacts";
import { Events } from "./pages/Events";
import { Inbox } from "./pages/Inbox";
import { Memory } from "./pages/Memory";
import { Outbox } from "./pages/Outbox";
import { Overview } from "./pages/Overview";
import { RunDetail, Runs } from "./pages/Runs";
import { Status } from "./pages/Status";
import { TaskDetail } from "./pages/TaskDetail";
import { Tasks } from "./pages/Tasks";
import { href, useRoute } from "./router";
import { useLive, useLiveStatus } from "./sse";
import type { Status as StatusT } from "./types";

interface NavItem {
  path: string;
  zh: string;
  en: string;
  icon: string;
  count?: (s: StatusT) => number | undefined;
}

const NAV: NavItem[] = [
  { path: "/", zh: "总览", en: "Overview", icon: "◫" },
  { path: "/inbox", zh: "收件箱", en: "Inbox", icon: "⇩", count: (s) => s.counts.inbox.new },
  { path: "/outbox", zh: "待确认", en: "Outbox", icon: "✋", count: (s) => s.counts.approvals.pending },
  { path: "/tasks", zh: "任务", en: "Tasks", icon: "☰", count: (s) => (s.counts.tasks.running ?? 0) + (s.counts.tasks.ready ?? 0) || undefined },
  { path: "/runs", zh: "运行", en: "Runs", icon: "▶", count: (s) => s.counts.runs.running },
  { path: "/events", zh: "事件日志", en: "Events", icon: "≡" },
  { path: "/artifacts", zh: "交付物", en: "Artifacts", icon: "📎" },
  { path: "/memory", zh: "记忆与上下文", en: "Memory", icon: "🧠" },
  { path: "/status", zh: "状态", en: "Status", icon: "⚙" },
];

function titleFor(parts: string[]): string {
  const first = parts[0] ?? "";
  const item = NAV.find((n) => n.path === `/${first}`) ?? NAV[0];
  if (first === "tasks" && parts[1]) return "任务详情";
  if (first === "runs" && parts[1]) return "运行详情";
  return `${item.zh} · ${item.en}`;
}

export function App() {
  const route = useRoute();
  const status = useApi(() => get<StatusT>("/status"), []);
  useLive("all", () => status.reload(), 800);
  const { connected } = useLiveStatus();
  const s = status.data;
  const section = `/${route.parts[0] ?? ""}`;
  useEffect(() => {
    document.title = `${titleFor(route.parts)} — Task Center`;
  }, [route.parts]);

  let page: ReactNode;
  switch (route.parts[0]) {
    case undefined:
      page = <Overview />;
      break;
    case "inbox":
      page = <Inbox />;
      break;
    case "outbox":
      page = <Outbox />;
      break;
    case "tasks":
      page = route.parts[1] ? <TaskDetail id={route.parts[1]} /> : <Tasks />;
      break;
    case "runs":
      page = route.parts[1] ? <RunDetail id={route.parts[1]} /> : <Runs />;
      break;
    case "events":
      page = <Events />;
      break;
    case "artifacts":
      page = <Artifacts />;
      break;
    case "memory":
      page = <Memory />;
      break;
    case "status":
      page = <Status />;
      break;
    default:
      page = (
        <div className="page">
          <div className="empty">页面不存在：{route.path}</div>
        </div>
      );
  }

  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">
          <span className="brand-logo">TC</span>
          <span>
            Task Center
            <br />
            <small>个人 AI 任务中心</small>
          </span>
        </div>
        <div className="nav-list">
          {NAV.map((n) => {
            const active = n.path === "/" ? section === "/" : section === n.path;
            const count = s && n.count ? n.count(s) : undefined;
            return (
              <a key={n.path} href={href(n.path)} className={`nav-item ${active ? "active" : ""}`}>
                <span className="nav-icon">{n.icon}</span>
                <span>{n.zh}</span>
                {count ? <span className="nav-count">{count}</span> : <span className="nav-en">{n.en}</span>}
              </a>
            );
          })}
        </div>
        <div className="nav-foot">{s ? `v${s.version} · ${s.config.provider}` : ""}</div>
      </nav>
      <header className="header">
        <div className="header-title">{titleFor(route.parts)}</div>
        <div className="header-right">
          {s ? (
            <div className="budget" title={`今日 ${s.budget.day}：${money(s.budget.spentUsd)} / ${money(s.budget.limitUsd)}`}>
              <span className="budget-text">
                今日 {money(s.budget.spentUsd)} / {money(s.budget.limitUsd)}
              </span>
              <Meter ratio={s.budget.ratio} warn={s.budget.warn} danger={s.budget.exhausted} />
            </div>
          ) : null}
          {s?.executor ? (
            <div className="exec" title={s.executor.paused ? `执行器已暂停${s.executor.pauseReason ? `：${s.executor.pauseReason}` : ""}` : `执行器运行中，${s.executor.running.length}/${s.executor.concurrency}`}>
              <Dot tone={s.executor.paused ? "warn" : s.executor.running.length ? "accent" : "success"} pulse={!s.executor.paused && s.executor.running.length > 0} />
              <span className="exec-text">{s.executor.paused ? "已暂停" : `运行 ${s.executor.running.length}/${s.executor.concurrency}`}</span>
            </div>
          ) : null}
          <div className="live" title={connected ? "实时更新已连接 (SSE)" : "实时更新未连接"}>
            <Dot tone={connected ? "success" : "danger"} pulse={connected} />
            <span className="exec-text">{connected ? "实时" : "离线"}</span>
          </div>
        </div>
      </header>
      <main className="main">{page}</main>
    </div>
  );
}
