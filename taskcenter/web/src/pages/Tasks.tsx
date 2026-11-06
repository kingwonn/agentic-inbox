import { useMemo, useState } from "react";
import { get, post, useApi } from "../api";
import { Button, Empty, LevelBadge, Link, Loading, Modal, PageHeader, PriorityBadge, Select, TaskStatusBadge } from "../components/ui";
import { money, relTime } from "../format";
import { CATEGORY, LEVEL, PRIORITY, TASK_STATUS, TASK_STATUS_ORDER, label } from "../labels";
import { href, navigate } from "../router";
import { useLive } from "../sse";
import { useToast } from "../toast";
import type { Category, Level, Page, Priority, Task, TaskStatus } from "../types";

const BOARD_COLUMNS: TaskStatus[] = ["todo", "ready", "running", "waiting_human", "review", "blocked", "done", "failed"];

function TaskCard({ t, childCount }: { t: Task; childCount: number }) {
  return (
    <a className="tcard" href={href(`/tasks/${t.id}`)}>
      <div className="tcard-title">{t.title}</div>
      <div className="tcard-meta">
        <PriorityBadge p={t.priority} />
        <LevelBadge level={t.level} />
        <span>{label(CATEGORY, t.category)}</span>
        {childCount ? <span>· {childCount} 子任务</span> : null}
        {t.parent_id ? <span>· 子任务</span> : null}
      </div>
      <div className="tcard-meta">
        <span>{relTime(t.updated_at)}</span>
        {t.cost_usd ? <span>· {money(t.cost_usd)}</span> : null}
        {t.attempts ? <span>· 第 {t.attempts} 次</span> : null}
        {t.owner === "human" ? <span>· 人工</span> : null}
      </div>
      {t.last_error && (t.status === "failed" || t.status === "blocked") ? <div className="tcard-err">{t.last_error}</div> : null}
    </a>
  );
}

export function Tasks() {
  const [view, setView] = useState<"board" | "list">(() => {
    try {
      return (localStorage.getItem("tc_tasks_view") as "board" | "list") || "board";
    } catch {
      return "board";
    }
  });
  const [status, setStatus] = useState<TaskStatus | "">("");
  const [showNew, setShowNew] = useState(false);
  const list = useApi(() => get<Page<Task>>("/tasks?limit=500"), []);
  useLive(["task.changed", "run.changed"], () => list.reload());

  const tasks = list.data?.items ?? [];
  const childCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) if (t.parent_id) m.set(t.parent_id, (m.get(t.parent_id) ?? 0) + 1);
    return m;
  }, [tasks]);
  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, Task[]>();
    for (const s of TASK_STATUS_ORDER) m.set(s, []);
    for (const t of tasks) m.get(t.status)?.push(t);
    return m;
  }, [tasks]);
  const switchView = (v: "board" | "list") => {
    setView(v);
    try {
      localStorage.setItem("tc_tasks_view", v);
    } catch {
      /* ignore */
    }
  };
  const columns = BOARD_COLUMNS.concat(TASK_STATUS_ORDER.filter((s) => !BOARD_COLUMNS.includes(s) && (byStatus.get(s)?.length ?? 0) > 0));

  return (
    <div className="page">
      <PageHeader
        title="任务 (Tasks)"
        sub={`${tasks.length} 个任务`}
        actions={
          <>
            <div className="tabs" style={{ marginBottom: 0, borderBottom: 0 }}>
              <button className={`tab ${view === "board" ? "active" : ""}`} onClick={() => switchView("board")}>
                看板
              </button>
              <button className={`tab ${view === "list" ? "active" : ""}`} onClick={() => switchView("list")}>
                列表
              </button>
            </div>
            <Button tone="primary" onClick={() => setShowNew(true)}>
              ＋ 新建任务
            </Button>
          </>
        }
      />
      {list.error ? <Loading error={list.error} retry={list.reload} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {view === "board" && list.data ? (
        <div className="board">
          {columns.map((s) => {
            const items = byStatus.get(s) ?? [];
            return (
              <div className="col" key={s}>
                <div className="col-head">
                  <TaskStatusBadge s={s} />
                  <span className="muted">{items.length}</span>
                </div>
                <div className="col-body">
                  {items.length === 0 ? <div className="muted small" style={{ padding: "4px 2px 8px" }}>—</div> : null}
                  {items.map((t) => (
                    <TaskCard key={t.id} t={t} childCount={childCounts.get(t.id) ?? 0} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {view === "list" && list.data ? (
        <>
          <div className="toolbar">
            <Select value={status} onChange={setStatus} options={TASK_STATUS_ORDER.map((s) => ({ value: s, label: TASK_STATUS[s] }))} allLabel="全部状态" />
          </div>
          <div className="card">
            <div className="card-body flush table-wrap">
              {tasks.filter((t) => !status || t.status === status).length === 0 ? (
                <Empty>没有任务</Empty>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>状态</th>
                      <th>标题</th>
                      <th>优先级</th>
                      <th>级别</th>
                      <th className="hide-mobile">分类</th>
                      <th className="hide-mobile">尝试</th>
                      <th className="num">费用</th>
                      <th className="hide-mobile">更新</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks
                      .filter((t) => !status || t.status === status)
                      .map((t) => (
                        <tr key={t.id} className="clickable" onClick={() => navigate(`/tasks/${t.id}`)}>
                          <td>
                            <TaskStatusBadge s={t.status} />
                          </td>
                          <td className="title-cell">
                            <div className="t">
                              {t.parent_id ? <span className="muted">↳ </span> : null}
                              {t.title}
                            </div>
                            {t.last_error ? <div className="s danger-text">{t.last_error}</div> : t.result_summary ? <div className="s">{t.result_summary}</div> : null}
                          </td>
                          <td>
                            <PriorityBadge p={t.priority} />
                          </td>
                          <td>
                            <LevelBadge level={t.level} />
                          </td>
                          <td className="hide-mobile small">{label(CATEGORY, t.category)}</td>
                          <td className="hide-mobile small muted">
                            {t.attempts}/{t.max_attempts}
                          </td>
                          <td className="num small">{money(t.cost_usd)}</td>
                          <td className="hide-mobile small muted nowrap">{relTime(t.updated_at)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      ) : null}
      <NewTaskModal open={showNew} onClose={() => setShowNew(false)} parents={tasks.filter((t) => !t.parent_id)} onCreated={() => list.reload()} />
    </div>
  );
}

export function NewTaskModal({ open, onClose, parents, onCreated, defaultParent }: { open: boolean; onClose: () => void; parents: Task[]; onCreated: (t: Task) => void; defaultParent?: string }) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [level, setLevel] = useState<Level>(2);
  const [priority, setPriority] = useState<Priority>("P2");
  const [category, setCategory] = useState<Category>("other");
  const [parent, setParent] = useState(defaultParent ?? "");
  const [ready, setReady] = useState(false);
  const reset = () => {
    setTitle("");
    setDescription("");
    setLevel(2);
    setPriority("P2");
    setCategory("other");
    setParent(defaultParent ?? "");
    setReady(false);
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建任务 (New task)"
      footer={
        <>
          <Button tone="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            tone="primary"
            disabled={!title.trim()}
            onClick={async () => {
              const r = await toast.run(
                () => post<{ task: Task }>("/tasks", { title: title.trim(), description, level, priority, category, parent_id: parent || null, status: ready ? "ready" : "todo" }),
                { ok: "任务已创建", fail: "创建失败" },
              );
              if (r) {
                reset();
                onClose();
                onCreated(r.task);
              }
            }}
          >
            创建
          </Button>
        </>
      }
    >
      <div className="form">
        <label>
          标题
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="要做什么？" autoFocus />
        </label>
        <label>
          描述 / 验收标准
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="背景、链接、期望结果…" />
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
            分类
            <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
              {(Object.keys(CATEGORY) as Category[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY[c]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          父任务（可选）
          <select value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">无</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <label className="row" style={{ display: "flex" }}>
          <input type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} style={{ minHeight: 0 }} /> 立即就绪（执行器可以开始运行）
        </label>
        <div className="muted small">
          当前级别：{LEVEL[level].desc}。
          <Link to="/status">策略</Link>可能进一步限制。
        </div>
      </div>
    </Modal>
  );
}
