/**
 * Inbox service: promote items to tasks, dismiss/snooze/done, and capture free text
 * as a manual signal.
 */
import type { AppContext } from "../core/app.js";
import type { InboxItem, Signal, Task } from "../core/types.js";
import type { InboxService } from "./types.js";
import { firstLine, sha1, trimText } from "./util.js";

export function signalExcerpt(s: Signal) {
  return {
    id: s.id,
    source: s.source,
    kind: s.kind,
    title: s.title,
    url: s.url,
    actor: s.actor,
    occurred_at: s.occurred_at,
    body: trimText(s.body, 1500),
  };
}

export function createInboxService(ctx: AppContext): InboxService {
  const { repo, bus, config } = ctx;
  const logger = ctx.logger.child("inbox");

  function mustGet(id: string): InboxItem {
    const item = repo.inbox.get(id);
    if (!item) throw new Error(`inbox item not found: ${id}`);
    return item;
  }

  function promote(id: string, overrides: Partial<Task> = {}): Task {
    const item = mustGet(id);
    if (item.status === "promoted" && item.task_id) {
      const existing = repo.tasks.get(item.task_id);
      if (existing) return existing;
    }
    const signals = repo.signals.getMany(item.source_signal_ids);
    const level = overrides.level ?? item.level;
    const descParts = [item.summary];
    if (item.suggested_action) descParts.push(`Suggested action: ${item.suggested_action}`);
    const task = repo.transaction(() => {
      const t = repo.tasks.create({
        title: item.title,
        description: descParts.filter(Boolean).join("\n\n"),
        kind: item.kind,
        category: item.category,
        priority: item.priority,
        level,
        status: level <= 2 ? "ready" : "todo",
        inbox_item_id: item.id,
        acceptance_criteria: item.suggested_action ? [item.suggested_action] : [],
        budget_usd: config.brain.budget_usd_per_run,
        max_attempts: config.executor.max_attempts,
        labels: [...item.tags],
        context: {
          inbox_item_id: item.id,
          inbox_kind: item.kind,
          level_reason: item.level_reason,
          suggested_action: item.suggested_action,
          signals: signals.map(signalExcerpt),
        },
        ...overrides,
      });
      repo.inbox.update(item.id, { status: "promoted", task_id: t.id });
      bus.record({
        type: "status_change",
        task_id: t.id,
        message: `inbox item promoted to task (${t.status}, L${t.level})`,
        payload: { entity: "inbox", inbox_item_id: item.id, from: item.status, to: "promoted", level: t.level, status: t.status },
      });
      return t;
    });
    bus.emit("inbox.changed", { inbox_item_id: item.id, status: "promoted" });
    bus.emit("task.changed", { task_id: task.id, status: task.status });
    bus.wake("promote");
    logger.info(`promoted ${item.id} -> ${task.id} (${task.status}, L${task.level})`);
    return task;
  }

  function setStatus(id: string, status: InboxItem["status"], patch: Partial<InboxItem> = {}, reason?: string): InboxItem {
    const item = mustGet(id);
    const updated = repo.inbox.update(id, { status, ...patch })!;
    bus.record({
      type: "status_change",
      task_id: item.task_id,
      message: `inbox ${item.status} -> ${status}${reason ? `: ${reason}` : ""}`,
      payload: { entity: "inbox", inbox_item_id: id, from: item.status, to: status, reason: reason ?? null },
    });
    bus.emit("inbox.changed", { inbox_item_id: id, status });
    return updated;
  }

  async function capture(text: string, by: string, opts: { title?: string; url?: string } = {}): Promise<Signal> {
    const body = String(text ?? "").trim();
    if (!body) throw new Error("capture: empty text");
    const external_id = `manual:${sha1(`${by}\n${body}`)}`;
    const title = opts.title ?? firstLine(body, 120);
    const r = repo.signals.upsert({
      source: "manual",
      external_id,
      kind: "note",
      title,
      body,
      url: opts.url ?? null,
      actor: by,
      metadata: { by, captured_at: new Date().toISOString() },
    });
    bus.record({ type: "system", message: `captured by ${by}: ${trimText(title, 80)}`, payload: { signal_id: r.signal.id, isNew: r.isNew, changed: r.changed } });
    if (r.isNew) bus.emit("signal.new", { signal_id: r.signal.id, source: "manual" });
    if (r.isNew || r.changed) bus.wake("capture");
    return r.signal;
  }

  return {
    promote,
    dismiss: (id, reason) => setStatus(id, "dismissed", {}, reason),
    snooze: (id, untilIso) => setStatus(id, "snoozed", { snoozed_until: untilIso }, `until ${untilIso}`),
    done: (id) => setStatus(id, "done"),
    capture,
  };
}
