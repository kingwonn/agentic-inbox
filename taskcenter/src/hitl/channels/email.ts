/**
 * Email channel via nodemailer SMTP. Subject = title; text body + simple HTML with the dashboard link.
 */
import nodemailer from "nodemailer";
import type { ChannelEmailConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import type { Channel, NotifyMessage } from "../types.js";

export interface MailTransportLike {
  sendMail(opts: { from: string; to: string; subject: string; text: string; html: string }): Promise<{ messageId?: string }>;
}

export interface EmailChannelDeps {
  logger: Logger;
  locale?: string;
  /** Injectable transport (tests). */
  transport?: MailTransportLike;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildEmail(msg: NotifyMessage, locale = "en"): { subject: string; text: string; html: string } {
  const zh = locale.toLowerCase().startsWith("zh");
  const linkLabel = zh ? "在看板中打开" : "Open in dashboard";
  const text = msg.url ? `${msg.body}\n\n${linkLabel}: ${msg.url}` : msg.body;
  const paragraphs = msg.body
    .split("\n")
    .map((l) => {
      if (l.startsWith("$ ")) return `<pre style="background:#f4f4f5;padding:8px;border-radius:4px;white-space:pre-wrap">${escapeHtml(l)}</pre>`;
      const linked = escapeHtml(l).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
      return linked ? `<div>${linked}</div>` : "<br/>";
    })
    .join("\n");
  const button = msg.url ? `<p style="margin-top:16px"><a href="${escapeHtml(msg.url)}" style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${linkLabel}</a></p>` : "";
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#111">
<h2 style="font-size:18px">${escapeHtml(msg.title)}</h2>
${paragraphs}
${button}
<p style="color:#888;font-size:12px;margin-top:24px">Task Center · ${msg.kind}${msg.approval ? ` · ${msg.approval.id}` : ""}${msg.task ? ` · ${msg.task.id}` : ""}</p>
</body></html>`;
  return { subject: msg.title, text, html };
}

export class EmailChannel implements Channel {
  readonly name = "email";
  private transport?: MailTransportLike;

  constructor(
    readonly cfg: ChannelEmailConfig,
    private readonly deps: EmailChannelDeps,
  ) {
    this.transport = deps.transport;
  }

  configured(): boolean {
    return !!(this.cfg.smtp_host && this.cfg.from && this.cfg.to);
  }

  private getTransport(): MailTransportLike {
    if (!this.transport) {
      this.transport = nodemailer.createTransport({
        host: this.cfg.smtp_host,
        port: this.cfg.smtp_port,
        secure: this.cfg.smtp_port === 465,
        auth: this.cfg.smtp_user ? { user: this.cfg.smtp_user, pass: this.cfg.smtp_password } : undefined,
        connectionTimeout: 15_000,
      }) as unknown as MailTransportLike;
    }
    return this.transport;
  }

  async send(msg: NotifyMessage): Promise<{ ok: boolean; externalRef?: string; error?: string }> {
    const mail = buildEmail(msg, this.deps.locale);
    try {
      const info = await this.getTransport().sendMail({ from: this.cfg.from, to: this.cfg.to, ...mail });
      return { ok: true, externalRef: info?.messageId };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
