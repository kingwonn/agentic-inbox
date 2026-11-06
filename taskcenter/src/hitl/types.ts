import type { Approval, NewApproval, Decision, Task } from "../core/types.js";

/** Notification channel contract. */
export interface NotifyMessage {
  title: string;
  body: string; // plain text / markdown-lite
  url?: string;
  approval?: Approval; // when present, the channel may render decision buttons
  task?: Task;
  kind: "approval_requested" | "task_done" | "task_failed" | "review_ready" | "digest" | "budget_warning" | "info";
  priority?: "low" | "normal" | "high";
}

export interface Channel {
  readonly name: string;
  configured(): boolean;
  send(msg: NotifyMessage): Promise<{ ok: boolean; externalRef?: string; error?: string }>;
  /** Optional: start listening for inbound decisions (e.g. Telegram long polling). */
  start?(handler: InboundHandler): Promise<void>;
  stop?(): Promise<void>;
  /** Optional: called after an approval is decided/expired so the channel can retract buttons. */
  onDecided?(approval: Approval): Promise<void>;
}

export interface InboundDecision {
  approvalId: string;
  /** One of the four standard decisions, or a custom option value (kind `decision`/`review`, e.g. "accept", "request_changes"). */
  decision: Decision | (string & {});
  note?: string;
  editedPayload?: Record<string, unknown>;
  decidedBy: string;
}

export interface InboundHandler {
  decide(d: InboundDecision): Promise<{ ok: boolean; message: string }>;
  /** Free-text capture into the inbox ("manual" sensor). */
  capture?(text: string, by: string): Promise<{ ok: boolean; message: string }>;
  status?(): Promise<string>;
}

export interface ApprovalService {
  request(input: NewApproval): Promise<Approval>;
  /** Resolve when decided or timeout; returns the (possibly still pending) approval. */
  waitForDecision(approvalId: string, timeoutMs: number, signal?: AbortSignal): Promise<Approval>;
  decide(d: InboundDecision): Promise<Approval>;
  pending(): Approval[];
}
