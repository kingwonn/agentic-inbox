import { get, qs, useApi } from "../api";
import { ApprovalCard } from "../components/ApprovalCard";
import { Timeline } from "../components/Timeline";
import { Card, Empty, Link, Loading, PageHeader, TaskStatusBadge } from "../components/ui";
import { duration, money, relTime } from "../format";
import { TASK_STATUS } from "../labels";
import { href } from "../router";
import { useLive } from "../sse";
import type { Approval, Event, Page, Status, Task } from "../types";

function Tile({ label, value, sub, to, tone }: { label: string; value: number | string; sub?: string; to?: string; tone?: "danger" | "warn" | "accent" }) {
  const cls = `tile-value ${tone ?? ""}`;
  const body = (
    <>
      <div className="tile-label">{label}</div>
      <div className={cls}>{value}</div>
      {sub ? <div className="tile-sub">{sub}</div> : null}
    </>
  );
  return to ? (
    <a className="tile" href={href(to)}>
      {body}
    </a>
  ) : (
    <div className="tile">{body}</div>
  );
}

export function Overview() {
  const status = useApi(() => get<Status>("/status"), []);
  const approvals = useApi(() => get<Page<Approval>>("/approvals?status=pending&limit=10"), []);
  const events = useApi(() => get<Page<Event>>(`/events${qs({ limit: 40 })}`), []);
  const active = useApi(() => get<Page<Task>>("/tasks?status=running,waiting_human,review,ready&limit=10"), []);
  useLive("all", () => {
    status.reload();
    approvals.reload();
    events.reload();
    active.reload();
  });

  const s = status.data;
  const t = s?.counts.tasks ?? {};
  const sum = (...ks: string[]) => ks.reduce((a, k) => a + (t[k] ?? 0), 0);

  return (
    <div className="page">
      <PageHeader title="总览 (Overview)" sub={s ? `版本 ${s.version} · 启动于 ${relTime(s.startedAt)} · 时区 ${s.config.timezone}` : undefined} />
      {status.error ? <Loading error={status.error} retry={status.reload} /> : null}
      <div className="tiles">
        <Tile label="收件箱 · 新" value={s?.counts.inbox.new ?? "–"} sub={`待分诊信号 ${s?.counts.untriaged ?? 0}`} to="/inbox" tone={(s?.counts.inbox.new ?? 0) > 0 ? "accent" : undefined} />
        <Tile label="待确认" value={s?.counts.approvals.pending ?? "–"} sub="需要你的决定" to="/outbox" tone={(s?.counts.approvals.pending ?? 0) > 0 ? "warn" : undefined} />
        <Tile label="运行中" value={s?.executor?.running.length ?? t.running ?? "–"} sub={s?.executor ? `并发 ${s.executor.concurrency}${s.executor.paused ? " · 已暂停" : ""}` : "执行器未就绪"} to="/runs" />
        <Tile label="任务 · 进行中" value={sum("ready", "running", "planning", "review")} sub={`就绪 ${t.ready ?? 0} · 运行 ${t.running ?? 0} · 待审阅 ${t.review ?? 0}`} to="/tasks" />
        <Tile label="任务 · 等待/阻塞" value={sum("waiting_human", "blocked")} sub={`等待人工 ${t.waiting_human ?? 0} · 阻塞 ${t.blocked ?? 0}`} to="/tasks" tone={sum("waiting_human") > 0 ? "warn" : undefined} />
        <Tile label="24h 失败" value={s?.counts.failures24h ?? "–"} sub={`失败任务 ${t.failed ?? 0} · 完成 ${t.done ?? 0}`} to="/events?level=error" tone={(s?.counts.failures24h ?? 0) > 0 ? "danger" : undefined} />
        <Tile label="今日花费" value={s ? money(s.budget.spentUsd) : "–"} sub={s ? `上限 ${money(s.budget.limitUsd)} · ${s.budget.runs} 次运行` : undefined} to="/status" tone={s?.budget.exhausted ? "danger" : s?.budget.warn ? "warn" : undefined} />
      </div>

      <div className="grid grid-main">
        <div className="stack">
          <Card title="待确认 (Pending approvals)" actions={<Link to="/outbox">全部 →</Link>}>
            {approvals.loading && !approvals.data ? <Loading /> : null}
            {approvals.data?.items.length ? (
              <div className="stack">
                {approvals.data.items.map((a) => (
                  <ApprovalCard key={a.id} approval={a} compact onDecided={() => approvals.reload()} />
                ))}
              </div>
            ) : approvals.data ? (
              <Empty icon="✓">没有待确认事项</Empty>
            ) : null}
          </Card>
          <Card title="进行中的任务" actions={<Link to="/tasks">看板 →</Link>}>
            {active.data?.items.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>任务</th>
                      <th>状态</th>
                      <th className="hide-mobile">耗时</th>
                      <th className="num">费用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.data.items.map((task) => (
                      <tr key={task.id}>
                        <td className="title-cell">
                          <Link to={`/tasks/${task.id}`} className="t">
                            {task.title}
                          </Link>
                        </td>
                        <td>
                          <TaskStatusBadge s={task.status} />
                        </td>
                        <td className="hide-mobile muted small">{task.started_at ? duration(task.started_at, task.finished_at) : "—"}</td>
                        <td className="num small">{money(task.cost_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : active.data ? (
              <Empty>没有进行中的任务</Empty>
            ) : (
              <Loading />
            )}
          </Card>
        </div>
        <Card title="最近事件" actions={<Link to="/events">日志 →</Link>} className="events-log">
          {events.data ? <Timeline events={events.data.items} showTask dense /> : <Loading error={events.error} retry={events.reload} />}
        </Card>
      </div>
      {s && Object.keys(t).length ? (
        <div className="muted small mt">
          任务分布：
          {Object.entries(t)
            .map(([k, v]) => `${TASK_STATUS[k as keyof typeof TASK_STATUS] ?? k} ${v}`)
            .join(" · ")}
        </div>
      ) : null}
    </div>
  );
}
