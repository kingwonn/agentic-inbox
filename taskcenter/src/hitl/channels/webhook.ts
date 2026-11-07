/** Generic webhook channel: POST JSON {kind, title, body, url?, priority, approval?, task?, sent_at}. */
import type { Logger } from "../../core/logger.js";
import type { Channel, NotifyMessage } from "../types.js";
import type { FetchLike } from "./telegram.js";

export interface WebhookChannelDeps {
  logger: Logger;
  fetch?: FetchLike;
}

export function buildWebhookPayload(msg: NotifyMessage): Record<string, unknown> {
  return {
    kind: msg.kind,
    title: msg.title,
    body: msg.body,
    url: msg.url ?? null,
    priority: msg.priority ?? "normal",
    approval: msg.approval ?? null,
    task: msg.task ?? null,
    sent_at: new Date().toISOString(),
  };
}

export class WebhookChannel implements Channel {
  readonly name = "webhook";
  constructor(
    readonly cfg: { enabled: boolean; url: string },
    private readonly deps: WebhookChannelDeps,
  ) {}

  configured(): boolean {
    return /^https?:\/\//.test(this.cfg.url);
  }

  async send(msg: NotifyMessage): Promise<{ ok: boolean; externalRef?: string; error?: string }> {
    const f: FetchLike = this.deps.fetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
    try {
      const res = await f(this.cfg.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "taskcenter-notifier" },
        body: JSON.stringify(buildWebhookPayload(msg)),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { ok: false, error: `webhook HTTP ${res.status}` };
      return { ok: true, externalRef: String(res.status) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
