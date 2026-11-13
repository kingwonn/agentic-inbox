import { afterEach, describe, expect, it, vi } from "vitest";
import { createApprovalService, createInboundHandler } from "../src/hitl/approvals.js";
import { TelegramChannel, callbackData, parseCallbackData, approvalKeyboard, toTelegramHtml, escapeHtml } from "../src/hitl/channels/telegram.js";
import { TelegramInbound, parseCommand, classifyReply, extractApprovalId, TELEGRAM_OFFSET_KEY } from "../src/hitl/inbound/telegram.js";
import type { InboundDecision, InboundHandler } from "../src/hitl/types.js";
import { cfg, fakeApproval, fetchStub, mem, tick } from "./hitl-helpers.js";

const tg = { enabled: true, bot_token: "123:abc", chat_id: "42", allowed_user_ids: ["7"], poll: true };

describe("telegram parsing", () => {
  it("parses commands", () => {
    expect(parseCommand("/approve apr_abc123 looks good")).toEqual({ cmd: "approve", id: "apr_abc123", note: "looks good" });
    expect(parseCommand("/approve@tc_bot apr_abc123")).toEqual({ cmd: "approve", id: "apr_abc123", note: undefined });
    expect(parseCommand("/reject apr_abc123")).toEqual({ cmd: "reject", id: "apr_abc123", note: undefined });
    expect(parseCommand("/respond apr_abc123 use main")).toEqual({ cmd: "respond", id: "apr_abc123", text: "use main" });
    expect(parseCommand("/respond apr_abc123")).toEqual({ cmd: "missing_id", which: "respond_text" });
    expect(parseCommand('/edit apr_abc123 {"input":{"command":"ls"}}')).toEqual({ cmd: "edit", id: "apr_abc123", json: { input: { command: "ls" } } });
    expect(parseCommand("/edit apr_abc123 {nope")).toMatchObject({ cmd: "edit_invalid", id: "apr_abc123" });
    expect(parseCommand("/edit apr_abc123 [1]")).toMatchObject({ cmd: "edit_invalid" });
    expect(parseCommand("/decide apr_abc123 request_changes add tests")).toEqual({ cmd: "decide", id: "apr_abc123", option: "request_changes", note: "add tests" });
    expect(parseCommand("/approve")).toEqual({ cmd: "missing_id", which: "approve" });
    expect(parseCommand("/status")).toEqual({ cmd: "status" });
    expect(parseCommand("/pending")).toEqual({ cmd: "pending" });
    expect(parseCommand("/capture call the bank tomorrow")).toEqual({ cmd: "capture", text: "call the bank tomorrow" });
    expect(parseCommand("/help")).toEqual({ cmd: "help" });
    expect(parseCommand("/start")).toEqual({ cmd: "help" });
    expect(parseCommand("/frobnicate x")).toEqual({ cmd: "unknown_command", name: "frobnicate" });
    expect(parseCommand("hello there")).toEqual({ cmd: "text", text: "hello there" });
  });

  it("classifies free-text replies", () => {
    expect(classifyReply("yes")).toEqual({ intent: "approve", note: undefined });
    expect(classifyReply("OK, but keep it short")).toEqual({ intent: "approve", note: "but keep it short" });
    expect(classifyReply("no too risky")).toEqual({ intent: "reject", note: "too risky" });
    expect(classifyReply("同意，注意格式")).toEqual({ intent: "approve", note: "注意格式" });
    expect(classifyReply("拒绝：太贵了")).toEqual({ intent: "reject", note: "太贵了" });
    expect(classifyReply("use the main branch")).toEqual({ intent: "other" });
    expect(extractApprovalId("🔴 Approval · apr_0abc12345 · foo")).toBe("apr_0abc12345");
  });

  it("builds callback data within 64 bytes and keyboards", () => {
    const id = "apr_000000000abcdefgh";
    expect(callbackData(id, "approve", 0)).toBe(`d:${id}:approve`);
    const long = "x".repeat(80);
    expect(callbackData(id, long, 3)).toBe(`d:${id}:#3`);
    expect(callbackData(id, "has space", 1)).toBe(`d:${id}:#1`);
    expect(parseCallbackData(`d:${id}:#3`)).toEqual({ approvalId: id, option: "#3" });
    expect(parseCallbackData("garbage")).toBeUndefined();
    const kb = approvalKeyboard(fakeApproval(), "zh-CN", "http://tc.local/#/outbox/x");
    expect(kb.inline_keyboard[0].map((b) => b.text)).toEqual(["✅ 批准", "✏️ 修改", "❌ 拒绝"]);
    expect(kb.inline_keyboard[1][0].url).toBe("http://tc.local/#/outbox/x");
    for (const row of kb.inline_keyboard) for (const b of row) if (b.callback_data) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });

  it("escapes HTML", () => {
    expect(escapeHtml("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
    const html = toTelegramHtml("T <1>", "line\n$ rm -rf <dir>");
    expect(html).toBe("<b>T &lt;1&gt;</b>\n\nline\n<code>$ rm -rf &lt;dir&gt;</code>");
  });
});

describe("telegram channel send", () => {
  it("posts sendMessage with HTML + keyboard and returns chat:message ref", async () => {
    const ctx = mem();
    const { fn, calls } = fetchStub(({ url }) => {
      if (url.endsWith("/sendMessage")) return { ok: true, result: { message_id: 99, chat: { id: 42 } } };
      return { ok: true, result: true };
    });
    const ch = new TelegramChannel(tg, { logger: ctx.logger, repo: ctx.repo, locale: "en", fetch: fn as any });
    expect(ch.configured()).toBe(true);
    const a = fakeApproval();
    const r = await ch.send({ kind: "approval_requested", title: "T", body: "B", approval: a, url: "http://x/#/outbox/" + a.id, priority: "high" });
    expect(r).toEqual({ ok: true, externalRef: "42:99" });
    expect(calls[0].url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(calls[0].body.parse_mode).toBe("HTML");
    expect(calls[0].body.chat_id).toBe("42");
    expect(calls[0].body.reply_markup.inline_keyboard[0][0].callback_data).toBe(`d:${a.id}:approve`);
    await ch.onDecided({ ...a, status: "approved", decision: "approve", channel_refs: { telegram: "42:99" } });
    const edit = calls.find((c) => c.url.endsWith("/editMessageReplyMarkup"))!;
    expect(edit.body).toMatchObject({ chat_id: "42", message_id: 99 });
    expect(edit.body.reply_markup.inline_keyboard[0][0].text).toBe("✅ Approved");
    expect(new TelegramChannel({ ...tg, chat_id: "" }, { logger: ctx.logger, repo: ctx.repo }).configured()).toBe(false);
  });

  it("falls back to plain text when Telegram rejects the HTML", async () => {
    const ctx = mem();
    let n = 0;
    const { fn, calls } = fetchStub(() => {
      n++;
      if (n === 1) return new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), { status: 400 });
      return { ok: true, result: { message_id: 5, chat: { id: 42 } } };
    });
    const ch = new TelegramChannel(tg, { logger: ctx.logger, repo: ctx.repo, fetch: fn as any });
    const r = await ch.send({ kind: "info", title: "T", body: "B" });
    expect(r.ok).toBe(true);
    expect(calls[1].body.parse_mode).toBeUndefined();
  });
});

describe("telegram inbound polling (mocked fetch)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("polls getUpdates, applies allowlist, routes commands/buttons/replies, persists offset, stops cleanly", async () => {
    const ctx = mem();
    const config = cfg({ notifications: { channels: { telegram: tg } } });
    const notified: string[] = [];
    const svc = createApprovalService({ ...ctx, notifier: { notify: async (m) => void notified.push(m.kind) }, config, pollIntervalMs: 20 });
    const task = ctx.repo.tasks.create({ title: "T", status: "running" });
    const a1 = await svc.request({ kind: "action", title: "push", task_id: task.id, payload: { tool: "Bash", input: { command: "git push" } } });
    const a2 = await svc.request({ kind: "action", title: "rm", task_id: task.id });
    const a3 = await svc.request({ kind: "question", title: "Which branch?", task_id: task.id });
    const a4 = await svc.request({ kind: "decision", title: "Pick", task_id: task.id, options: [{ value: "a b c", label: "Spaced" }] });
    ctx.repo.approvals.update(a2.id, { channel_refs: { telegram: "42:200" } });
    const captured: string[] = [];
    const handler: InboundHandler = {
      ...createInboundHandler({ approvals: svc, repo: ctx.repo }),
      capture: async (text) => {
        captured.push(text);
        return { ok: true, message: "sig_1" };
      },
    };
    const msg = (id: number, text: string, extra: Record<string, unknown> = {}) => ({ update_id: id, message: { message_id: id, chat: { id: 42 }, from: { id: 7, username: "wk" }, text, ...extra } });
    const batches: unknown[][] = [
      [msg(1, `/approve ${a1.id} ship it`), { update_id: 2, message: { message_id: 2, chat: { id: 999 }, from: { id: 999 }, text: `/approve ${a2.id}` } }],
      [{ update_id: 3, callback_query: { id: "cq1", from: { id: 7, username: "wk" }, data: `d:${a2.id}:reject`, message: { message_id: 200, chat: { id: 42 } } } }],
      [msg(4, "use main", { reply_to_message: { message_id: 300, chat: { id: 42 }, text: `🟢 Question: Which branch? · ${a3.id}` } })],
      [{ update_id: 5, callback_query: { id: "cq2", from: { id: 7 }, data: `d:${a4.id}:#0`, message: { message_id: 400, chat: { id: 42 } } } }],
      [msg(6, "/capture call the bank"), msg(7, "/pending"), msg(8, "/status"), msg(9, "random words"), msg(10, "/help"), msg(11, `/approve ${a1.id}`)],
    ];
    let polls = 0;
    const { fn, calls } = fetchStub(({ url, init, body }) => {
      if (url.endsWith("/getUpdates")) {
        polls++;
        if (polls === 1) expect(body.offset).toBe(1000);
        const b = batches.shift();
        if (b) return { ok: true, result: b };
        // nothing left: hang until aborted (like a real long poll)
        return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      if (url.endsWith("/sendMessage")) return { ok: true, result: { message_id: 1000 + calls.length, chat: { id: 42 } } };
      return { ok: true, result: true };
    });
    vi.stubGlobal("fetch", fn);
    ctx.repo.meta.set(TELEGRAM_OFFSET_KEY, "1000");
    const channel = new TelegramChannel(tg, { logger: ctx.logger, repo: ctx.repo, locale: "en" });
    await channel.start(handler);
    const deadline = Date.now() + 5000;
    while (batches.length && Date.now() < deadline) await tick(10);
    await tick(30);
    await channel.stop();

    expect(ctx.repo.approvals.get(a1.id)?.status).toBe("approved");
    expect(ctx.repo.approvals.get(a1.id)?.decision_note).toBe("ship it");
    expect(ctx.repo.approvals.get(a1.id)?.decided_by).toBe("telegram:@wk");
    expect(ctx.repo.approvals.get(a2.id)?.status).toBe("rejected"); // via button, not via the unauthorized chat
    expect(ctx.repo.approvals.get(a3.id)?.status).toBe("approved");
    expect(ctx.repo.approvals.get(a3.id)?.decision_note).toBe("use main");
    expect(ctx.repo.approvals.get(a4.id)?.decision).toBe("a b c");
    expect(captured).toEqual(["call the bank"]);
    expect(ctx.repo.meta.get(TELEGRAM_OFFSET_KEY)).toBe("12");

    const sends = calls.filter((c) => c.url.endsWith("/sendMessage")).map((c) => c.body.text as string);
    expect(sends.some((t) => /Recorded.*approved/.test(t))).toBe(true);
    expect(sends.some((t) => t.startsWith("1 pending approval") || t.startsWith("No pending"))).toBe(true);
    expect(sends.some((t) => /pending approvals \d/.test(t))).toBe(true);
    expect(sends.some((t) => /Not a command/.test(t))).toBe(true);
    expect(sends.some((t) => t.startsWith("Commands:"))).toBe(true);
    expect(sends.some((t) => /already approved/.test(t))).toBe(true);
    expect(sends.some((t) => /Captured/.test(t))).toBe(true);
    const answers = calls.filter((c) => c.url.endsWith("/answerCallbackQuery"));
    expect(answers.length).toBe(2);
    const edits = calls.filter((c) => c.url.endsWith("/editMessageReplyMarkup"));
    expect(edits.some((e) => e.body.message_id === 200)).toBe(true);
    // unauthorized chat never got a reply
    expect(calls.filter((c) => c.url.endsWith("/sendMessage") && String(c.body.chat_id) === "999").length).toBe(0);
  });

  it("backs off on network errors and keeps running", async () => {
    const ctx = mem();
    let n = 0;
    const api = { call: vi.fn(async (method: string) => {
      if (method !== "getUpdates") return true;
      n++;
      if (n <= 2) throw new Error("ECONNRESET");
      await tick(5);
      return [];
    }) };
    const decisions: InboundDecision[] = [];
    const inbound = new TelegramInbound(tg, api as any, { repo: ctx.repo, logger: ctx.logger, handler: { decide: async (d) => { decisions.push(d); return { ok: true, message: "ok" }; } }, backoffMinMs: 5, backoffMaxMs: 20 });
    await inbound.start();
    const deadline = Date.now() + 2000;
    while (n < 4 && Date.now() < deadline) await tick(5);
    await inbound.stop();
    expect(n).toBeGreaterThanOrEqual(4);
    expect(inbound.running).toBe(false);
  });
});
