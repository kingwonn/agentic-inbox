import { useState } from "react";
import { get, qs, useApi } from "../api";
import { ApprovalCard } from "../components/ApprovalCard";
import { Timeline } from "../components/Timeline";
import { Card, Empty, JsonView, KV, Link, Loading, PageHeader, RunStatusBadge, Select, TextBlock } from "../components/ui";
import { duration, fmtDateTime, money, relTime, shortId, tokens } from "../format";
import { RUN_STATUS } from "../labels";
import { navigate } from "../router";
import { useLive } from "../sse";
import type { Page, Run, RunDetail as RunDetailT, RunStatus } from "../types";

const STATUS_OPTIONS = (Object.keys(RUN_STATUS) as RunStatus[]).map((v) => ({ value: v, label: RUN_STATUS[v] }));

export function Runs() {
  const [status, setStatus] = useState<RunStatus | "">("");
  const list = useApi(() => get<Page<Run>>(`/runs${qs({ status: status || undefined, limit: 200 })}`), [status]);
  useLive(["run.changed", "task.changed"], () => list.reload());
  const items = list.data?.items ?? [];
  const totalCost = items.reduce((a, r) => a + (r.cost_usd ?? 0), 0);
  return (
    <div className="page">
      <PageHeader title="运行 (Runs)" sub={`${items.length} 次运行 · 合计 ${money(totalCost)}`} />
      <div className="toolbar">
        <Select value={status} onChange={setStatus} options={STATUS_OPTIONS} allLabel="全部状态" />
      </div>
      {list.error ? <Loading error={list.error} retry={list.reload} /> : null}
      <div className="card">
        <div className="card-body flush table-wrap">
          {list.loading && !list.data ? (
            <Loading />
          ) : items.length === 0 ? (
            <Empty>没有运行记录</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>任务</th>
                  <th className="hide-mobile">Runner / 模型</th>
                  <th className="num">费用</th>
                  <th className="num hide-mobile">Tokens 入/出</th>
                  <th className="num">轮次</th>
                  <th>耗时</th>
                  <th className="hide-mobile">开始</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/runs/${r.id}`)}>
                    <td>
                      <RunStatusBadge s={r.status} />
                    </td>
                    <td className="title-cell">
                      <div className="t">{r.task_title ?? r.task_id}</div>
                      <div className="s">
                        <span className="mono">{shortId(r.id)}</span> · 第 {r.attempt} 次 · {r.reason}
                        {r.error ? <span className="danger-text"> · {r.error}</span> : null}
                      </div>
                    </td>
                    <td className="hide-mobile small">
                      {r.runner} / {r.model}
                    </td>
                    <td className="num small">{money(r.cost_usd)}</td>
                    <td className="num small hide-mobile">
                      {tokens(r.input_tokens)} / {tokens(r.output_tokens)}
                    </td>
                    <td className="num small">{r.num_turns}</td>
                    <td className="small">{duration(r.started_at, r.ended_at)}</td>
                    <td className="hide-mobile small muted nowrap">{relTime(r.started_at ?? r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export function RunDetail({ id }: { id: string }) {
  const d = useApi(() => get<RunDetailT>(`/runs/${id}`), [id]);
  useLive("all", (m) => {
    const data = m.data as { run_id?: string } | null;
    if (!data || data.run_id === undefined || data.run_id === id) d.reload();
  });
  if (d.error) return <Loading error={d.error} retry={d.reload} />;
  if (!d.data) return <Loading />;
  const { run, task, events, approvals, artifacts } = d.data;
  const toolCalls = events.filter((e) => e.type === "tool_call").length;
  return (
    <div className="page">
      <div className="muted small mb">
        <Link to="/runs">运行</Link>
        {task ? (
          <>
            {" / "}
            <Link to={`/tasks/${task.id}`}>{task.title}</Link>
          </>
        ) : null}
        {" / "}
        <span className="mono">{run.id}</span>
      </div>
      <PageHeader
        title={task?.title ?? run.id}
        sub={
          <span className="row" style={{ gap: 6 }}>
            <RunStatusBadge s={run.status} />
            <span>
              第 {run.attempt} 次 · {run.reason} · {run.runner} / {run.model}
            </span>
          </span>
        }
      />
      {run.error ? (
        <div className="error-box mb">
          <span>
            <b>错误：</b>
            {run.error}
          </span>
        </div>
      ) : null}
      <div className="grid grid-main">
        <div className="stack">
          <Card title={`工具调用日志 · ${toolCalls} 次调用 · ${events.length} 条事件`}>
            <Timeline events={events} emptyText="该运行没有记录事件" />
          </Card>
          {run.result ? (
            <Card title="结构化结果 (AgentOutput)">
              <div className="stack">
                <div>
                  <b>摘要：</b>
                  {run.result.summary}
                </div>
                <div className="small">
                  状态 <b>{run.result.status}</b> · 验证 {run.result.verification?.passed ? <span className="success-text">通过</span> : <span className="danger-text">未通过</span>}
                  {run.result.verification?.details ? ` — ${run.result.verification.details}` : ""}
                </div>
                {run.result.follow_ups?.length ? (
                  <div className="small">
                    <b>后续：</b>
                    {run.result.follow_ups.join("；")}
                  </div>
                ) : null}
                {run.result.learned?.length ? (
                  <div className="small">
                    <b>学到：</b>
                    {run.result.learned.join("；")}
                  </div>
                ) : null}
                <details>
                  <summary className="muted small">原始 JSON</summary>
                  <JsonView value={run.result} />
                </details>
              </div>
            </Card>
          ) : run.result_text ? (
            <Card title="结果文本">
              <TextBlock text={run.result_text} />
            </Card>
          ) : null}
        </div>
        <div className="stack">
          <Card title="概要">
            <KV
              cols={1}
              items={[
                ["状态", <RunStatusBadge s={run.status} />],
                ["费用", money(run.cost_usd)],
                ["Tokens", `${tokens(run.input_tokens)} 入 / ${tokens(run.output_tokens)} 出`],
                ["轮次", String(run.num_turns)],
                ["耗时", duration(run.started_at, run.ended_at)],
                ["会话 ID", run.session_id ? <span className="mono small">{run.session_id}</span> : "—"],
                run.resume_of ? ["续接自", <Link to={`/runs/${run.resume_of}`}>{shortId(run.resume_of)}</Link>] : null,
                ["开始", fmtDateTime(run.started_at)],
                ["结束", fmtDateTime(run.ended_at)],
                ["创建", fmtDateTime(run.created_at)],
              ]}
            />
          </Card>
          {approvals.length ? (
            <Card title={`审批 (${approvals.length})`}>
              <div className="stack">
                {approvals.map((a) => (
                  <ApprovalCard key={a.id} approval={a} compact showTask={false} onDecided={() => d.reload()} />
                ))}
              </div>
            </Card>
          ) : null}
          {artifacts.length ? (
            <Card title={`交付物 (${artifacts.length})`}>
              <div className="stack" style={{ gap: 4 }}>
                {artifacts.map((a) => (
                  <Link key={a.id} to={`/artifacts/${a.id}`}>
                    {a.title}
                  </Link>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
