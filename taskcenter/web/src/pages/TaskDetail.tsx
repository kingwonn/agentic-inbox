import { useEffect, useState } from "react";
import { artifactDownloadUrl, get, patch, post, qs, useApi } from "../api";
import { ApprovalCard } from "../components/ApprovalCard";
import { Timeline } from "../components/Timeline";
import { Badge, Button, Card, Empty, JsonView, KV, LevelBadge, Link, Loading, Modal, PageHeader, PriorityBadge, RunStatusBadge, TaskStatusBadge, TextBlock } from "../components/ui";
import { duration, fmtDateTime, money, relTime, tokens } from "../format";
import { ARTIFACT_TYPE, CATEGORY, INBOX_KIND, LEVEL, PRIORITY, TASK_STATUS, TASK_STATUS_ORDER, label } from "../labels";
import { navigate } from "../router";
import { useLive } from "../sse";
import { useToast } from "../toast";
import { NewTaskModal } from "./Tasks";
import type { Event, Level, Page, Priority, Task, TaskDetail as TaskDetailT, TaskStatus } from "../types";

export function TaskDetail({ id }: { id: string }) {
  const toast = useToast();
  const d = useApi(() => get<TaskDetailT>(`/tasks/${id}`), [id]);
  const allEvents = useApi(() => get<Page<Event>>(`/events${qs({ task_id: id, limit: 500 })}`), [id]);
  useLive("all", (m) => {
    const data = m.data as { task_id?: string | null } | null;
    if (!data || data.task_id === undefined || data.task_id === id || d.data?.children.some((c) => c.id === data.task_id)) {
      d.reload();
      allEvents.reload();
    }
  });
  const [editOpen, setEditOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [note, setNote] = useState("");

  if (d.error) return <Loading error={d.error} retry={d.reload} />;
  if (!d.data) return <Loading />;
  const { task, parent, children, dependencies, runs, approvals, artifacts, inbox_item } = d.data;
  const events = (allEvents.data?.items ?? d.data.events).slice().reverse();

  const action = (path: string, ok: string, body?: unknown) =>
    toast.run(
      async () => {
        await post(`/tasks/${task.id}/${path}`, body);
        d.reload();
      },
      { ok, fail: "操作失败" },
    );
  const canRetry = ["failed", "cancelled", "blocked", "done"].includes(task.status);
  const canCancel = !["done", "cancelled", "failed"].includes(task.status);
  const canRun = ["todo", "ready", "blocked", "waiting_human", "review", "failed"].includes(task.status);

  return (
    <div className="page">
      <div className="muted small mb">
        <Link to="/tasks">任务</Link>
        {parent ? (
          <>
            {" / "}
            <Link to={`/tasks/${parent.id}`}>{parent.title}</Link>
          </>
        ) : null}
        {" / "}
        <span className="mono">{task.id}</span>
      </div>
      <PageHeader
        title={task.title}
        sub={
          <span className="row" style={{ gap: 6 }}>
            <TaskStatusBadge s={task.status} />
            <PriorityBadge p={task.priority} />
            <LevelBadge level={task.level} />
            <Badge>{label(CATEGORY, task.category)}</Badge>
            <Badge tone="muted">{label(INBOX_KIND, task.kind)}</Badge>
            {task.owner === "human" ? <Badge tone="warn">人工负责</Badge> : null}
            <span>更新于 {relTime(task.updated_at)}</span>
          </span>
        }
        actions={
          <>
            {canRun ? (
              <Button tone="primary" onClick={() => action("run", "已加入执行队列")}>
                ▶ 立即运行
              </Button>
            ) : null}
            {canRetry ? <Button onClick={() => action("retry", "已重试")}>重试</Button> : null}
            <Button onClick={() => action("plan", "已请求规划")}>规划</Button>
            <Button onClick={() => setEditOpen(true)}>编辑 / 人工干预</Button>
            {canCancel ? (
              <Button tone="danger" onClick={() => action("cancel", "已取消", { reason: "dashboard" })}>
                取消
              </Button>
            ) : null}
          </>
        }
      />
      {task.last_error ? (
        <div className="error-box mb">
          <span>
            <b>最近错误：</b>
            {task.last_error}
          </span>
        </div>
      ) : null}

      <div className="grid grid-main">
        <div className="stack">
          {task.description ? (
            <Card title="描述">
              <TextBlock text={task.description} />
            </Card>
          ) : null}
          {task.result_summary ? (
            <Card title="结果摘要">
              <TextBlock text={task.result_summary} />
            </Card>
          ) : null}
          <Card title={`计划 (Plan)${task.plan?.steps?.length ? ` · ${task.plan.steps.filter((s) => s.done).length}/${task.plan.steps.length}` : ""}`}>
            {task.plan ? (
              <div className="stack">
                <div>
                  <b>目标：</b>
                  {task.plan.goal}
                </div>
                <ul className="steps">
                  {task.plan.steps.map((s, i) => (
                    <li key={s.id ?? i} className={`step ${s.done ? "done" : ""}`}>
                      <span className="chk">{s.done ? "✓" : ""}</span>
                      <div>
                        <div>
                          {s.title}
                          {s.needs_approval ? <Badge tone="warn" className="ml">需审批</Badge> : null}
                          {s.tools?.length ? <span className="muted small"> · {s.tools.join(", ")}</span> : null}
                        </div>
                        {s.description ? <div className="desc">{s.description}</div> : null}
                      </div>
                    </li>
                  ))}
                </ul>
                {task.plan.risks?.length ? (
                  <div className="small">
                    <b>风险：</b>
                    {task.plan.risks.join("；")}
                  </div>
                ) : null}
                {task.plan.acceptance_criteria?.length ? (
                  <div className="small">
                    <b>验收标准：</b>
                    {task.plan.acceptance_criteria.join("；")}
                  </div>
                ) : null}
                {task.plan.estimated_cost_usd !== undefined ? <div className="muted small">预估费用 {money(task.plan.estimated_cost_usd)}</div> : null}
              </div>
            ) : (
              <Empty>尚未规划 — 点击「规划」让 Agent 生成计划</Empty>
            )}
          </Card>

          <Card
            title={`子任务 (${children.length})`}
            actions={
              <Button size="sm" onClick={() => setSubOpen(true)}>
                ＋ 子任务
              </Button>
            }
          >
            {dependencies.length ? (
              <div className="small mb">
                <b>依赖：</b>
                {dependencies.map((dep) => (
                  <span key={dep.id} className="tag">
                    <Link to={`/tasks/${dep.id}`}>{dep.title}</Link> <TaskStatusBadge s={dep.status} />
                  </span>
                ))}
              </div>
            ) : null}
            {children.length === 0 ? (
              <Empty>没有子任务</Empty>
            ) : (
              <div className="tree">
                {children.map((c) => (
                  <div key={c.id} className="tree-item">
                    <TaskStatusBadge s={c.status} />
                    <Link to={`/tasks/${c.id}`} className="grow">
                      {c.title}
                    </Link>
                    <LevelBadge level={c.level} />
                    <PriorityBadge p={c.priority} />
                    {c.depends_on.length ? (
                      <span className="muted small">
                        依赖：
                        {c.depends_on.map((depId) => {
                          const dep = children.find((x) => x.id === depId);
                          return (
                            <Link key={depId} to={`/tasks/${depId}`} className="tag">
                              {dep ? dep.title.slice(0, 18) : depId}
                            </Link>
                          );
                        })}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title={`运行 (${runs.length})`}>
            {runs.length === 0 ? (
              <Empty>尚未运行</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>状态</th>
                      <th>Runner / 模型</th>
                      <th className="num">费用</th>
                      <th className="num hide-mobile">Tokens</th>
                      <th className="num">轮次</th>
                      <th>耗时</th>
                      <th className="hide-mobile">原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id} className="clickable" onClick={() => navigate(`/runs/${r.id}`)}>
                        <td className="muted">{r.attempt}</td>
                        <td>
                          <RunStatusBadge s={r.status} />
                        </td>
                        <td className="small">
                          {r.runner} / {r.model}
                        </td>
                        <td className="num small">{money(r.cost_usd)}</td>
                        <td className="num small hide-mobile">
                          {tokens(r.input_tokens)} / {tokens(r.output_tokens)}
                        </td>
                        <td className="num small">{r.num_turns}</td>
                        <td className="small">{duration(r.started_at, r.ended_at)}</td>
                        <td className="small muted hide-mobile">{r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title={`时间线 (${events.length})`}>
            <div className="row mb">
              <input type="text" className="grow" placeholder="添加人工备注（记录为 system 事件）…" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && note.trim() && addNote()} />
              <Button size="sm" disabled={!note.trim()} onClick={addNote}>
                添加备注
              </Button>
            </div>
            <Timeline events={events} />
          </Card>
        </div>

        <div className="stack">
          <Card title="元数据">
            <KV
              cols={1}
              items={[
                ["状态", <TaskStatusBadge s={task.status} />],
                ["级别", `${LEVEL[task.level].short} ${LEVEL[task.level].name}`],
                ["优先级", label(PRIORITY, task.priority)],
                ["尝试", `${task.attempts} / ${task.max_attempts}`],
                ["费用", `${money(task.cost_usd)} / 预算 ${money(task.budget_usd)}`],
                ["Runner", task.runner ?? "默认"],
                ["模型", task.model ?? "默认"],
                task.workspace ? ["工作区", <span className="mono small">{task.workspace}</span>] : null,
                task.deadline ? ["截止", fmtDateTime(task.deadline)] : null,
                task.follow_up_at ? ["跟进", fmtDateTime(task.follow_up_at)] : null,
                ["创建", fmtDateTime(task.created_at)],
                task.started_at ? ["开始", fmtDateTime(task.started_at)] : null,
                task.finished_at ? ["结束", fmtDateTime(task.finished_at)] : null,
                task.labels.length ? ["标签", task.labels.map((l) => <span key={l} className="tag">{l}</span>)] : null,
                inbox_item ? ["来源", <Link to={`/inbox/${inbox_item.id}`}>{inbox_item.title}</Link>] : null,
                task.acceptance_criteria.length ? ["验收", task.acceptance_criteria.join("；")] : null,
              ]}
            />
            {Object.keys(task.context ?? {}).length ? (
              <details className="mt">
                <summary className="muted small">上下文 (context)</summary>
                <JsonView value={task.context} maxHeight={200} />
              </details>
            ) : null}
          </Card>
          <Card title={`审批 (${approvals.length})`}>
            {approvals.length === 0 ? (
              <Empty>没有审批记录</Empty>
            ) : (
              <div className="stack">
                {approvals.map((a) => (
                  <ApprovalCard key={a.id} approval={a} compact showTask={false} onDecided={() => d.reload()} />
                ))}
              </div>
            )}
          </Card>
          <Card title={`交付物 (${artifacts.length})`}>
            {artifacts.length === 0 ? (
              <Empty>没有交付物</Empty>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {artifacts.map((a) => (
                  <div key={a.id} className="row-between" style={{ gap: 6 }}>
                    <span className="row" style={{ gap: 6 }}>
                      <span title={ARTIFACT_TYPE[a.type]?.label}>{ARTIFACT_TYPE[a.type]?.icon ?? "📄"}</span>
                      <Link to={`/artifacts/${a.id}`}>{a.title}</Link>
                    </span>
                    <span className="row" style={{ gap: 6 }}>
                      {a.url ? (
                        <a href={a.url} target="_blank" rel="noreferrer" className="small">
                          打开
                        </a>
                      ) : null}
                      {a.content || a.path ? (
                        <a href={artifactDownloadUrl(a.id)} className="small">
                          下载
                        </a>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <EditTaskModal task={task} open={editOpen} onClose={() => setEditOpen(false)} onSaved={() => d.reload()} />
      <NewTaskModal open={subOpen} onClose={() => setSubOpen(false)} parents={[task]} defaultParent={task.id} onCreated={() => d.reload()} />
    </div>
  );

  async function addNote() {
    const text = note.trim();
    if (!text) return;
    const r = await toast.run(() => post(`/tasks/${task.id}/events`, { message: text }), { ok: "备注已记录", fail: "记录失败" });
    if (r) {
      setNote("");
      allEvents.reload();
      d.reload();
    }
  }
}

function EditTaskModal({ task, open, onClose, onSaved }: { task: Task; open: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [level, setLevel] = useState<Level>(task.level);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [owner, setOwner] = useState(task.owner);
  const [followUp, setFollowUp] = useState(task.follow_up_at ? task.follow_up_at.slice(0, 16) : "");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) {
      setTitle(task.title);
      setDescription(task.description);
      setLevel(task.level);
      setPriority(task.priority);
      setStatus(task.status);
      setOwner(task.owner);
      setFollowUp(task.follow_up_at ? task.follow_up_at.slice(0, 16) : "");
      setReason("");
    }
  }, [open, task]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="编辑任务 / 人工干预"
      footer={
        <>
          <Button tone="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            tone="primary"
            onClick={async () => {
              const body: Record<string, unknown> = {};
              if (title.trim() !== task.title) body.title = title.trim();
              if (description !== task.description) body.description = description;
              if (level !== task.level) body.level = level;
              if (priority !== task.priority) body.priority = priority;
              if (status !== task.status) body.status = status;
              if (owner !== task.owner) body.owner = owner;
              const fu = followUp ? new Date(followUp).toISOString() : null;
              if (fu !== task.follow_up_at) body.follow_up_at = fu;
              if (reason.trim()) body.reason = reason.trim();
              if (Object.keys(body).length === 0) {
                onClose();
                return;
              }
              const r = await toast.run(() => patch(`/tasks/${task.id}`, body), { ok: "已保存", fail: "保存失败" });
              if (r) {
                onClose();
                onSaved();
              }
            }}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="form">
        <label>
          标题
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          描述
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="form-row">
          <label>
            级别
            <select value={level} onChange={(e) => setLevel(Number(e.target.value) as Level)}>
              {([1, 2, 3, 4, 5] as Level[]).map((l) => (
                <option key={l} value={l}>
                  L{l} {LEVEL[l].name}
                </option>
              ))}
            </select>
          </label>
          <label>
            优先级
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {(Object.keys(PRIORITY) as Priority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            负责方
            <select value={owner} onChange={(e) => setOwner(e.target.value as "ai" | "human")}>
              <option value="ai">AI</option>
              <option value="human">人工</option>
            </select>
          </label>
        </div>
        <div className="form-row">
          <label>
            状态（强制切换，人工干预）
            <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
              {TASK_STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            跟进时间
            <input type="datetime-local" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
          </label>
        </div>
        <label>
          原因（写入事件日志）
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：手动确认已完成" />
        </label>
      </div>
    </Modal>
  );
}
