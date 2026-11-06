import { artifactDownloadUrl, get, useApi } from "../api";
import { Badge, Button, Drawer, Empty, JsonView, KV, Link, Loading, PageHeader, TextBlock } from "../components/ui";
import { bytes, fmtDateTime, relTime } from "../format";
import { ARTIFACT_TYPE } from "../labels";
import { navigate, useRoute } from "../router";
import { useLive } from "../sse";
import type { Artifact, Page, Task } from "../types";

export function Artifacts() {
  const route = useRoute();
  const selectedId = route.parts[1] ?? null;
  const list = useApi(() => get<Page<Artifact>>("/artifacts?limit=200"), []);
  const detail = useApi(() => (selectedId ? get<{ artifact: Artifact; task: Task | null; downloadable: boolean }>(`/artifacts/${selectedId}`) : Promise.resolve(undefined)), [selectedId]);
  useLive(["event"], (m) => {
    const e = m.data as { type?: string };
    if (e?.type === "artifact") list.reload();
  });
  const items = list.data?.items ?? [];
  return (
    <div className="page">
      <PageHeader title="交付物 (Artifacts)" sub="任务产出的文件、链接、草稿与文档" />
      {list.error ? <Loading error={list.error} retry={list.reload} /> : null}
      <div className="card">
        <div className="card-body flush table-wrap">
          {list.loading && !list.data ? (
            <Loading />
          ) : items.length === 0 ? (
            <Empty icon="📎">还没有交付物</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>标题</th>
                  <th className="hide-mobile">任务</th>
                  <th className="hide-mobile num">大小</th>
                  <th>创建</th>
                  <th className="actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} className={`clickable ${selectedId === a.id ? "selected" : ""}`} onClick={() => navigate(`/artifacts/${a.id}`)}>
                    <td>
                      <span title={ARTIFACT_TYPE[a.type]?.label ?? a.type}>
                        {ARTIFACT_TYPE[a.type]?.icon ?? "📄"} <span className="small muted">{ARTIFACT_TYPE[a.type]?.label ?? a.type}</span>
                      </span>
                    </td>
                    <td className="title-cell">
                      <div className="t">{a.title}</div>
                      {a.path ? <div className="s mono">{a.path}</div> : a.url ? <div className="s truncate">{a.url}</div> : null}
                    </td>
                    <td className="hide-mobile small">
                      <Link to={`/tasks/${a.task_id}`}>{a.task_title ?? a.task_id}</Link>
                    </td>
                    <td className="hide-mobile num small muted">{bytes(a.size)}</td>
                    <td className="small muted nowrap" title={fmtDateTime(a.created_at)}>
                      {relTime(a.created_at)}
                    </td>
                    <td className="actions" onClick={(e) => e.stopPropagation()}>
                      {a.url ? (
                        <a className="btn btn-sm btn-default" href={a.url} target="_blank" rel="noreferrer">
                          打开
                        </a>
                      ) : null}{" "}
                      {a.content || a.path ? (
                        <a className="btn btn-sm btn-default" href={artifactDownloadUrl(a.id)}>
                          下载
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <Drawer open={Boolean(selectedId)} onClose={() => navigate("/artifacts")} title={detail.data?.artifact.title ?? "交付物"} width={680}>
        {detail.loading && !detail.data ? <Loading /> : null}
        {detail.error ? <Loading error={detail.error} retry={detail.reload} /> : null}
        {detail.data ? <ArtifactPreview a={detail.data.artifact} task={detail.data.task} downloadable={detail.data.downloadable} /> : null}
      </Drawer>
    </div>
  );
}

function ArtifactPreview({ a, task, downloadable }: { a: Artifact; task: Task | null; downloadable: boolean }) {
  const isJson = a.mime?.includes("json");
  const isText = !a.mime || /^text\/|markdown|json|yaml|xml|csv/.test(a.mime);
  return (
    <div className="stack">
      <div className="row">
        <Badge>
          {ARTIFACT_TYPE[a.type]?.icon} {ARTIFACT_TYPE[a.type]?.label ?? a.type}
        </Badge>
        {a.mime ? <span className="muted small mono">{a.mime}</span> : null}
        {a.size !== null ? <span className="muted small">{bytes(a.size)}</span> : null}
      </div>
      <KV
        cols={1}
        items={[
          task ? ["任务", <Link to={`/tasks/${task.id}`}>{task.title}</Link>] : null,
          a.run_id ? ["运行", <Link to={`/runs/${a.run_id}`}>{a.run_id}</Link>] : null,
          a.path ? ["路径", <span className="mono small">{a.path}</span>] : null,
          a.url ? ["链接", <a href={a.url} target="_blank" rel="noreferrer">{a.url}</a>] : null,
          ["创建", fmtDateTime(a.created_at)],
        ]}
      />
      <div className="options">
        {a.url ? (
          <a className="btn btn-primary btn-md" href={a.url} target="_blank" rel="noreferrer">
            打开链接
          </a>
        ) : null}
        {a.content || downloadable ? (
          <a className="btn btn-default btn-md" href={artifactDownloadUrl(a.id)}>
            下载
          </a>
        ) : null}
        {a.path && !downloadable && !a.content ? <span className="muted small">文件不在可访问目录内，无法下载</span> : null}
      </div>
      {a.content ? (
        <div>
          <div className="muted small mb">预览</div>
          {isJson ? (
            <JsonView value={safeParse(a.content)} maxHeight={600} />
          ) : isText ? (
            <div className="card">
              <div className="card-body">
                <TextBlock text={a.content} />
              </div>
            </div>
          ) : (
            <pre className="json" style={{ maxHeight: 600 }}>
              {a.content}
            </pre>
          )}
        </div>
      ) : (
        <Button tone="ghost" disabled>
          无内联内容
        </Button>
      )}
    </div>
  );
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
