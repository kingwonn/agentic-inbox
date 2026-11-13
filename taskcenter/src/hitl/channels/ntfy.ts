/**
 * ntfy channel: JSON publish to the server root. Up to 3 actions: view (dashboard)
 * + http approve/reject against the Task Center API (needs a reachable public_url).
 */
import type { ChannelNtfyConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import type { Channel, NotifyMessage } from "../types.js";
import type { FetchLike } from "./telegram.js";

export const NTFY_PRIORITY: Record<NonNullable<NotifyMessage["priority"]>, number> = { low: 2, normal: 3, high: 4 };

const TAGS: Record<NotifyMessage["kind"], string[]> = {
  approval_requested: ["bell"],
  task_done: ["white_check_mark"],
  task_failed: ["x"],
  review_ready: ["eyes"],
  digest: ["newspaper"],
  budget_warning: ["moneybag", "warning"],
  info: ["information_source"],
};

export interface NtfyAction {
  action: "view" | "http" | "broadcast";
  label: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  clear?: boolean;
}

export interface NtfyChannelDeps {
  logger: Logger;
  publicUrl?: string;
  /** Task Center API token (config.server.token) for the http actions. */
  apiToken?: string;
  locale?: string;
  fetch?: FetchLike;
}

export function buildNtfyPayload(cfg: ChannelNtfyConfig, msg: NotifyMessage, deps: Omit<NtfyChannelDeps, "logger" | "fetch">): Record<string, unknown> {
  const zh = (deps.locale ?? "en").toLowerCase().startsWith("zh");
  const tags = [...(TAGS[msg.kind] ?? [])];
  if (msg.approval?.risk === "high") tags.push("rotating_light");
  const actions: NtfyAction[] = [];
  if (msg.url) actions.push({ action: "view", label: zh ? "打开" : "Open", url: msg.url });
  const api = deps.publicUrl?.replace(/\/+$/, "");
  if (msg.approval && msg.approval.status === "pending" && api) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (deps.apiToken) headers.Authorization = `Bearer ${deps.apiToken}`;
    const decideUrl = `${api}/api/approvals/${msg.approval.id}/decide`;
    const opts = msg.approval.options.map((o) => o.value);
    const approveValue = opts.includes("approve") ? "approve" : opts.includes("accept") ? "accept" : undefined;
    if (approveValue) actions.push({ action: "http", label: zh ? "批准" : "Approve", url: decideUrl, method: "POST", headers, body: JSON.stringify({ decision: approveValue }), clear: true });
    if (opts.includes("reject")) actions.push({ action: "http", label: zh ? "拒绝" : "Reject", url: decideUrl, method: "POST", headers, body: JSON.stringify({ decision: "reject" }), clear: true });
  }
  let message = msg.body;
  if (Buffer.byteLength(message) > 4000) message = Buffer.from(message).subarray(0, 3990).toString() + "\n…";
  return {
    topic: cfg.topic,
    title: msg.title.slice(0, 250),
    message,
    markdown: true,
    priority: NTFY_PRIORITY[msg.priority ?? "normal"],
    tags,
    ...(msg.url ? { click: msg.url } : {}),
    ...(actions.length ? { actions: actions.slice(0, 3) } : {}),
  };
}

export class NtfyChannel implements Channel {
  readonly name = "ntfy";
  constructor(
    readonly cfg: ChannelNtfyConfig,
    private readonly deps: NtfyChannelDeps,
  ) {}

  configured(): boolean {
    return !!(this.cfg.topic && this.cfg.server);
  }

  async send(msg: NotifyMessage): Promise<{ ok: boolean; externalRef?: string; error?: string }> {
    const f: FetchLike = this.deps.fetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.token) headers.Authorization = `Bearer ${this.cfg.token}`;
    const payload = buildNtfyPayload(this.cfg, msg, this.deps);
    try {
      const res = await f(this.cfg.server.replace(/\/+$/, "") + "/", { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: `ntfy HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      let id: string | undefined;
      try {
        const json = (await res.json()) as { id?: string };
        id = json.id;
      } catch {
        /* ignore */
      }
      return { ok: true, externalRef: id };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
