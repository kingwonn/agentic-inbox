import { useState } from "react";
import { get, useApi } from "../api";
import { ApprovalCard } from "../components/ApprovalCard";
import { Empty, Loading, PageHeader, Tabs } from "../components/ui";
import { useLive } from "../sse";
import type { Approval, Page } from "../types";

type Tab = "pending" | "history";

export function Outbox() {
  const [tab, setTab] = useState<Tab>("pending");
  const pending = useApi(() => get<Page<Approval>>("/approvals?status=pending&limit=100"), []);
  const history = useApi(() => get<Page<Approval>>("/approvals?status=approved,rejected,edited,expired,cancelled&limit=100"), []);
  useLive(["approval.requested", "approval.decided"], () => {
    pending.reload();
    history.reload();
  });
  const cur = tab === "pending" ? pending : history;
  return (
    <div className="page">
      <PageHeader title="待确认 (Outbox)" sub="Agent 请求你决定的动作、问题与审阅；每一项都附带建议与完整载荷" />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "pending", label: "待处理", count: pending.data?.items.length },
          { value: "history", label: "历史", count: history.data?.items.length },
        ]}
      />
      {cur.error ? <Loading error={cur.error} retry={cur.reload} /> : null}
      {cur.loading && !cur.data ? <Loading /> : null}
      {cur.data && cur.data.items.length === 0 ? <Empty icon="✓">{tab === "pending" ? "没有待确认事项，去喝杯咖啡吧" : "暂无历史记录"}</Empty> : null}
      <div className="stack" style={{ maxWidth: 860 }}>
        {cur.data?.items.map((a) => (
          <ApprovalCard
            key={a.id}
            approval={a}
            onDecided={() => {
              pending.reload();
              history.reload();
            }}
          />
        ))}
      </div>
    </div>
  );
}
