import { beforeAll, describe, expect, it } from "vitest";
import { renderApproval, renderTaskEvent, describeAction, setRenderTimeZone, MAX_BODY } from "../src/hitl/render.js";
import { fakeApproval, fakeTask } from "./hitl-helpers.js";

beforeAll(() => setRenderTimeZone("UTC"));

describe("renderApproval", () => {
  it("renders an email action in zh-CN", () => {
    const { title, body } = renderApproval(fakeApproval(), fakeTask(), "zh-CN", "http://tc.local/");
    expect(title).toBe("🔴 需要批准: Send email to alice@example.com");
    expect(body).toMatchInlineSnapshot(`
      "高风险 · apr_000000000abcdefgh
      任务: Reply to Alice about the invoice (tsk_000000000abcdefgh, L3, P1)

      Agent 想要:
      [mcp__taskcenter__send_email]
      To: alice@example.com
      Subject: Re: Invoice #42
      Hi Alice, the invoice was paid on Nov 3.

      背景: Alice asked for the invoice status on Monday.

      建议: Approve; the draft is factual and polite.

      选项:
      • 批准 → /approve apr_000000000abcdefgh [备注]
      • 修改后批准 → /edit apr_000000000abcdefgh {"input":{...}}
      • 拒绝 → /reject apr_000000000abcdefgh [理由]
      也可以直接点按钮，或在看板的 Outbox 中处理。

      链接: http://tc.local/#/outbox/apr_000000000abcdefgh
      过期: 2026-11-08 10:00"
    `);
  });

  it("renders a bash action in en without a link", () => {
    const a = fakeApproval({ kind: "action", risk: "medium", title: "Push branch", context: "", recommendation: "", payload: { tool: "Bash", input: { command: "git push -u origin tc/fix" } } });
    const { title, body } = renderApproval(a, undefined, "en");
    expect(title).toBe("🟠 Approval needed: Push branch");
    expect(body).toMatchInlineSnapshot(`
      "medium risk · apr_000000000abcdefgh

      The agent wants to:
      [Bash]
      $ git push -u origin tc/fix

      Options:
      • Approve → /approve apr_000000000abcdefgh [note]
      • Edit & approve → /edit apr_000000000abcdefgh {"input":{...}}
      • Reject → /reject apr_000000000abcdefgh [reason]
      Or tap a button, or handle it in the dashboard Outbox.

      Expires: 2026-11-08 10:00"
    `);
  });

  it("renders question / decision / review kinds", () => {
    const q = renderApproval(fakeApproval({ kind: "question", risk: "low", title: "Which base branch?", payload: {}, options: [{ value: "respond", label: "Respond" }] }), undefined, "en");
    expect(q.title).toMatch(/^🟢 Question: Which base branch\?/);
    expect(q.body).not.toContain("The agent wants to");
    expect(q.body).toContain("/respond apr_000000000abcdefgh <answer>");
    const d = renderApproval(fakeApproval({ kind: "decision", options: [{ value: "fast", label: "Fast", description: "ship today" }, { value: "reject", label: "Reject" }] }), undefined, "zh-CN");
    expect(d.body).toContain("• Fast — ship today → /decide apr_000000000abcdefgh fast");
    const r = renderApproval(fakeApproval({ kind: "review", options: [{ value: "accept", label: "Accept" }, { value: "request_changes", label: "Request changes" }, { value: "reject", label: "Reject" }] }), fakeTask(), "en");
    expect(r.title).toContain("Review needed");
    expect(r.body).toContain("/decide apr_000000000abcdefgh request_changes");
  });

  it("stays under the Telegram limit for huge payloads", () => {
    const a = fakeApproval({ context: "x".repeat(5000), payload: { tool: "Write", input: { file_path: "/w/a.ts", content: "y".repeat(9000) } } });
    const { body } = renderApproval(a, fakeTask(), "en", "http://x");
    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
  });

  it("describeAction picks key fields", () => {
    expect(describeAction({ tool: "Bash", input: { command: "ls" } })).toBe("[Bash]\n$ ls");
    expect(describeAction({ tool: "mcp__taskcenter__create_pr", input: { title: "Fix", head: "tc/fix", base: "main" } })).toBe("[mcp__taskcenter__create_pr]\nPR: Fix\ntc/fix → main");
    expect(describeAction({ tool: "Write", input: { file_path: "/etc/hosts" } })).toBe("[Write]\nFile: /etc/hosts");
    expect(describeAction({ tool: "X", input: { a: 1 } })).toBe("[X]\n{\"a\":1}");
    expect(describeAction({})).toBe("—");
  });
});

describe("renderTaskEvent", () => {
  it("task_done / task_failed / review_ready / budget / digest in both locales", () => {
    const t = fakeTask({ status: "done", result_summary: "Sent the reply and filed the invoice.", cost_usd: 0.42 });
    const zh = renderTaskEvent("task_done", t, "zh-CN", { publicUrl: "http://tc.local", artifacts: [{ title: "Draft", url: "http://x/d" }], follow_ups: ["ping Bob"] });
    expect(zh.title).toBe("✅ 任务完成: Reply to Alice about the invoice");
    expect(zh.body).toMatchInlineSnapshot(`
      "任务: Reply to Alice about the invoice (tsk_000000000abcdefgh, L3, P1)
      结果: Sent the reply and filed the invoice.
      产出:
      • Draft http://x/d
      后续:
      • ping Bob
      花费: $0.42
      链接: http://tc.local/#/tasks/tsk_000000000abcdefgh"
    `);
    const en = renderTaskEvent("task_failed", fakeTask({ status: "failed", last_error: "tests failed", attempts: 3 }), "en");
    expect(en.title).toBe("❌ Task failed: Reply to Alice about the invoice");
    expect(en.body).toContain("Error: tests failed");
    expect(en.body).toContain("Attempts: 3/3");
    const rv = renderTaskEvent("review_ready", fakeTask({ status: "review", result_summary: "PR opened" }), "en");
    expect(rv.body).toContain("Accept, request changes or reject");
    const bw = renderTaskEvent("budget_warning", fakeTask(), "zh-CN", { spentUsd: 16.5, limitUsd: 20 });
    expect(bw.title).toBe("💸 预算预警");
    expect(bw.body).toContain("今日已用: $16.50 / 预算上限: $20.00");
    const dg = renderTaskEvent("digest", fakeTask(), "en", { text: "3 new inbox items, 1 pending approval", title: "Digest 2026-11-05" });
    expect(dg.title).toBe("Digest 2026-11-05");
    expect(dg.body).toBe("3 new inbox items, 1 pending approval");
  });
});
