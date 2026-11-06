import { useState } from "react";
import { get, getToken, post, setToken, useApi } from "../api";
import { Badge, Button, Card, Dot, Empty, KV, Loading, Meter, PageHeader } from "../components/ui";
import { fmtDateTime, money, pct, relTime } from "../format";
import { SCHEDULE_JOB, SOURCE, label } from "../labels";
import { useLive, useLiveStatus } from "../sse";
import { useToast } from "../toast";
import type { BudgetDay, BudgetStatus, Status as StatusT } from "../types";

export function Status() {
  const toast = useToast();
  const status = useApi(() => get<StatusT>("/status"), []);
  const budget = useApi(() => get<{ status: BudgetStatus; history: BudgetDay[] }>("/budget"), []);
  const { connected, lastEventAt } = useLiveStatus();
  useLive("all", () => {
    status.reload();
    budget.reload();
  }, 1500);
  const [token, setTokenState] = useState(getToken());

  const s = status.data;
  const run = (path: string, ok: string, body?: unknown) =>
    toast.run(
      async () => {
        const r = await post<Record<string, unknown>>(path, body);
        status.reload();
        return r;
      },
      { ok, fail: "操作失败" },
    );

  const history = (budget.data?.history ?? []).slice().reverse();
  const maxCost = Math.max(budget.data?.status.limitUsd ?? 0, ...history.map((h) => h.cost_usd), 0.01);

  return (
    <div className="page">
      <PageHeader
        title="状态 (Status)"
        sub={s ? `v${s.version} · 启动 ${relTime(s.startedAt)} · 数据目录 ${s.dataDir}` : undefined}
        actions={
          <>
            <Button onClick={() => run("/sensors/poll", "巡检已触发")} disabled={!s?.services.includes("patrol")}>
              立即巡检
            </Button>
            <Button onClick={() => run("/triage/run", "分诊已触发")} disabled={!s?.services.includes("triage")}>
              立即分诊
            </Button>
            {s?.executor?.paused ? (
              <Button tone="success" onClick={() => run("/executor/resume", "执行器已恢复")}>
                恢复执行器
              </Button>
            ) : (
              <Button tone="danger" onClick={() => run("/executor/pause", "执行器已暂停", { reason: "dashboard" })} disabled={!s?.executor}>
                暂停执行器
              </Button>
            )}
            <Button onClick={() => run("/executor/wake", "已唤醒执行器")} disabled={!s?.executor}>
              唤醒
            </Button>
          </>
        }
      />
      {status.error ? <Loading error={status.error} retry={status.reload} /> : null}
      {!s ? <Loading /> : null}
      {s ? (
        <div className="grid grid-2">
          <Card title="执行器与预算">
            <KV
              cols={1}
              items={[
                ["执行器", s.executor ? <span className="row" style={{ gap: 6 }}>{s.executor.paused ? <Badge tone="warn">已暂停{s.executor.pauseReason ? `：${s.executor.pauseReason}` : ""}</Badge> : <Badge tone="success">运行中</Badge>}<span className="muted small">并发 {s.executor.concurrency} · 运行 {s.executor.running.length}</span></span> : <Badge tone="muted">未就绪</Badge>],
                ["实时流", <span className="row" style={{ gap: 6 }}><Dot tone={connected ? "success" : "danger"} pulse={connected} /> {connected ? "已连接" : "未连接"}{lastEventAt ? <span className="muted small">· 最近事件 {relTime(new Date(lastEventAt).toISOString())}</span> : null}</span>],
                [
                  "今日预算",
                  <div className="stack" style={{ gap: 4 }}>
                    <div>
                      {money(s.budget.spentUsd)} / {money(s.budget.limitUsd)} <span className="muted small">({pct(s.budget.ratio)} · {s.budget.runs} 次运行 · {s.budget.day})</span>
                    </div>
                    <Meter ratio={s.budget.ratio} warn={s.budget.warn} danger={s.budget.exhausted} />
                  </div>,
                ],
                ["已注册服务", s.services.length ? s.services.map((x) => <span key={x} className="tag">{x}</span>) : "—"],
              ]}
            />
            {s.executor?.running.length ? (
              <div className="mt">
                <div className="muted small mb">正在运行</div>
                {s.executor.running.map((r) => (
                  <div key={r.run_id} className="row small">
                    <Dot tone="accent" pulse />
                    <a href={`#/tasks/${r.task_id}`}>{r.title}</a>
                    <span className="muted">{relTime(r.started_at)}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="mt">
              <div className="muted small mb">最近 30 天花费</div>
              {history.length === 0 ? (
                <Empty>暂无记录</Empty>
              ) : (
                <div className="bars">
                  {history.map((h) => (
                    <div key={h.day} className="bar" title={`${h.day}: ${money(h.cost_usd)} · ${h.runs} 次运行`}>
                      <div className={`b ${h.cost_usd > (budget.data?.status.limitUsd ?? Infinity) ? "over" : ""}`} style={{ height: `${Math.max(2, (h.cost_usd / maxCost) * 70)}px` }} />
                      <div className="l">{h.day.slice(5)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card title="配置摘要（不含密钥）">
            <KV
              cols={1}
              items={[
                ["LLM 提供方", s.config.provider],
                ["模型", `分诊 ${s.config.models.classify} · 规划 ${s.config.models.plan} · 执行 ${s.config.models.execute} · 重型 ${s.config.models.heavy}`],
                ["努力程度", s.config.effort],
                ["每次运行", `≤ ${s.config.max_turns} 轮 · ${s.config.timeout_seconds}s · ${money(s.config.budget_usd_per_run)}`],
                ["每日预算", money(s.config.daily_budget_usd)],
                ["执行器", `并发 ${s.config.concurrency} · 最多 ${s.config.max_attempts} 次尝试`],
                ["巡检间隔", `${s.config.patrol_interval_minutes} 分钟`],
                ["审批", `等待 ${s.config.approval.wait_seconds}s · ${s.config.approval.expire_hours}h 过期`],
                ["传感器", s.config.sensors.length ? s.config.sensors.map((x) => <span key={x} className="tag">{label(SOURCE, x)}</span>) : "无"],
                ["通知渠道", s.config.channels.length ? s.config.channels.map((x) => <span key={x} className="tag">{x}</span>) : "无"],
                ["每日摘要", s.config.digest.enabled ? `开启 · ${s.config.digest.cron}` : "关闭"],
                ["时区 / 语言", `${s.config.timezone} / ${s.config.locale}`],
                ["服务", `${s.config.server.host}:${s.config.server.port} · ${s.config.server.auth ? "需要 Token" : "无鉴权（仅本机）"}${s.config.server.public_url ? ` · ${s.config.server.public_url}` : ""}`],
              ]}
            />
            <div className="mt">
              <div className="muted small mb">API Token（保存在本浏览器 localStorage，写操作需要）</div>
              <div className="token-box">
                <input type="password" className="grow" placeholder="TC_API_TOKEN" value={token} onChange={(e) => setTokenState(e.target.value)} />
                <Button
                  size="sm"
                  onClick={() => {
                    setToken(token.trim());
                    toast.success(token.trim() ? "Token 已保存，刷新页面后实时流生效" : "Token 已清除");
                  }}
                >
                  保存
                </Button>
              </div>
            </div>
          </Card>

          <Card title={`定时任务 (${s.schedules.length})`}>
            {s.schedules.length === 0 ? (
              <Empty>守护进程未注册定时任务</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>任务</th>
                      <th>Cron</th>
                      <th>上次</th>
                      <th>下次</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.schedules.map((sc) => (
                      <tr key={sc.name}>
                        <td>{label(SCHEDULE_JOB, sc.job) === sc.job ? sc.name : label(SCHEDULE_JOB, sc.job)}</td>
                        <td className="mono small">{sc.cron}</td>
                        <td className="small muted" title={fmtDateTime(sc.last_run_at)}>
                          {relTime(sc.last_run_at)}
                        </td>
                        <td className="small muted" title={fmtDateTime(sc.next_run_at)}>
                          {relTime(sc.next_run_at)}
                        </td>
                        <td>
                          {!sc.enabled ? <Badge tone="muted">停用</Badge> : sc.last_status === "error" ? <Badge tone="danger" title={sc.last_error ?? ""}>错误</Badge> : sc.last_status ? <Badge tone="success">{sc.last_status}</Badge> : <Badge>—</Badge>}
                          {sc.last_error ? <div className="danger-text small">{sc.last_error}</div> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title={`传感器游标 (${s.cursors.length})`}>
            {s.cursors.length === 0 ? (
              <Empty>尚未巡检</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>传感器</th>
                      <th>键</th>
                      <th>值</th>
                      <th>更新</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.cursors.map((c) => (
                      <tr key={`${c.sensor}:${c.key}`}>
                        <td>
                          <Badge tone="info">{label(SOURCE, c.sensor)}</Badge>
                        </td>
                        <td className="mono small">{c.key}</td>
                        <td className="mono small truncate" style={{ maxWidth: 220 }} title={c.value}>
                          {c.value}
                        </td>
                        <td className="small muted" title={fmtDateTime(c.updated_at)}>
                          {relTime(c.updated_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  );
}
