/**
 * Telegram Bot API channel (plain fetch, no library). Sends HTML messages with an
 * inline keyboard for pending approvals; retracts the keyboard once decided.
 * Inbound (long polling) lives in ../inbound/telegram.ts.
 */
import type { ChannelTelegramConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import type { Repo } from "../../core/repo.js";
import type { Approval, ApprovalOption } from "../../core/types.js";
import { TelegramInbound } from "../inbound/telegram.js";
import type { Channel, InboundHandler, NotifyMessage } from "../types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const TELEGRAM_TEXT_LIMIT = 4096;
export const CALLBACK_DATA_LIMIT = 64;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Build callback_data `d:<approvalId>:<option>` within 64 bytes; falls back to an option index `#i`. */
export function callbackData(approvalId: string, option: string, index: number): string {
  const direct = `d:${approvalId}:${option}`;
  if (Buffer.byteLength(direct) <= CALLBACK_DATA_LIMIT && /^[A-Za-z0-9_.-]+$/.test(option)) return direct;
  return `d:${approvalId}:#${index}`;
}

export function parseCallbackData(data: string): { approvalId: string; option: string } | undefined {
  const m = /^d:([A-Za-z0-9_]+):(.+)$/.exec(data);
  if (!m) return undefined;
  return { approvalId: m[1], option: m[2] };
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export function approvalKeyboard(a: Approval, locale: string, url?: string): { inline_keyboard: InlineKeyboardButton[][] } {
  const zh = locale.toLowerCase().startsWith("zh");
  const emoji: Record<string, string> = { approve: "✅", accept: "✅", edit: "✏️", reject: "❌", respond: "💬", request_changes: "🔁" };
  const zhLabel: Record<string, string> = { approve: "批准", accept: "接受", edit: "修改", reject: "拒绝", respond: "回答", request_changes: "要求修改" };
  const row: InlineKeyboardButton[] = a.options.map((o: ApprovalOption, i) => ({
    text: `${emoji[o.value] ?? "•"} ${zh ? (zhLabel[o.value] ?? o.label ?? o.value) : o.label || o.value}`.slice(0, 40),
    callback_data: callbackData(a.id, o.value, i),
  }));
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < row.length; i += 3) rows.push(row.slice(i, i + 3));
  if (url) rows.push([{ text: zh ? "🔗 打开看板" : "🔗 Open dashboard", url }]);
  return { inline_keyboard: rows };
}

/** Plain-text title/body → Telegram HTML (bold title, monospace command lines). */
export function toTelegramHtml(title: string, body: string): string {
  const lines = body.split("\n").map((l) => {
    if (l.startsWith("$ ")) return `<code>${escapeHtml(l)}</code>`;
    return escapeHtml(l);
  });
  let text = `<b>${escapeHtml(title)}</b>\n\n${lines.join("\n")}`;
  if (text.length > TELEGRAM_TEXT_LIMIT) text = text.slice(0, TELEGRAM_TEXT_LIMIT - 20) + "\n…";
  return text;
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`telegram ${method} failed (${status}): ${description}`);
    this.name = "TelegramApiError";
  }
}

/** Minimal Bot API client. `fetch` is resolved lazily so tests can stub globalThis.fetch. */
export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl?: FetchLike,
  ) {}

  async call<T = unknown>(method: string, body: Record<string, unknown>, init: { signal?: AbortSignal } = {}): Promise<T> {
    const f: FetchLike = this.fetchImpl ?? ((globalThis as unknown as { fetch: FetchLike }).fetch);
    const res = await f(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: init.signal,
    });
    let json: { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } } = {};
    try {
      json = (await res.json()) as typeof json;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok || !json.ok) throw new TelegramApiError(method, res.status, json.description ?? `HTTP ${res.status}`, json.parameters?.retry_after);
    return json.result as T;
  }
}

export interface TelegramChannelDeps {
  logger: Logger;
  repo: Repo;
  locale?: string;
  fetch?: FetchLike;
}

export class TelegramChannel implements Channel {
  readonly name = "telegram";
  readonly api: TelegramApi;
  private inbound?: TelegramInbound;
  private readonly logger: Logger;

  constructor(
    readonly cfg: ChannelTelegramConfig,
    private readonly deps: TelegramChannelDeps,
  ) {
    this.api = new TelegramApi(cfg.bot_token, deps.fetch);
    this.logger = deps.logger.child("telegram");
  }

  configured(): boolean {
    return !!(this.cfg.bot_token && this.cfg.chat_id);
  }

  async send(msg: NotifyMessage): Promise<{ ok: boolean; externalRef?: string; error?: string }> {
    const text = toTelegramHtml(msg.title, msg.body);
    const body: Record<string, unknown> = {
      chat_id: this.cfg.chat_id,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      disable_notification: msg.priority === "low",
    };
    if (msg.approval && msg.approval.status === "pending") body.reply_markup = approvalKeyboard(msg.approval, this.deps.locale ?? "en", msg.url);
    else if (msg.url) body.reply_markup = { inline_keyboard: [[{ text: "🔗 Open", url: msg.url }]] };
    try {
      const r = await this.api.call<{ message_id: number; chat: { id: number | string } }>("sendMessage", body);
      return { ok: true, externalRef: `${r.chat?.id ?? this.cfg.chat_id}:${r.message_id}` };
    } catch (e) {
      // HTML parse errors: retry without parse_mode
      if (e instanceof TelegramApiError && /parse/i.test(e.description)) {
        try {
          const r = await this.api.call<{ message_id: number; chat: { id: number | string } }>("sendMessage", { ...body, text: `${msg.title}\n\n${msg.body}`.slice(0, TELEGRAM_TEXT_LIMIT), parse_mode: undefined });
          return { ok: true, externalRef: `${r.chat?.id ?? this.cfg.chat_id}:${r.message_id}` };
        } catch (e2) {
          return { ok: false, error: (e2 as Error).message };
        }
      }
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Remove the inline keyboard from the approval's message (idempotent; ignores "not modified"). */
  async onDecided(approval: Approval): Promise<void> {
    const ref = approval.channel_refs?.telegram;
    if (!ref) return;
    const [chatId, messageId] = ref.split(":");
    if (!chatId || !messageId) return;
    await this.retractKeyboard(chatId, Number(messageId), approval);
  }

  async retractKeyboard(chatId: string | number, messageId: number, approval?: Approval): Promise<void> {
    try {
      const zh = (this.deps.locale ?? "en").toLowerCase().startsWith("zh");
      const status = approval ? statusLabel(approval, zh) : undefined;
      const markup = status ? { inline_keyboard: [[{ text: status, callback_data: `noop:${approval!.id}` }]] } : { inline_keyboard: [] };
      await this.api.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: markup });
    } catch (e) {
      if (e instanceof TelegramApiError && /not modified|message to edit not found/i.test(e.description)) return;
      this.logger.debug(`editMessageReplyMarkup failed: ${(e as Error).message}`);
    }
  }

  async start(handler: InboundHandler): Promise<void> {
    if (!this.configured() || !this.cfg.poll) return;
    if (this.inbound) return;
    this.inbound = new TelegramInbound(this.cfg, this.api, { repo: this.deps.repo, logger: this.logger, handler, locale: this.deps.locale ?? "en", channel: this });
    await this.inbound.start();
  }

  async stop(): Promise<void> {
    await this.inbound?.stop();
    this.inbound = undefined;
  }
}

export function statusLabel(a: Approval, zh: boolean): string {
  const map: Record<string, [string, string]> = {
    approved: ["✅ 已批准", "✅ Approved"],
    edited: ["✏️ 已修改并批准", "✏️ Edited & approved"],
    rejected: ["❌ 已拒绝", "❌ Rejected"],
    expired: ["⌛ 已过期", "⌛ Expired"],
    cancelled: ["🚫 已取消", "🚫 Cancelled"],
    pending: ["⏳ 待处理", "⏳ Pending"],
  };
  const pair = map[a.status] ?? [a.status, a.status];
  const extra = a.decision && !["approve", "reject", "edit"].includes(a.decision) ? ` (${a.decision})` : "";
  return (zh ? pair[0] : pair[1]) + extra;
}
