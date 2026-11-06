import type { Config } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import type { Repo } from "../../core/repo.js";
import type { Channel } from "../types.js";
import { ConsoleChannel } from "./console.js";
import { EmailChannel, type MailTransportLike } from "./email.js";
import { NtfyChannel } from "./ntfy.js";
import { TelegramChannel, type FetchLike } from "./telegram.js";
import { WebhookChannel } from "./webhook.js";

export interface ChannelDeps {
  logger: Logger;
  repo: Repo;
  /** Absolute data dir (console log file). */
  dataDir?: string;
  publicUrl?: string;
  /** Test hooks */
  fetch?: FetchLike;
  mailTransport?: MailTransportLike;
  consoleStderr?: boolean;
}

/** Console always; telegram/ntfy/email/webhook when enabled AND configured. */
export function createChannels(config: Config, deps: ChannelDeps): Channel[] {
  const n = config.notifications.channels;
  const locale = config.locale;
  const publicUrl = deps.publicUrl || config.server.public_url || undefined;
  const out: Channel[] = [new ConsoleChannel({ dataDir: deps.dataDir, stderr: deps.consoleStderr ?? n.console.enabled })];
  const candidates: Array<[boolean, () => Channel]> = [
    [n.telegram.enabled, () => new TelegramChannel(n.telegram, { logger: deps.logger, repo: deps.repo, locale, fetch: deps.fetch })],
    [n.ntfy.enabled, () => new NtfyChannel(n.ntfy, { logger: deps.logger, publicUrl, apiToken: config.server.token || undefined, locale, fetch: deps.fetch })],
    [n.email.enabled, () => new EmailChannel(n.email, { logger: deps.logger, locale, transport: deps.mailTransport })],
    [n.webhook.enabled, () => new WebhookChannel(n.webhook, { logger: deps.logger, fetch: deps.fetch })],
  ];
  for (const [enabled, make] of candidates) {
    if (!enabled) continue;
    const ch = make();
    if (ch.configured()) out.push(ch);
    else deps.logger.warn(`notification channel ${ch.name} is enabled but not configured; skipping`);
  }
  return out;
}

export { ConsoleChannel, TelegramChannel, NtfyChannel, EmailChannel, WebhookChannel };
