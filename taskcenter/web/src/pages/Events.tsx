import { useEffect, useMemo, useState } from "react";
import { get, qs, useApi } from "../api";
import { Timeline } from "../components/Timeline";
import { Button, Loading, PageHeader, Select } from "../components/ui";
import { EVENT_TYPE } from "../labels";
import { useRoute } from "../router";
import { useLiveEvents, useLiveStatus } from "../sse";
import type { Event, EventLevel, EventType, Page } from "../types";

const TYPE_OPTIONS = (Object.keys(EVENT_TYPE) as EventType[]).map((v) => ({ value: v, label: EVENT_TYPE[v] }));
const LEVEL_OPTIONS: Array<{ value: EventLevel; label: string }> = [
  { value: "debug", label: "debug" },
  { value: "info", label: "info" },
  { value: "warn", label: "warn" },
  { value: "error", label: "error" },
];
const SINCE_OPTIONS = [
  { value: "1h", label: "最近 1 小时" },
  { value: "24h", label: "最近 24 小时" },
  { value: "7d", label: "最近 7 天" },
];

function sinceIso(v: string): string | undefined {
  const ms = v === "1h" ? 3_600_000 : v === "24h" ? 86_400_000 : v === "7d" ? 7 * 86_400_000 : 0;
  return ms ? new Date(Date.now() - ms).toISOString() : undefined;
}

export function Events() {
  const route = useRoute();
  const [type, setType] = useState<EventType | "">((route.query.get("type") as EventType) || "");
  const [level, setLevel] = useState<EventLevel | "">((route.query.get("level") as EventLevel) || "");
  const [since, setSince] = useState("");
  const [q, setQ] = useState("");
  const [follow, setFollow] = useState(true);
  const [live, setLive] = useState<Event[]>([]);
  const { connected } = useLiveStatus();
  const list = useApi(() => get<Page<Event>>(`/events${qs({ type: type || undefined, level: level || undefined, since: sinceIso(since), limit: 300 })}`), [type, level, since]);
  useEffect(() => setLive([]), [type, level, since]);
  useLiveEvents((e) => {
    if (!follow) return;
    if (type && e.type !== type) return;
    if (level && e.level !== level) return;
    setLive((xs) => (xs.some((x) => x.id === e.id) ? xs : [e, ...xs].slice(0, 500)));
  });
  const events = useMemo(() => {
    const base = list.data?.items ?? [];
    const ids = new Set(base.map((e) => e.id));
    const merged = [...live.filter((e) => !ids.has(e.id)), ...base];
    const needle = q.trim().toLowerCase();
    const filtered = needle ? merged.filter((e) => e.message.toLowerCase().includes(needle) || JSON.stringify(e.payload).toLowerCase().includes(needle) || (e.task_id ?? "").includes(needle) || (e.run_id ?? "").includes(needle)) : merged;
    return filtered.slice().reverse();
  }, [list.data, live, q]);

  return (
    <div className="page">
      <PageHeader
        title="事件日志 (Events)"
        sub={`${events.length} 条 · 按时间正序 · ${connected ? "实时跟随中" : "未连接实时流"}`}
        actions={
          <>
            <Button tone={follow ? "primary" : "default"} size="sm" onClick={() => setFollow((f) => !f)}>
              {follow ? "● 自动跟随" : "○ 已暂停跟随"}
            </Button>
            <Button size="sm" onClick={list.reload}>
              刷新
            </Button>
          </>
        }
      />
      <div className="toolbar">
        <input type="search" placeholder="搜索消息 / 载荷 / 任务 ID…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={type} onChange={setType} options={TYPE_OPTIONS} allLabel="全部类型" />
        <Select value={level} onChange={setLevel} options={LEVEL_OPTIONS} allLabel="全部级别" />
        <Select value={since} onChange={setSince} options={SINCE_OPTIONS} allLabel="全部时间" />
      </div>
      {list.error ? <Loading error={list.error} retry={list.reload} /> : null}
      <div className="card">
        <div className="card-body events-log">{list.loading && !list.data ? <Loading /> : <Timeline events={events} showTask dense />}</div>
      </div>
    </div>
  );
}
