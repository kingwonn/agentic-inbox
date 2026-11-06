/**
 * Telegram inbound: long polling (getUpdates), allowlist, button callbacks and
 * text commands → InboundHandler. Offset is persisted in repo.meta so restarts
 * never replay updates. Network errors back off (2s → 60s); nothing here can
 * crash the daemon.
 */
import type { ChannelTelegramConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import type { Repo } from "../../core/repo.js";
import type { Approval } from "../../core/types.js";
import type { InboundHandler } from "../types.js";
import { parseCallbackData, statusLabel, type TelegramApi, TelegramApiError } from "../channels/telegram.js";

export const TELEGRAM_OFFSET_KEY = "telegram_update_offset";
const APPROVAL_ID_RE = /\bapr_[0-9a-z]{6,}\b/;

export type ParsedCommand =
  | { cmd: "approve" | "reject"; id: string; note?: string }
  | { cmd: "respond"; id: string; text: string }
  | { cmd: "edit"; id: string; json: Record<string, unknown> }
  | { cmd: "edit_invalid"; id?: string; error: string }
  | { cmd: "decide"; id: string; option: string; note?: string }
  | { cmd: "status" }
  | { cmd: "pending" }
  | { cmd: "capture"; text: string }
  | { cmd: "help" }
  | { cmd: "missing_id"; which: string }
  | { cmd: "text"; text: string }
  | { cmd: "unknown_command"; name: string };

const APPROVE_WORDS = new Set(["approve", "approved", "ok", "okay", "yes", "y", "go", "lgtm", "accept", "同意", "批准", "好", "好的", "可以", "通过", "确认", "是", "接受", "行"]);
const REJECT_WORDS = new Set(["reject", "rejected", "no", "n", "nope", "deny", "cancel", "stop", "拒绝", "否", "不", "不行", "取消", "驳回", "不要"]);

/** Pure parser for text commands. */
export function parseCommand(raw: string): ParsedCommand {
  const text = raw.trim();
  if (!text.startsWith("/")) return { cmd: "text", text };
  const m = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return { cmd: "text", text };
  const name = m[1].toLowerCase();
  const rest = (m[2] ?? "").trim();
  const [first, ...more] = rest.split(/\s+/);
  const idArg = first && APPROVAL_ID_RE.test(first) ? first : undefined;
  const tail = idArg ? rest.slice(first.length).trim() : rest;
  switch (name) {
    case "approve":
    case "ok":
    case "yes":
      if (!idArg) return { cmd: "missing_id", which: "approve" };
      return { cmd: "approve", id: idArg, note: tail || undefined };
    case "reject":
    case "no":
    case "deny":
      if (!idArg) return { cmd: "missing_id", which: "reject" };
      return { cmd: "reject", id: idArg, note: tail || undefined };
    case "respond":
    case "answer":
    case "reply":
      if (!idArg) return { cmd: "missing_id", which: "respond" };
      if (!tail) return { cmd: "missing_id", which: "respond_text" };
      return { cmd: "respond", id: idArg, text: tail };
    case "edit": {
      if (!idArg) return { cmd: "missing_id", which: "edit" };
      const jsonText = tail.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      if (!jsonText) return { cmd: "edit_invalid", id: idArg, error: "missing JSON" };
      try {
        const json = JSON.parse(jsonText);
        if (!json || typeof json !== "object" || Array.isArray(json)) return { cmd: "edit_invalid", id: idArg, error: "JSON must be an object" };
        return { cmd: "edit", id: idArg, json };
      } catch (e) {
        return { cmd: "edit_invalid", id: idArg, error: (e as Error).message };
      }
    }
    case "decide":
    case "choose":
    case "option": {
      if (!idArg) return { cmd: "missing_id", which: "decide" };
      const [option, ...noteParts] = tail.split(/\s+/);
      if (!option) return { cmd: "missing_id", which: "decide_option" };
      return { cmd: "decide", id: idArg, option, note: noteParts.join(" ") || undefined };
    }
    case "status":
      return { cmd: "status" };
    case "pending":
    case "outbox":
    case "list":
      return { cmd: "pending" };
    case "capture":
    case "add":
    case "todo":
    case "note":
      if (!rest) return { cmd: "missing_id", which: "capture" };
      return { cmd: "capture", text: rest };
    case "help":
    case "start":
      return { cmd: "help" };
    default:
      void more;
      return { cmd: "unknown_command", name };
  }
}

/** Classify a free-text reply to an approval message. */
export function classifyReply(text: string): { intent: "approve" | "reject" | "other"; note?: string } {
  const trimmed = text.trim();
  const first = trimmed.split(/\s+/)[0]?.replace(/[，,。.!！:：]+$/, "").toLowerCase() ?? "";
  const rest = trimmed.slice(trimmed.split(/\s+/)[0]?.length ?? 0).trim();
  if (APPROVE_WORDS.has(first)) return { intent: "approve", note: rest || undefined };
  if (REJECT_WORDS.has(first)) return { intent: "reject", note: rest || undefined };
  // Chinese replies often have no spaces: "同意，注意格式" / "拒绝：太贵了"
  for (const w of APPROVE_WORDS) if (w.length > 1 && /[一-鿿]/.test(w) && trimmed.startsWith(w)) return { intent: "approve", note: trimmed.slice(w.length).replace(/^[，,。.!！:：\s]+/, "") || undefined };
  for (const w of REJECT_WORDS) if (w.length > 1 && /[一-鿿]/.test(w) && trimmed.startsWith(w)) return { intent: "reject", note: trimmed.slice(w.length).replace(/^[，,。.!！:：\s]+/, "") || undefined };
  return { intent: "other" };
}

export function extractApprovalId(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return APPROVAL_ID_RE.exec(text)?.[0];
}

// ── Telegram update shapes (subset) ─────────────────────────────────

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}
export interface TgMessage {
  message_id: number;
  chat: { id: number | string; type?: string };
  from?: TgUser;
  text?: string;
  reply_to_message?: TgMessage;
}
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TelegramInboundDeps {
  repo: Repo;
  logger: Logger;
  handler: InboundHandler;
  locale?: string;
  /** Owning channel (used to retract keyboards). */
  channel?: { retractKeyboard(chatId: string | number, messageId: number, approval?: Approval): Promise<void> };
  /** Long-poll timeout in seconds (default 25). */
  pollTimeoutSec?: number;
  /** Backoff bounds in ms (defaults 2000 → 60000). */
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

const S = {
  "zh-CN": {
    help: [
      "可用命令：",
      "/approve <id> [备注] — 批准",
      "/reject <id> [理由] — 拒绝",
      "/edit <id> {json} — 修改 payload 后批准",
      "/respond <id> <回答> — 回答问题",
      "/decide <id> <选项> [备注] — 选择自定义选项（如 accept / request_changes）",
      "/pending — 待处理审批",
      "/status — 系统状态",
      "/capture <文本> — 记入 Inbox",
      "/help — 本帮助",
      "也可以直接回复审批消息：同意 / 拒绝 / 或点按钮。",
    ].join("\n"),
    missingId: (w: string) => `用法：/${w} <apr_id> …（id 可在审批消息里找到）`,
    missingText: "请提供回答内容：/respond <id> <回答>",
    missingOption: "请提供选项：/decide <id> <选项>",
    missingCapture: "用法：/capture <文本>",
    badJson: (e: string) => `JSON 无法解析：${e}\n用法：/edit <id> {"input":{...}}`,
    noPending: "没有待处理的审批。",
    pendingHead: (n: number) => `待处理审批 ${n} 条：`,
    unknownCmd: (n: string) => `未知命令 /${n}。发送 /help 查看帮助。`,
    notCommand: "这不是命令。想记入 Inbox 请用 /capture <文本>；查看帮助 /help。",
    captureUnavailable: "当前未启用 capture。",
    captured: "📝 已记入 Inbox。",
    replyUnclear: (id: string) => `没看懂。回复“同意”或“拒绝”，或使用 /respond ${id} <回答>。`,
    editHow: (id: string) => `请发送：/edit ${id} {"input":{...}}（仅需包含要修改的字段）`,
    respondHow: (id: string) => `请回复本消息或发送：/respond ${id} <你的回答>`,
    unauthorized: "unauthorized",
  },
  en: {
    help: [
      "Commands:",
      "/approve <id> [note] — approve",
      "/reject <id> [reason] — reject",
      "/edit <id> {json} — edit the payload, then approve",
      "/respond <id> <answer> — answer a question",
      "/decide <id> <option> [note] — pick a custom option (e.g. accept / request_changes)",
      "/pending — pending approvals",
      "/status — system status",
      "/capture <text> — add to the inbox",
      "/help — this help",
      "You can also reply to an approval message with yes/no, or tap a button.",
    ].join("\n"),
    missingId: (w: string) => `Usage: /${w} <apr_id> … (the id is in the approval message)`,
    missingText: "Provide the answer: /respond <id> <answer>",
    missingOption: "Provide an option: /decide <id> <option>",
    missingCapture: "Usage: /capture <text>",
    badJson: (e: string) => `Cannot parse JSON: ${e}\nUsage: /edit <id> {"input":{...}}`,
    noPending: "No pending approvals.",
    pendingHead: (n: number) => `${n} pending approval(s):`,
    unknownCmd: (n: string) => `Unknown command /${n}. Send /help.`,
    notCommand: "Not a command. Use /capture <text> to add this to the inbox, or /help.",
    captureUnavailable: "Capture is not enabled.",
    captured: "📝 Captured into the inbox.",
    replyUnclear: (id: string) => `Not sure what you mean. Reply "approve" or "reject", or use /respond ${id} <answer>.`,
    editHow: (id: string) => `Send: /edit ${id} {"input":{...}} (only the fields you want to change)`,
    respondHow: (id: string) => `Reply to this message or send: /respond ${id} <your answer>`,
    unauthorized: "unauthorized",
  },
} as const;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class TelegramInbound {
  private abort?: AbortController;
  private loop?: Promise<void>;
  private readonly logger: Logger;
  private readonly s: (typeof S)["en"] | (typeof S)["zh-CN"];
  private readonly zh: boolean;
  readonly seen = new Set<number>();

  constructor(
    private readonly cfg: ChannelTelegramConfig,
    private readonly api: TelegramApi,
    private readonly deps: TelegramInboundDeps,
  ) {
    this.logger = deps.logger.child("inbound");
    this.zh = (deps.locale ?? "en").toLowerCase().startsWith("zh");
    this.s = this.zh ? S["zh-CN"] : S.en;
  }

  get running(): boolean {
    return !!this.abort && !this.abort.signal.aborted;
  }

  async start(): Promise<void> {
    if (this.loop) return;
    this.abort = new AbortController();
    this.loop = this.runLoop(this.abort.signal).catch((e) => this.logger.error("poll loop died", e));
    this.logger.info("telegram polling started");
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    try {
      await this.loop;
    } catch {
      /* ignore */
    }
    this.loop = undefined;
    this.abort = undefined;
  }

  private loadOffset(): number | undefined {
    const v = this.deps.repo.meta.get(TELEGRAM_OFFSET_KEY);
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  }

  private saveOffset(updateId: number): void {
    try {
      this.deps.repo.meta.set(TELEGRAM_OFFSET_KEY, String(updateId + 1));
    } catch (e) {
      this.logger.warn("could not persist telegram offset", e);
    }
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    const minMs = this.deps.backoffMinMs ?? 2000;
    const maxMs = this.deps.backoffMaxMs ?? 60_000;
    const timeoutSec = this.deps.pollTimeoutSec ?? 25;
    let backoff = minMs;
    let offset = this.loadOffset();
    while (!signal.aborted) {
      let updates: TgUpdate[] = [];
      try {
        const reqSignal = AbortSignal.any([signal, AbortSignal.timeout((timeoutSec + 15) * 1000)]);
        updates = await this.api.call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, { signal: reqSignal });
        backoff = minMs;
      } catch (e) {
        if (signal.aborted) break;
        const err = e as Error;
        const retryAfter = e instanceof TelegramApiError && e.retryAfter ? e.retryAfter * 1000 : undefined;
        const wait = retryAfter ?? backoff;
        this.logger.warn(`getUpdates failed: ${err.message}; retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait, signal);
        backoff = Math.min(maxMs, backoff * 2);
        continue;
      }
      for (const u of updates) {
        if (signal.aborted) break;
        try {
          await this.handleUpdate(u);
        } catch (e) {
          this.logger.error(`update ${u.update_id} failed`, e);
        } finally {
          offset = u.update_id + 1;
          this.saveOffset(u.update_id);
        }
      }
    }
  }

  private allowed(chatId: number | string | undefined, from: TgUser | undefined): boolean {
    const chatOk = chatId !== undefined && String(chatId) === String(this.cfg.chat_id);
    const userOk = !!from && this.cfg.allowed_user_ids.map(String).includes(String(from.id));
    return chatOk || userOk;
  }

  /** Process one update (exported for tests). */
  async handleUpdate(u: TgUpdate): Promise<void> {
    if (this.seen.has(u.update_id)) return;
    this.seen.add(u.update_id);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value as number);
    if (u.callback_query) return this.handleCallback(u.callback_query);
    const msg = u.message ?? u.edited_message;
    if (msg) return this.handleMessage(msg);
  }

  private async reply(chatId: number | string, text: string, replyTo?: number): Promise<void> {
    try {
      await this.api.call("sendMessage", {
        chat_id: chatId,
        text: text.slice(0, 4000),
        reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      this.logger.warn(`reply failed: ${(e as Error).message}`);
    }
  }

  private async handleCallback(cq: TgCallbackQuery): Promise<void> {
    const chatId = cq.message?.chat.id;
    if (!this.allowed(chatId, cq.from)) {
      this.logger.warn(`ignoring callback from unauthorized user ${cq.from.id}`);
      await this.answer(cq.id, this.s.unauthorized);
      return;
    }
    const data = cq.data ?? "";
    if (data.startsWith("noop:")) return this.answer(cq.id, "");
    const parsed = parseCallbackData(data);
    if (!parsed) return this.answer(cq.id, "?");
    const by = whoIs(cq.from);
    let option = parsed.option;
    const approval = this.deps.repo.approvals.get(parsed.approvalId);
    if (option.startsWith("#")) {
      const idx = Number(option.slice(1));
      option = approval?.options[idx]?.value ?? option;
    }
    if (option === "edit") {
      await this.answer(cq.id, "✏️");
      if (chatId !== undefined) await this.reply(chatId, this.s.editHow(parsed.approvalId), cq.message?.message_id);
      return;
    }
    if (option === "respond") {
      await this.answer(cq.id, "💬");
      if (chatId !== undefined) await this.reply(chatId, this.s.respondHow(parsed.approvalId), cq.message?.message_id);
      return;
    }
    const res = await this.deps.handler.decide({ approvalId: parsed.approvalId, decision: option, decidedBy: by });
    await this.answer(cq.id, res.message.slice(0, 180));
    if (cq.message && chatId !== undefined) {
      const latest = this.deps.repo.approvals.get(parsed.approvalId);
      if (latest && latest.status !== "pending") await this.deps.channel?.retractKeyboard(chatId, cq.message.message_id, latest);
      await this.reply(chatId, res.message, cq.message.message_id);
    }
  }

  private async answer(callbackId: string, text: string): Promise<void> {
    try {
      await this.api.call("answerCallbackQuery", { callback_query_id: callbackId, text: text || undefined });
    } catch (e) {
      this.logger.debug(`answerCallbackQuery failed: ${(e as Error).message}`);
    }
  }

  private async handleMessage(m: TgMessage): Promise<void> {
    if (!m.text) return;
    if (!this.allowed(m.chat.id, m.from)) {
      this.logger.warn(`ignoring message from unauthorized chat ${m.chat.id} / user ${m.from?.id}`);
      return;
    }
    const by = whoIs(m.from);
    const chatId = m.chat.id;
    const text = m.text.trim();
    const say = (t: string) => this.reply(chatId, t, m.message_id);

    // Reply to an approval message with free text
    if (!text.startsWith("/") && m.reply_to_message) {
      const id = extractApprovalId(m.reply_to_message.text) ?? this.approvalIdForMessage(chatId, m.reply_to_message.message_id);
      if (id) {
        const approval = this.deps.repo.approvals.get(id);
        const cls = classifyReply(text);
        if (cls.intent === "approve" || cls.intent === "reject") {
          const res = await this.deps.handler.decide({ approvalId: id, decision: cls.intent, note: cls.note, decidedBy: by });
          await this.afterDecision(id, chatId, m.reply_to_message.message_id);
          return say(res.message);
        }
        if (approval?.kind === "question" || approval?.options.some((o) => o.value === "respond")) {
          const res = await this.deps.handler.decide({ approvalId: id, decision: "respond", note: text, decidedBy: by });
          await this.afterDecision(id, chatId, m.reply_to_message.message_id);
          return say(res.message);
        }
        return say(this.s.replyUnclear(id));
      }
    }

    const cmd = parseCommand(text);
    switch (cmd.cmd) {
      case "approve":
      case "reject": {
        const res = await this.deps.handler.decide({ approvalId: cmd.id, decision: cmd.cmd, note: cmd.note, decidedBy: by });
        await this.afterDecision(cmd.id, chatId);
        return say(res.message);
      }
      case "respond": {
        const res = await this.deps.handler.decide({ approvalId: cmd.id, decision: "respond", note: cmd.text, decidedBy: by });
        await this.afterDecision(cmd.id, chatId);
        return say(res.message);
      }
      case "edit": {
        const res = await this.deps.handler.decide({ approvalId: cmd.id, decision: "edit", editedPayload: cmd.json, decidedBy: by });
        await this.afterDecision(cmd.id, chatId);
        return say(res.message);
      }
      case "edit_invalid":
        return say(this.s.badJson(cmd.error));
      case "decide": {
        const res = await this.deps.handler.decide({ approvalId: cmd.id, decision: cmd.option, note: cmd.note, decidedBy: by });
        await this.afterDecision(cmd.id, chatId);
        return say(res.message);
      }
      case "status": {
        const txt = this.deps.handler.status ? await this.deps.handler.status() : "ok";
        return say(txt);
      }
      case "pending":
        return say(this.renderPending());
      case "capture": {
        if (!this.deps.handler.capture) return say(this.s.captureUnavailable);
        const res = await this.deps.handler.capture(cmd.text, by);
        return say(res.ok ? `${this.s.captured} ${res.message}`.trim() : `⚠️ ${res.message}`);
      }
      case "help":
        return say(this.s.help);
      case "missing_id":
        if (cmd.which === "respond_text") return say(this.s.missingText);
        if (cmd.which === "decide_option") return say(this.s.missingOption);
        if (cmd.which === "capture") return say(this.s.missingCapture);
        return say(this.s.missingId(cmd.which));
      case "unknown_command":
        return say(this.s.unknownCmd(cmd.name));
      case "text":
        return say(this.s.notCommand);
    }
  }

  private approvalIdForMessage(chatId: number | string, messageId: number): string | undefined {
    const ref = `${chatId}:${messageId}`;
    for (const a of this.deps.repo.approvals.list({ limit: 300 })) if (a.channel_refs?.telegram === ref) return a.id;
    return undefined;
  }

  private async afterDecision(approvalId: string, chatId: number | string, messageId?: number): Promise<void> {
    const a = this.deps.repo.approvals.get(approvalId);
    if (!a || a.status === "pending" || !this.deps.channel) return;
    const ref = a.channel_refs?.telegram;
    const mid = messageId ?? (ref && ref.startsWith(`${chatId}:`) ? Number(ref.split(":")[1]) : undefined);
    if (mid) await this.deps.channel.retractKeyboard(chatId, mid, a);
  }

  private renderPending(): string {
    const list = this.deps.repo.approvals.pending().slice(0, 15);
    if (!list.length) return this.s.noPending;
    const lines = [this.s.pendingHead(list.length)];
    for (const a of list) lines.push(`• ${a.id} [${a.kind}/${a.risk}] ${a.title.slice(0, 80)} — ${statusLabel(a, this.zh)}`);
    return lines.join("\n");
  }
}

function whoIs(u?: TgUser): string {
  if (!u) return "telegram";
  return `telegram:${u.username ? "@" + u.username : u.first_name ?? u.id}`;
}
