/**
 * Triage: classify untriaged signals into inbox items (merging into existing items),
 * record learned facts, and auto-promote eligible items to tasks.
 */
import type { AppContext, TriageReport } from "../core/app.js";
import type { InboxItem, Priority, Signal, TriageResult } from "../core/types.js";
import { PRIORITY_RANK } from "../core/types.js";
import type { TriageDeps } from "./types.js";
import { clampLevel, errMsg, trimText } from "./util.js";

export interface TriageService {
  runOnce(): Promise<TriageReport>;
}

const MAX_MISSES = 2;

function minPriority(a: Priority, b: Priority): Priority {
  return PRIORITY_RANK[a] <= PRIORITY_RANK[b] ? a : b;
}

export function createTriage(ctx: AppContext, deps: TriageDeps): TriageService {
  const { repo, bus, config, policy, budget } = ctx;
  const logger = ctx.logger.child("triage");
  let inFlight: Promise<TriageReport> | null = null;

  function markTriaged(signals: Signal[], inboxItemId: string | null) {
    for (const s of signals) repo.signals.update(s.id, { triaged: 1, inbox_item_id: inboxItemId ?? s.inbox_item_id });
  }

  /** An open item already linked to one of these signals (if any). */
  function findExisting(signals: Signal[]): InboxItem | undefined {
    for (const s of signals) {
      if (!s.inbox_item_id) continue;
      const item = repo.inbox.get(s.inbox_item_id);
      if (item && (item.status === "new" || item.status === "triaged" || item.status === "snoozed")) return item;
    }
    return undefined;
  }

  function applyResult(r: TriageResult, batch: Map<string, Signal>, report: TriageReport): void {
    const signals = (r.signal_ids ?? []).map((id) => batch.get(id)).filter((s): s is Signal => !!s);
    if (!signals.length) return;
    const level = clampLevel(r.level);
    if (r.dismiss) {
      repo.transaction(() => markTriaged(signals, null));
      report.dismissed++;
      bus.record({ type: "triage", message: `dismissed: ${trimText(r.title || signals[0].title, 100)}`, payload: { signal_ids: signals.map((s) => s.id), reason: r.summary, dismissed: true } });
      return;
    }
    const existing = findExisting(signals);
    const item = repo.transaction(() => {
      let it: InboxItem;
      if (existing) {
        const ids = Array.from(new Set([...existing.source_signal_ids, ...signals.map((s) => s.id)]));
        it = repo.inbox.update(existing.id, {
          title: r.title || existing.title,
          summary: r.summary || existing.summary,
          kind: r.kind ?? existing.kind,
          category: r.category ?? existing.category,
          priority: minPriority(existing.priority, r.priority ?? existing.priority),
          level,
          level_proposed: level,
          level_reason: r.level_reason ?? existing.level_reason,
          confidence: r.confidence ?? existing.confidence,
          suggested_action: r.suggested_action || existing.suggested_action,
          tags: Array.from(new Set([...existing.tags, ...(r.tags ?? [])])),
          source_signal_ids: ids,
          status: "triaged",
          snoozed_until: null,
        })!;
      } else {
        it = repo.inbox.create({
          kind: r.kind ?? "info",
          title: r.title || signals[0].title,
          summary: r.summary ?? "",
          category: r.category ?? "other",
          priority: r.priority ?? "P2",
          level,
          level_proposed: level,
          level_reason: r.level_reason ?? "",
          confidence: typeof r.confidence === "number" ? r.confidence : 0.5,
          suggested_action: r.suggested_action ?? "",
          source_signal_ids: signals.map((s) => s.id),
          tags: r.tags ?? [],
          status: "triaged",
        });
      }
      markTriaged(signals, it.id);
      return it;
    });
    if (existing) report.signalsTriaged += signals.length;
    else report.inboxCreated++;
    bus.record({
      type: "triage",
      task_id: item.task_id,
      message: `${existing ? "updated" : "created"} inbox ${item.kind} L${item.level} ${item.priority}: ${trimText(item.title, 100)}`,
      payload: { inbox_item_id: item.id, signal_ids: signals.map((s) => s.id), merged: !!existing, level: item.level, level_reason: item.level_reason, confidence: item.confidence, category: item.category, priority: item.priority },
    });
    bus.emit("inbox.changed", { inbox_item_id: item.id, status: item.status });
    if (r.learned?.length) {
      try {
        deps.recordLearned(r.learned, `triage:${item.id}`);
      } catch (e) {
        logger.warn(`recordLearned failed: ${errMsg(e)}`);
      }
    }
    // Auto-promote (recompute with the policy; the classifier already clamped the level)
    const decision = policy.decideLevel({
      proposed: item.level,
      category: item.category,
      priority: item.priority,
      confidence: item.confidence,
      source: signals[0].source,
      text: `${item.title}\n${item.summary}`,
      tags: item.tags,
      availableCapabilities: deps.availableCapabilities,
    });
    if (decision.autoPromote && item.status === "triaged" && !item.task_id) {
      try {
        deps.inbox.promote(item.id);
        report.tasksCreated++;
      } catch (e) {
        report.errors.push(`promote ${item.id}: ${errMsg(e)}`);
        logger.error(`auto-promote failed for ${item.id}: ${errMsg(e)}`);
      }
    }
  }

  async function runOnce(): Promise<TriageReport> {
    const report: TriageReport = { signalsTriaged: 0, inboxCreated: 0, tasksCreated: 0, dismissed: 0, costUsd: 0, errors: [] };
    if (!budget.canSpend()) {
      const s = budget.status();
      bus.record({ type: "triage", level: "warn", message: `triage skipped: daily budget exhausted ($${s.spentUsd.toFixed(2)}/$${s.limitUsd})`, payload: { skipped: true, budget: s } });
      report.errors.push("budget exhausted");
      return report;
    }
    const signals = repo.signals.listUntriaged(config.patrol.triage_batch_size);
    if (!signals.length) return report;
    const batch = new Map(signals.map((s) => [s.id, s]));
    let results: TriageResult[] = [];
    try {
      const context = deps.loadContext();
      const out = await deps.triageSignals(signals, { llm: deps.llm, policy, config, context, logger, availableCapabilities: deps.availableCapabilities });
      results = out.results ?? [];
      report.costUsd = out.costUsd ?? 0;
      if (report.costUsd > 0) budget.addCost(report.costUsd);
    } catch (e) {
      const msg = errMsg(e);
      report.errors.push(msg);
      bus.record({ type: "error", level: "error", message: `triage failed: ${msg}`, payload: { signal_ids: signals.map((s) => s.id) } });
      logger.error(`triage failed: ${msg}`);
      return report;
    }
    const covered = new Set<string>();
    for (const r of results) {
      try {
        applyResult(r, batch, report);
        for (const id of r.signal_ids ?? []) covered.add(id);
      } catch (e) {
        report.errors.push(errMsg(e));
        logger.error(`applying triage result failed: ${errMsg(e)}`);
      }
    }
    report.signalsTriaged += covered.size;
    // Signals the classifier skipped: give them one more round, then park them as triaged.
    const missed = signals.filter((s) => !covered.has(s.id));
    for (const s of missed) {
      const misses = Number((s.metadata as Record<string, unknown>)._triage_misses ?? 0) + 1;
      if (misses >= MAX_MISSES) {
        repo.signals.update(s.id, { triaged: 1, metadata: { ...s.metadata, _triage_misses: misses } });
        bus.record({ type: "triage", level: "warn", message: `signal skipped by classifier ${misses}x, parked: ${trimText(s.title, 80)}`, payload: { signal_id: s.id, parked: true } });
      } else {
        repo.signals.update(s.id, { metadata: { ...s.metadata, _triage_misses: misses } });
      }
    }
    logger.info(`triage: ${report.signalsTriaged} signals -> ${report.inboxCreated} items, ${report.tasksCreated} tasks, ${report.dismissed} dismissed ($${report.costUsd.toFixed(4)})`);
    if (report.tasksCreated > 0) bus.wake("triage");
    return report;
  }

  return {
    runOnce() {
      if (inFlight) return inFlight;
      inFlight = runOnce().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
