import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChannels } from "../src/hitl/channels/index.js";
import { ConsoleChannel, boxMessage } from "../src/hitl/channels/console.js";
import { EmailChannel, buildEmail } from "../src/hitl/channels/email.js";
import { NtfyChannel, buildNtfyPayload } from "../src/hitl/channels/ntfy.js";
import { WebhookChannel, buildWebhookPayload } from "../src/hitl/channels/webhook.js";
import { cfg, fakeApproval, fakeTask, fetchStub, mem, tmp } from "./hitl-helpers.js";

describe("console channel", () => {
  it("boxes the message and appends to data/logs/notifications.log", async () => {
    const dir = tmp();
    const ch = new ConsoleChannel({ dataDir: dir, stderr: false });
    const r = await ch.send({ kind: "info", title: "Hello", body: "line 1\nline 2", url: "http://x" });
    expect(r.ok).toBe(true);
    const log = join(dir, "logs", "notifications.log");
    expect(existsSync(log)).toBe(true);
    const rec = JSON.parse(readFileSync(log, "utf8").trim());
    expect(rec).toMatchObject({ kind: "info", title: "Hello", url: "http://x" });
    const box = boxMessage({ kind: "info", title: "T", body: "b" }, 20);
    expect(box.split("\n")[0]).toBe("┌──────────────────┐");
    expect(box.split("\n").every((l) => [...l].length === 20)).toBe(true);
  });
});

describe("ntfy channel", () => {
  const ntfy = { enabled: true, server: "https://ntfy.sh", topic: "tc-secret", token: "tk_1" };

  it("builds the JSON payload with actions when publicUrl is set", () => {
    const a = fakeApproval();
    const p = buildNtfyPayload(ntfy, { kind: "approval_requested", title: "T", body: "B", approval: a, url: "http://tc.local/#/outbox/" + a.id, priority: "high" }, { publicUrl: "http://tc.local", apiToken: "secret", locale: "en" });
    expect(p).toMatchObject({ topic: "tc-secret", title: "T", message: "B", markdown: true, priority: 4, click: "http://tc.local/#/outbox/" + a.id });
    expect(p.tags).toEqual(["bell", "rotating_light"]);
    const actions = p.actions as any[];
    expect(actions.length).toBe(3);
    expect(actions[0]).toEqual({ action: "view", label: "Open", url: "http://tc.local/#/outbox/" + a.id });
    expect(actions[1]).toMatchObject({ action: "http", label: "Approve", url: `http://tc.local/api/approvals/${a.id}/decide`, method: "POST", body: '{"decision":"approve"}', clear: true });
    expect(actions[1].headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer secret" });
    expect(actions[2]).toMatchObject({ action: "http", label: "Reject", body: '{"decision":"reject"}' });
    const noUrl = buildNtfyPayload(ntfy, { kind: "task_done", title: "T", body: "B", priority: "low" }, {});
    expect(noUrl.actions).toBeUndefined();
    expect(noUrl.priority).toBe(2);
    expect(noUrl.tags).toEqual(["white_check_mark"]);
    const review = buildNtfyPayload(ntfy, { kind: "approval_requested", title: "T", body: "B", approval: fakeApproval({ kind: "review", risk: "low", options: [{ value: "accept", label: "Accept" }, { value: "reject", label: "Reject" }] }) }, { publicUrl: "http://tc.local" });
    expect((review.actions as any[]).map((x) => x.body)).toEqual(['{"decision":"accept"}', '{"decision":"reject"}']);
  });

  it("POSTs to the server root with bearer auth", async () => {
    const ctx = mem();
    const { fn, calls } = fetchStub(() => ({ id: "msg1" }));
    const ch = new NtfyChannel(ntfy, { logger: ctx.logger, fetch: fn as any });
    expect(ch.configured()).toBe(true);
    const r = await ch.send({ kind: "info", title: "T", body: "B" });
    expect(r).toEqual({ ok: true, externalRef: "msg1" });
    expect(calls[0].url).toBe("https://ntfy.sh/");
    expect((calls[0].init!.headers as any).Authorization).toBe("Bearer tk_1");
    expect(calls[0].body.topic).toBe("tc-secret");
    const bad = new NtfyChannel(ntfy, { logger: ctx.logger, fetch: (async () => new Response("nope", { status: 429 })) as any });
    expect((await bad.send({ kind: "info", title: "T", body: "B" })).ok).toBe(false);
    expect(new NtfyChannel({ ...ntfy, topic: "" }, { logger: ctx.logger }).configured()).toBe(false);
  });
});

describe("email channel", () => {
  const email = { enabled: true, smtp_host: "smtp.example.com", smtp_port: 587, smtp_user: "u", smtp_password: "p", from: "tc@example.com", to: "me@example.com" };

  it("sends subject=title, text + html with the dashboard link via an injected transport", async () => {
    const ctx = mem();
    const sent: any[] = [];
    const transport = { sendMail: async (o: any) => (sent.push(o), { messageId: "<m1>" }) };
    const ch = new EmailChannel(email, { logger: ctx.logger, locale: "zh-CN", transport });
    expect(ch.configured()).toBe(true);
    const a = fakeApproval();
    const r = await ch.send({ kind: "approval_requested", title: "Approve <x>", body: "line\n$ git push", approval: a, url: "http://tc.local/#/outbox/" + a.id });
    expect(r).toEqual({ ok: true, externalRef: "<m1>" });
    expect(sent[0]).toMatchObject({ from: "tc@example.com", to: "me@example.com", subject: "Approve <x>" });
    expect(sent[0].text).toContain("在看板中打开: http://tc.local/#/outbox/" + a.id);
    expect(sent[0].html).toContain("<h2 style=\"font-size:18px\">Approve &lt;x&gt;</h2>");
    expect(sent[0].html).toContain("<pre");
    expect(sent[0].html).toContain(`href="http://tc.local/#/outbox/${a.id}"`);
    const m = buildEmail({ kind: "info", title: "T", body: "B" });
    expect(m.text).toBe("B");
    expect(new EmailChannel({ ...email, to: "" }, { logger: ctx.logger }).configured()).toBe(false);
    const failing = new EmailChannel(email, { logger: ctx.logger, transport: { sendMail: async () => { throw new Error("smtp down"); } } });
    expect(await failing.send({ kind: "info", title: "T", body: "B" })).toEqual({ ok: false, error: "smtp down" });
  });
});

describe("webhook channel", () => {
  it("POSTs the JSON envelope", async () => {
    const ctx = mem();
    const { fn, calls } = fetchStub(() => new Response(null, { status: 204 }));
    const ch = new WebhookChannel({ enabled: true, url: "https://hooks.example.com/tc" }, { logger: ctx.logger, fetch: fn as any });
    const a = fakeApproval();
    const t = fakeTask();
    const r = await ch.send({ kind: "approval_requested", title: "T", body: "B", approval: a, task: t, url: "http://x" });
    expect(r.ok).toBe(true);
    expect(calls[0].body).toMatchObject({ kind: "approval_requested", title: "T", body: "B", url: "http://x", priority: "normal", approval: { id: a.id }, task: { id: t.id } });
    expect(typeof calls[0].body.sent_at).toBe("string");
    expect(buildWebhookPayload({ kind: "info", title: "T", body: "B" })).toMatchObject({ approval: null, task: null, url: null });
    expect(new WebhookChannel({ enabled: true, url: "" }, { logger: ctx.logger }).configured()).toBe(false);
  });
});

describe("createChannels", () => {
  it("includes console always and enabled+configured channels only", () => {
    const ctx = mem();
    const config = cfg({
      notifications: {
        channels: {
          telegram: { enabled: true, bot_token: "1:a", chat_id: "2" },
          ntfy: { enabled: true, topic: "" }, // enabled but unconfigured → skipped
          email: { enabled: false, smtp_host: "x", from: "a", to: "b" },
          webhook: { enabled: true, url: "https://h.example.com" },
        },
      },
    });
    const names = createChannels(config, { logger: ctx.logger, repo: ctx.repo, consoleStderr: false }).map((c) => c.name);
    expect(names).toEqual(["console", "telegram", "webhook"]);
  });
});
