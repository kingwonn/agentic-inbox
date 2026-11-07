import { useEffect, useState } from "react";
import { get, post, qs, useApi } from "../api";
import { Badge, Button, Drawer, Empty, InboxStatusBadge, KV, KindBadge, LevelBadge, Link, Loading, Modal, PageHeader, PriorityBadge, Select, TextBlock } from "../components/ui";
import { fmtDateTime, isoAfterDays, relTime } from "../format";
import { CATEGORY, INBOX_KIND, INBOX_STATUS, LEVEL, PRIORITY, SOURCE, label } from "../labels";
import { navigate, useRoute } from "../router";
import { useLive } from "../sse";
import { useToast } from "../toast";
import type { InboxDetail, InboxItem, InboxKind, InboxStatus, Level, Page, Priority, Task } from "../types";

const STATUS_OPTIONS = (Object.keys(INBOX_STATUS) as InboxStatus[]).map((v) => ({ value: v, label: INBOX_STATUS[v] }));
const KIND_OPTIONS = (Object.keys(INBOX_KIND) as InboxKind[]).map((v) => ({ value: v, label: INBOX_KIND[v] }));

export function Inbox() {
  const route = useRoute();
  const toast = useToast();
  const selectedId = route.parts[1] ?? null;
  const [status, setStatus] = useState<InboxStatus | "">((route.query.get("status") as InboxStatus) || "new");
  const [kind, setKind] = useState<InboxKind | "">("");
  const list = useApi(() => get<Page<InboxItem>>(`/inbox${qs({ status: status || undefined, limit: 200 })}`), [status]);
  const detail = useApi(() => (selectedId ? get<InboxDetail>(`/inbox/${selectedId}`) : Promise.resolve(undefined)), [selectedId]);
  useLive(["inbox.changed", "signal.new", "task.changed"], () => {
    list.reload();
    if (selectedId) detail.reload();
  });
  const [promoteFor, setPromoteFor] = useState<InboxItem | null>(null);

  const items = (list.data?.items ?? []).filter((i) => !kind || i.kind === kind);

  const act = async (item: InboxItem, action: "dismiss" | "done" | "snooze", body?: unknown, okMsg?: string) => {
    await toast.run(() => post(`/inbox/${item.id}/${action}`, body), { ok: okMsg ?? "已更新", fail: "操作失败" });
    list.reload();
    if (selectedId === item.id) detail.reload();
  };
  const promote = async (item: InboxItem, overrides?: Record<string, unknown>) => {
    const r = await toast.run(() => post<{ task: Task }>(`/inbox/${item.id}/promote`, { overrides }), { ok: "已提升为任务", fail: "提升失败" });
    setPromoteFor(null);
    list.reload();
    if (r) navigate(`/tasks/${r.task.id}`);
  };

  return (
    <div className="page">
      <PageHeader title="收件箱 (Inbox)" sub="传感器采集并经分诊的事项；提升为任务后进入执行流程" />
      <div className="toolbar">
        <Select value={status} onChange={(v) => setStatus(v)} options={STATUS_OPTIONS} allLabel="全部状态" />
        <Select value={kind} onChange={(v) => setKind(v)} options={KIND_OPTIONS} allLabel="全部类型" />
        <span className="muted small">{items.length} 项</span>
        <span className="spacer" />
        <CaptureButton onDone={() => list.reload()} />
      </div>
      {list.error ? <Loading error={list.error} retry={list.reload} /> : null}
      <div className="card">
        <div className="card-body flush table-wrap">
          {list.loading && !list.data ? (
            <Loading />
          ) : items.length === 0 ? (
            <Empty icon="📭">收件箱为空</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>优先级</th>
                  <th>级别</th>
                  <th>标题 / 摘要</th>
                  <th className="hide-mobile">来源</th>
                  <th className="hide-mobile">建议动作</th>
                  <th>状态</th>
                  <th className="actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className={`clickable ${selectedId === item.id ? "selected" : ""}`} onClick={() => navigate(`/inbox/${item.id}`)}>
                    <td>
                      <KindBadge k={item.kind} />
                    </td>
                    <td>
                      <PriorityBadge p={item.priority} />
                    </td>
                    <td>
                      <LevelBadge level={item.level} proposed={item.level_proposed} reason={item.level_reason} />
                    </td>
                    <td className="title-cell">
                      <div className="t">{item.title}</div>
                      <div className="s">{item.summary}</div>
                    </td>
                    <td className="hide-mobile small muted nowrap">
                      {item.source_signal_ids.length} 信号 · {label(CATEGORY, item.category)}
                      <div title={fmtDateTime(item.created_at)}>{relTime(item.created_at)}</div>
                    </td>
                    <td className="hide-mobile small" style={{ maxWidth: 220 }}>
                      {item.suggested_action}
                    </td>
                    <td>
                      <InboxStatusBadge s={item.status} />
                      {item.status === "snoozed" && item.snoozed_until ? <div className="muted small">{relTime(item.snoozed_until)}</div> : null}
                      {item.task_id ? (
                        <div className="small">
                          <Link to={`/tasks/${item.task_id}`}>任务 →</Link>
                        </div>
                      ) : null}
                    </td>
                    <td className="actions" onClick={(e) => e.stopPropagation()}>
                      <RowActions item={item} onPromote={() => setPromoteFor(item)} onAct={act} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Drawer open={Boolean(selectedId)} onClose={() => navigate("/inbox")} title={detail.data?.item.title ?? "事项详情"} width={600}>
        {detail.loading && !detail.data ? <Loading /> : null}
        {detail.error ? <Loading error={detail.error} retry={detail.reload} /> : null}
        {detail.data ? <InboxDetailView d={detail.data} onPromote={() => setPromoteFor(detail.data!.item)} onAct={act} /> : null}
      </Drawer>

      <PromoteModal item={promoteFor} onClose={() => setPromoteFor(null)} onSubmit={(ov) => promoteFor && promote(promoteFor, ov)} />
    </div>
  );
}

function RowActions({ item, onPromote, onAct }: { item: InboxItem; onPromote: () => void; onAct: (item: InboxItem, action: "dismiss" | "done" | "snooze", body?: unknown, ok?: string) => Promise<void> }) {
  const open = item.status === "new" || item.status === "triaged" || item.status === "snoozed";
  if (!open) return <span className="muted small">—</span>;
  return (
    <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
      <Button size="sm" tone="primary" onClick={onPromote} title="提升为任务 (promote)">
        提升
      </Button>
      <Button size="sm" onClick={() => onAct(item, "snooze", { until: isoAfterDays(1) }, "已推迟 1 天")} title="稍后 1 天 (snooze)">
        稍后
      </Button>
      <Button size="sm" onClick={() => onAct(item, "done", undefined, "已标记完成")} title="完成 (done)">
        完成
      </Button>
      <Button size="sm" tone="ghost" onClick={() => onAct(item, "dismiss", { reason: "dashboard" }, "已忽略")} title="忽略 (dismiss)">
        忽略
      </Button>
    </div>
  );
}

function InboxDetailView({ d, onPromote, onAct }: { d: InboxDetail; onPromote: () => void; onAct: (item: InboxItem, action: "dismiss" | "done" | "snooze", body?: unknown, ok?: string) => Promise<void> }) {
  const { item, signals, task } = d;
  const open = item.status === "new" || item.status === "triaged" || item.status === "snoozed";
  return (
    <div className="stack">
      <div className="row">
        <KindBadge k={item.kind} />
        <PriorityBadge p={item.priority} />
        <LevelBadge level={item.level} proposed={item.level_proposed} reason={item.level_reason} />
        <InboxStatusBadge s={item.status} />
        <span className="muted small">置信度 {Math.round(item.confidence * 100)}%</span>
      </div>
      <TextBlock text={item.summary} />
      <KV
        cols={1}
        items={[
          ["建议动作", item.suggested_action || "—"],
          ["级别说明", `${LEVEL[item.level].name}：${item.level_reason || "—"}${item.level_proposed !== item.level ? `（模型建议 L${item.level_proposed}）` : ""}`],
          ["分类", label(CATEGORY, item.category)],
          ["标签", item.tags.length ? item.tags.map((t) => <span key={t} className="tag">{t}</span>) : "—"],
          ["创建", fmtDateTime(item.created_at)],
          item.snoozed_until ? ["推迟至", fmtDateTime(item.snoozed_until)] : null,
          task ? ["任务", <Link to={`/tasks/${task.id}`}>{task.title}</Link>] : null,
        ]}
      />
      {open ? (
        <div className="options">
          <Button tone="primary" onClick={onPromote}>
            提升为任务
          </Button>
          <Button onClick={() => onAct(item, "snooze", { until: isoAfterDays(1) }, "已推迟 1 天")}>稍后 1 天</Button>
          <Button onClick={() => onAct(item, "snooze", { until: isoAfterDays(3) }, "已推迟 3 天")}>3 天</Button>
          <Button onClick={() => onAct(item, "snooze", { until: isoAfterDays(7) }, "已推迟 7 天")}>7 天</Button>
          <Button onClick={() => onAct(item, "done", undefined, "已标记完成")}>完成</Button>
          <Button tone="danger" onClick={() => onAct(item, "dismiss", { reason: "dashboard" }, "已忽略")}>
            忽略
          </Button>
        </div>
      ) : null}
      <h2>来源信号 ({signals.length})</h2>
      {signals.length === 0 ? <Empty>无关联信号</Empty> : null}
      {signals.map((s) => (
        <div key={s.id} className="card">
          <div className="card-body stack" style={{ gap: 6 }}>
            <div className="row-between">
              <div className="row" style={{ gap: 6 }}>
                <Badge tone="info">{label(SOURCE, s.source)}</Badge>
                <span className="muted small">{s.kind}</span>
                {s.actor ? <span className="muted small">· {s.actor}</span> : null}
              </div>
              <span className="muted small" title={s.occurred_at}>
                {relTime(s.occurred_at)}
              </span>
            </div>
            <div style={{ fontWeight: 500 }}>{s.title}</div>
            {s.url ? (
              <a href={s.url} target="_blank" rel="noreferrer" className="small truncate">
                {s.url}
              </a>
            ) : null}
            {s.body ? <TextBlock text={s.body} className="small text-2" /> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function PromoteModal({ item, onClose, onSubmit }: { item: InboxItem | null; onClose: () => void; onSubmit: (overrides?: Record<string, unknown>) => void }) {
  const [level, setLevel] = useState<Level>(item?.level ?? 2);
  const [priority, setPriority] = useState<Priority>(item?.priority ?? "P2");
  const [title, setTitle] = useState(item?.title ?? "");
  const [ready, setReady] = useState(true);
  useEffect(() => {
    if (item) {
      setLevel(item.level);
      setPriority(item.priority);
      setTitle(item.title);
      setReady(true);
    }
  }, [item]);
  if (!item) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title="提升为任务 (Promote)"
      footer={
        <>
          <Button tone="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            tone="primary"
            onClick={() => {
              const ov: Record<string, unknown> = {};
              if (level !== item.level) ov.level = level;
              if (priority !== item.priority) ov.priority = priority;
              if (title.trim() && title.trim() !== item.title) ov.title = title.trim();
              if (ready) ov.status = "ready";
              onSubmit(Object.keys(ov).length ? ov : undefined);
            }}
          >
            创建任务
          </Button>
        </>
      }
    >
      <div className="form">
        <label>
          标题
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="form-row">
          <label>
            自主级别 (level)
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
        </div>
        <div className="muted small">{LEVEL[level].desc}</div>
        <label className="row" style={{ display: "flex" }}>
          <input type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} style={{ minHeight: 0 }} /> 立即就绪（执行器可以开始运行）
        </label>
      </div>
    </Modal>
  );
}

function CaptureButton({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const toast = useToast();
  return (
    <>
      <Button onClick={() => setOpen(true)}>＋ 记一条</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="快速记录 (Capture)"
        footer={
          <>
            <Button tone="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              tone="primary"
              disabled={!text.trim()}
              onClick={async () => {
                const r = await toast.run(() => post("/capture", { text: text.trim(), url: url.trim() || undefined }), { ok: "已记录，等待分诊", fail: "记录失败" });
                if (r) {
                  setOpen(false);
                  setText("");
                  setUrl("");
                  onDone();
                }
              }}
            >
              记录
            </Button>
          </>
        }
      >
        <div className="form">
          <label>
            内容
            <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="想到什么就记下来，下次分诊会把它变成收件箱事项…" />
          </label>
          <label>
            链接（可选）
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
          </label>
        </div>
      </Modal>
    </>
  );
}
