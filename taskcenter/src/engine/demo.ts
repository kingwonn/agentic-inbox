/**
 * Minimal demo seed used when server/seed.ts is not available. Creates a few
 * signals, inbox items, tasks, a run with an artifact and a pending approval.
 */
import type { AppContext } from "../core/app.js";
import { transitionRun, transitionTask } from "../core/state.js";
import { HOUR, isoPlus } from "../core/time.js";

export function seedDemoFallback(ctx: AppContext): { signals: number; inbox: number; tasks: number; approvals: number } {
  const { repo, bus } = ctx;
  return repo.transaction(() => {
    const s1 = repo.signals.upsert({ source: "github", external_id: "demo:pr:42", kind: "pull_request", title: "PR #42: add IMAP sensor", body: "Review requested by a collaborator. CI green.", url: "https://github.com/example/repo/pull/42", actor: "alice" }).signal;
    const s2 = repo.signals.upsert({ source: "imap", external_id: "demo:mail:1", kind: "email", title: "Invoice for November", body: "Please pay the attached invoice by Friday.", actor: "billing@example.com" }).signal;
    const s3 = repo.signals.upsert({ source: "manual", external_id: "demo:manual:1", kind: "note", title: "Write the release notes for v0.2", body: "Summarise the changes since v0.1 and draft release notes.", actor: "me" }).signal;
    const i1 = repo.inbox.create({ kind: "todo", title: "Review PR #42 (IMAP sensor)", summary: "A collaborator asked for a review; CI is green.", category: "code", priority: "P1", level: 3, level_proposed: 4, level_reason: "code review: produce review comments as a draft", confidence: 0.85, suggested_action: "Read the diff and draft review comments", source_signal_ids: [s1.id], tags: ["github", "review"], status: "triaged" });
    repo.signals.update(s1.id, { triaged: 1, inbox_item_id: i1.id });
    const i2 = repo.inbox.create({ kind: "decision", title: "Invoice for November needs payment", summary: "Billing asks for payment by Friday.", category: "finance", priority: "P2", level: 2, level_proposed: 3, level_reason: "finance is capped at L2", confidence: 0.9, suggested_action: "Verify the invoice and decide", source_signal_ids: [s2.id], tags: ["imap", "finance"], status: "new" });
    repo.signals.update(s2.id, { triaged: 1, inbox_item_id: i2.id });
    const i3 = repo.inbox.create({ kind: "todo", title: "Draft release notes v0.2", summary: "Summarise changes since v0.1.", category: "writing", priority: "P2", level: 3, level_proposed: 3, level_reason: "writing deliverable goes to review", confidence: 0.8, suggested_action: "Draft RELEASE_NOTES.md", source_signal_ids: [s3.id], tags: ["manual"], status: "promoted" });
    repo.signals.update(s3.id, { triaged: 1, inbox_item_id: i3.id });
    const t1 = repo.tasks.create({ title: "Draft release notes v0.2", description: "Summarise changes since v0.1 into RELEASE_NOTES.md", kind: "todo", category: "writing", priority: "P2", level: 3, status: "review", inbox_item_id: i3.id, labels: ["demo"], result_summary: "Drafted release notes with 12 bullet points.", context: { inbox_item_id: i3.id, dry: { status: "done" } } });
    repo.inbox.update(i3.id, { task_id: t1.id });
    const r1 = repo.runs.create({ task_id: t1.id, runner: "dry", model: "sonnet", reason: "scheduled" });
    transitionRun(repo, bus, r1.id, "running");
    transitionRun(repo, bus, r1.id, "succeeded", { cost_usd: 0.12, num_turns: 6, result_text: "Drafted release notes." });
    repo.tasks.update(t1.id, { cost_usd: 0.12 });
    repo.artifacts.create({ task_id: t1.id, run_id: r1.id, type: "document", title: "RELEASE_NOTES.md", content: "# v0.2\n\n- IMAP sensor\n- Telegram approvals\n- Daily digest\n" });
    repo.approvals.create({ task_id: t1.id, run_id: r1.id, kind: "review", title: "Review: Draft release notes v0.2", context: "Drafted release notes with 12 bullet points.", recommendation: "Accept if complete", options: [{ value: "accept", label: "Accept" }, { value: "request_changes", label: "Request changes" }, { value: "reject", label: "Reject" }], risk: "low", expires_at: isoPlus(72 * HOUR) });
    const t2 = repo.tasks.create({ title: "Summarise what changed in the repo this week", description: "Read recent commits and produce a short summary.", kind: "info", category: "research", priority: "P3", level: 1, status: "ready", labels: ["demo"], context: { dry: { status: "done" } } });
    transitionTask(repo, bus, t2.id, "ready");
    repo.memories.upsertByContent({ kind: "preference", content: "Prefers concise, direct summaries in zh-CN.", source: "demo", confidence: 0.8 });
    bus.record({ type: "system", message: "demo data seeded (fallback)", payload: { tasks: [t1.id, t2.id] } });
    return { signals: 3, inbox: 3, tasks: 2, approvals: 1 };
  });
}
