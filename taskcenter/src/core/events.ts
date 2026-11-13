import { EventEmitter } from "node:events";
import type { Repo } from "./repo.js";
import type { Event, NewEvent } from "./types.js";

/**
 * In-process event bus + persistent event log.
 * `record()` writes to the events table AND emits to subscribers (dashboard SSE, notifier).
 */
export interface BusEvents {
  event: [Event];
  "task.changed": [{ task_id: string; status: string; previous?: string }];
  "run.changed": [{ run_id: string; task_id: string; status: string }];
  "approval.requested": [{ approval_id: string; task_id: string | null }];
  "approval.decided": [{ approval_id: string; task_id: string | null; decision: string }];
  "inbox.changed": [{ inbox_item_id: string; status: string }];
  "signal.new": [{ signal_id: string; source: string }];
  wake: [{ reason: string }]; // nudge the executor loop
}

export class Bus extends EventEmitter<BusEvents> {
  constructor(private repo: Repo) {
    super();
    this.setMaxListeners(100);
  }

  record(input: NewEvent): Event {
    const ev = this.repo.events.append(input);
    try {
      this.emit("event", ev);
    } catch {
      /* listeners must not break the writer */
    }
    return ev;
  }

  wake(reason: string): void {
    this.emit("wake", { reason });
  }
}
