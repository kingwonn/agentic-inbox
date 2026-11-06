import { useMemo, useState } from "react";
import { post } from "../api";
import { fmtDateTime, pretty, relTime } from "../format";
import { APPROVAL_KIND, DECISION_LABEL, label } from "../labels";
import { useToast } from "../toast";
import type { Approval } from "../types";
import { ApprovalStatusBadge, Button, JsonView, Link, RiskBadge, TextBlock } from "./ui";

/** Renders the payload in the friendliest form: shell command, email, or JSON. */
export function PayloadView({ payload }: { payload: Record<string, unknown> }) {
  const tool = String(payload.tool ?? payload.name ?? "");
  const input = (payload.input ?? payload.args ?? payload) as Record<string, unknown>;
  if (typeof input.command === "string" && (tool === "Bash" || tool === "" || /bash|shell|exec/i.test(tool))) {
    return (
      <div className="stack">
        {tool ? <div className="muted small">工具：{tool}</div> : null}
        <div className="payload-cmd">{input.command}</div>
        {input.description ? <div className="muted small">{String(input.description)}</div> : null}
      </div>
    );
  }
  const to = input.to ?? input.recipient ?? input.recipients;
  if ((typeof input.subject === "string" || typeof input.body === "string") && (to !== undefined || /mail|email/i.test(tool))) {
    return (
      <div className="stack">
        {tool ? <div className="muted small">工具：{tool}</div> : null}
        <div className="payload-email">
          {to !== undefined ? (
            <div className="h">
              <b>收件人</b>
              <span>{Array.isArray(to) ? to.join(", ") : String(to)}</span>
            </div>
          ) : null}
          {input.cc ? (
            <div className="h">
              <b>抄送</b>
              <span>{Array.isArray(input.cc) ? input.cc.join(", ") : String(input.cc)}</span>
            </div>
          ) : null}
          {typeof input.subject === "string" ? (
            <div className="h">
              <b>主题</b>
              <span>{input.subject}</span>
            </div>
          ) : null}
          {typeof input.body === "string" ? <div className="b">{input.body}</div> : null}
        </div>
      </div>
    );
  }
  if (Object.keys(payload).length === 0) return <div className="muted small">（无载荷）</div>;
  return <JsonView value={payload} maxHeight={260} />;
}

export function ApprovalCard({ approval, compact = false, onDecided, showTask = true }: { approval: Approval; compact?: boolean; onDecided?: (a: Approval) => void; showTask?: boolean }) {
  const toast = useToast();
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(() => pretty(approval.payload));
  const [respond, setRespond] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const pending = approval.status === "pending";
  const options = useMemo(() => {
    const opts = approval.options?.length ? approval.options : [{ value: "approve", label: "批准" }, { value: "reject", label: "拒绝" }];
    return opts;
  }, [approval.options]);
  const hasEditOption = options.some((o) => o.value === "edit");
  const hasRespond = approval.kind === "question" || options.some((o) => o.value === "respond");

  const decide = async (decision: string, extra: { editedPayload?: Record<string, unknown>; note?: string } = {}) => {
    setBusy(decision);
    try {
      const r = await post<{ approval: Approval }>(`/approvals/${approval.id}/decide`, { decision, note: extra.note ?? (note || undefined), editedPayload: extra.editedPayload });
      toast.success(`已${label(DECISION_LABEL, decision)}：${approval.title}`);
      onDecided?.(r.approval);
    } catch (e) {
      toast.error(`决定失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const submitEdit = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(editText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("必须是 JSON 对象");
    } catch (e) {
      toast.error(`JSON 无效：${(e as Error).message}`);
      return;
    }
    await decide("edit", { editedPayload: parsed });
    setEditing(false);
  };

  const toneFor = (v: string) => (v === "approve" ? "success" : v === "reject" ? "danger" : v === "edit" ? "default" : "primary");

  if (compact) {
    return (
      <div className={`card approval risk-${approval.risk} ${pending ? "" : "decided"}`}>
        <div className="card-body stack" style={{ gap: 6 }}>
          <div className="row-between">
            <div className="row" style={{ gap: 6 }}>
              <RiskBadge r={approval.risk} />
              <span className="muted small">{label(APPROVAL_KIND, approval.kind)}</span>
              <span className="muted small">{relTime(approval.created_at)}</span>
            </div>
            <Link to="/outbox" className="small">
              详情
            </Link>
          </div>
          <div className="approval-title" style={{ fontSize: 13 }}>
            {approval.title}
          </div>
          {approval.recommendation ? <div className="small text-2 truncate">建议：{approval.recommendation}</div> : null}
          {pending ? (
            <div className="options">
              <Button size="sm" tone="success" busy={busy === "approve"} onClick={() => decide("approve")}>
                批准
              </Button>
              <Button size="sm" tone="danger" busy={busy === "reject"} onClick={() => decide("reject")}>
                拒绝
              </Button>
            </div>
          ) : (
            <ApprovalStatusBadge s={approval.status} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`card approval risk-${approval.risk} ${pending ? "" : "decided"}`}>
      <div className="card-body stack">
        <div className="row-between">
          <div className="row" style={{ gap: 6 }}>
            <RiskBadge r={approval.risk} />
            <span className="badge badge-neutral">{label(APPROVAL_KIND, approval.kind)}</span>
            <ApprovalStatusBadge s={approval.status} />
            <span className="muted small" title={fmtDateTime(approval.created_at)}>
              {relTime(approval.created_at)}
            </span>
            {approval.expires_at && pending ? <span className="muted small">· 过期 {relTime(approval.expires_at)}</span> : null}
          </div>
          <div className="row small muted" style={{ gap: 6 }}>
            {showTask && approval.task_id ? (
              <Link to={`/tasks/${approval.task_id}`} title={approval.task_title ?? approval.task_id}>
                任务：{approval.task_title ? approval.task_title.slice(0, 28) + (approval.task_title.length > 28 ? "…" : "") : approval.task_id}
              </Link>
            ) : null}
            {approval.run_id ? <Link to={`/runs/${approval.run_id}`}>运行</Link> : null}
          </div>
        </div>
        <div className="approval-title">{approval.title}</div>
        {approval.context ? <TextBlock text={approval.context} className="text-2" /> : null}
        {approval.recommendation ? (
          <div className="small" style={{ borderLeft: "2px solid var(--accent)", paddingLeft: 8 }}>
            <b>建议 (recommendation)</b>：{approval.recommendation}
          </div>
        ) : null}
        <div>
          <div className="muted small mb" style={{ marginBottom: 4 }}>
            载荷 (payload)
          </div>
          {editing ? (
            <div className="stack">
              <textarea className="mono" rows={10} value={editText} onChange={(e) => setEditText(e.target.value)} />
              <div className="options">
                <Button size="sm" tone="primary" busy={busy === "edit"} onClick={submitEdit}>
                  修改后批准
                </Button>
                <Button size="sm" tone="ghost" onClick={() => setEditing(false)}>
                  取消编辑
                </Button>
              </div>
            </div>
          ) : (
            <PayloadView payload={approval.status === "edited" && approval.edited_payload ? approval.edited_payload : approval.payload} />
          )}
          {approval.status === "edited" && approval.edited_payload ? <div className="muted small mt">（显示的是修改后的载荷）</div> : null}
        </div>
        {pending ? (
          <>
            <label className="small text-2">
              备注 (note)
              <input type="text" style={{ width: "100%", marginTop: 4 }} placeholder="可选：补充说明、修改要求…" value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            {hasRespond ? (
              <div className="row">
                <input type="text" className="grow" placeholder="回复内容…" value={respond} onChange={(e) => setRespond(e.target.value)} />
                <Button size="sm" tone="primary" disabled={!respond.trim()} busy={busy === "respond"} onClick={() => decide("respond", { note: respond })}>
                  回复
                </Button>
              </div>
            ) : null}
            <div className="options">
              {options
                .filter((o) => o.value !== "respond")
                .map((o) => (
                  <Button
                    key={o.value}
                    size="sm"
                    tone={toneFor(o.value) as "success"}
                    title={o.description}
                    busy={busy === o.value}
                    onClick={() => {
                      if (o.value === "edit") {
                        setEditing(true);
                        return;
                      }
                      return decide(o.value);
                    }}
                  >
                    {o.label || label(DECISION_LABEL, o.value)}
                  </Button>
                ))}
              {!hasEditOption && !editing ? (
                <Button size="sm" tone="ghost" onClick={() => setEditing(true)}>
                  编辑载荷
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <div className="small text-2">
            决定：<b>{label(DECISION_LABEL, approval.decision ?? "")}</b>
            {approval.decided_by ? ` · 由 ${approval.decided_by}` : ""} · {fmtDateTime(approval.decided_at)}
            {approval.decision_note ? <div className="muted">备注：{approval.decision_note}</div> : null}
          </div>
        )}
      </div>
    </div>
  );
}
