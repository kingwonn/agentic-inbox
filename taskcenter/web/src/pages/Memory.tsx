import { useState } from "react";
import { del, get, post, useApi } from "../api";
import { Badge, Button, Card, Empty, Loading, PageHeader } from "../components/ui";
import { fmtDateTime, relTime } from "../format";
import { MEMORY_KIND } from "../labels";
import { useLive } from "../sse";
import { useToast } from "../toast";
import type { ContextInfo, Memory as MemoryT, MemoryKind } from "../types";

const KINDS = Object.keys(MEMORY_KIND) as MemoryKind[];

export function Memory() {
  const toast = useToast();
  const ctx = useApi(() => get<ContextInfo>("/context"), []);
  useLive(["event"], (m) => {
    const e = m.data as { type?: string };
    if (e?.type === "memory") ctx.reload();
  });
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [content, setContent] = useState("");
  const [filter, setFilter] = useState<MemoryKind | "">("");
  const memories = (ctx.data?.memories ?? []).filter((m) => !filter || m.kind === filter);
  const counts = (ctx.data?.memories ?? []).reduce<Record<string, number>>((acc, m) => ((acc[m.kind] = (acc[m.kind] ?? 0) + 1), acc), {});

  const retire = async (m: MemoryT) => {
    const r = await toast.run(() => del(`/memories/${m.id}`), { ok: "已归档该记忆", fail: "操作失败" });
    if (r) ctx.reload();
  };
  const add = async () => {
    const text = content.trim();
    if (!text) return;
    const r = await toast.run(() => post("/memories", { kind, content: text }), { ok: "记忆已添加", fail: "添加失败" });
    if (r) {
      setContent("");
      ctx.reload();
    }
  };

  return (
    <div className="page">
      <PageHeader title="记忆与上下文 (Memory)" sub="Agent 在分诊、规划与执行时看到的个人档案 + 学到的事实" />
      {ctx.error ? <Loading error={ctx.error} retry={ctx.reload} /> : null}
      <div className="grid grid-main">
        <div className="stack">
          <Card
            title={`记忆 (${ctx.data?.memories.length ?? 0})`}
            actions={
              <div className="row" style={{ gap: 4 }}>
                <button className={`tab ${filter === "" ? "active" : ""}`} style={{ padding: "2px 8px" }} onClick={() => setFilter("")}>
                  全部
                </button>
                {KINDS.filter((k) => counts[k]).map((k) => (
                  <button key={k} className={`tab ${filter === k ? "active" : ""}`} style={{ padding: "2px 8px" }} onClick={() => setFilter(k)}>
                    {MEMORY_KIND[k]} {counts[k]}
                  </button>
                ))}
              </div>
            }
          >
            {!ctx.data ? (
              <Loading />
            ) : memories.length === 0 ? (
              <Empty icon="🧠">还没有记忆；执行任务后 Agent 会把学到的事实记录在这里</Empty>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {memories.map((m) => (
                  <div key={m.id} className="tree-item" style={{ alignItems: "flex-start" }}>
                    <Badge tone="info">{MEMORY_KIND[m.kind] ?? m.kind}</Badge>
                    <div className="grow">
                      <div>{m.content}</div>
                      <div className="muted small">
                        置信度 {Math.round(m.confidence * 100)}% · 来源 <span className="mono">{m.source}</span> · {relTime(m.updated_at)}
                        {m.tags.length ? (
                          <>
                            {" · "}
                            {m.tags.map((t) => (
                              <span key={t} className="tag">
                                {t}
                              </span>
                            ))}
                          </>
                        ) : null}
                      </div>
                    </div>
                    <Button size="sm" tone="ghost" title="归档（不再提供给 Agent）" onClick={() => retire(m)}>
                      归档
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="添加记忆">
            <div className="form">
              <div className="row">
                <select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {MEMORY_KIND[k]}
                    </option>
                  ))}
                </select>
                <input type="text" className="grow" placeholder="例如：周五下午不安排会议" value={content} onChange={(e) => setContent(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
                <Button tone="primary" disabled={!content.trim()} onClick={add}>
                  添加
                </Button>
              </div>
            </div>
          </Card>
        </div>
        <Card
          title="个人档案 (profile)"
          actions={ctx.data ? <span className="muted small mono">{ctx.data.profilePath}</span> : null}
        >
          {!ctx.data ? (
            <Loading />
          ) : !ctx.data.profileExists ? (
            <Empty>
              未找到 profile.yaml — 复制 config/profile.example.yaml 为 config/profile.yaml 并填写
            </Empty>
          ) : (
            <pre className="json" style={{ maxHeight: "70vh" }}>
              {ctx.data.profileText}
            </pre>
          )}
          {ctx.data ? (
            <div className="muted small mt">
              语言 {ctx.data.locale} · 时区 {ctx.data.timezone} · 读取于 {fmtDateTime(new Date().toISOString())}
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
