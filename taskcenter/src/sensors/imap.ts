/**
 * IMAP sensor (imapflow 2 + mailparser).
 *
 * Cursor: `uidvalidity` + `last_uid` (+ `account`/`mailbox` guards). First run seeds
 * from `since_days` (SEARCH SINCE), capped at `max_messages`; later runs fetch
 * `last_uid+1:*`. One short-lived connection per poll (no IDLE).
 * Every message becomes an `email` signal (external_id `<uidvalidity>:<uid>`); bulk /
 * no-reply mail is flagged in `metadata.flags` so the classifier can deprioritise it.
 *
 * The ImapFlow constructor is injectable (`createImapSensor({ createClient })`) so the
 * sensor can be unit-tested with a fake client.
 */
import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { NewSignal } from "../core/types.js";
import { t } from "./i18n.js";
import type { Sensor, SensorContext, SensorPollResult } from "./types.js";
import { daysAgo, errorMessage, excerpt, SensorConfigError, sha1, stripHtml, withTimeout, Warnings } from "./util.js";

export const IMAP_SOURCE = "imap";
const CONNECT_TIMEOUT_MS = 20_000;
const BODY_CHARS = 4000;

// ── Minimal client surface (structural subset of ImapFlow) ──────────

export interface ImapMailboxInfo {
  path: string;
  uidValidity: bigint | number;
  uidNext: number;
  exists: number;
}

export interface ImapEnvelopeAddress {
  name?: string | undefined;
  address?: string | undefined;
}

export interface ImapFetchedMessage {
  uid: number;
  seq?: number;
  source?: Buffer | undefined;
  flags?: Set<string> | undefined;
  internalDate?: Date | string | undefined;
  threadId?: string | undefined;
  emailId?: string | undefined;
  labels?: Set<string> | undefined;
  size?: number | undefined;
  envelope?:
    | {
        date?: Date | string | undefined;
        subject?: string | undefined;
        messageId?: string | undefined;
        from?: ImapEnvelopeAddress[] | undefined;
        to?: ImapEnvelopeAddress[] | undefined;
      }
    | undefined;
}

export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close?(): void;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  mailbox: ImapMailboxInfo | false | undefined;
  search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false | undefined | { all?: number[] }>;
  fetch(range: number[] | string, query: Record<string, unknown>, options: { uid: true }): AsyncIterable<ImapFetchedMessage>;
}

export interface ImapClientOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  logger: false;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  disableAutoIdle: boolean;
  clientInfo: { name: string; version: string };
}

export type ImapClientFactory = (options: ImapClientOptions) => ImapClientLike;
export type MailParser = (source: Buffer) => Promise<ParsedMail>;

export const defaultClientFactory: ImapClientFactory = (options) => new ImapFlow(options) as unknown as ImapClientLike;
export const defaultParser: MailParser = (source) => simpleParser(source, { skipTextToHtml: true, skipImageLinks: true });

// ── Helpers ─────────────────────────────────────────────────────────

function addrList(x: AddressObject | AddressObject[] | undefined): Array<{ name: string | null; address: string | null }> {
  const objs = Array.isArray(x) ? x : x ? [x] : [];
  const out: Array<{ name: string | null; address: string | null }> = [];
  for (const o of objs) for (const v of o.value ?? []) out.push({ name: v.name || null, address: v.address?.toLowerCase() ?? null });
  return out;
}

function headerString(parsed: ParsedMail, key: string): string | undefined {
  const v = parsed.headers.get(key);
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && "text" in v) return String((v as { text: string }).text);
  if (typeof v === "object" && "value" in v) return String((v as { value: unknown }).value);
  return String(v);
}

const NOREPLY_RE = /\b(no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|bounce|alerts?|newsletter|updates)\b/i;

export function classifyBulk(parsed: ParsedMail, fromAddress: string | null): { bulk: boolean; noreply: boolean; auto: boolean; list_id: string | null } {
  const unsubscribe = headerString(parsed, "list-unsubscribe");
  const listId = headerString(parsed, "list-id") ?? null;
  const precedence = (headerString(parsed, "precedence") ?? "").toLowerCase();
  const autoSubmitted = (headerString(parsed, "auto-submitted") ?? "").toLowerCase();
  const autoSuppress = headerString(parsed, "x-auto-response-suppress");
  const auto = (autoSubmitted !== "" && autoSubmitted !== "no") || Boolean(autoSuppress);
  const noreply = Boolean(fromAddress && NOREPLY_RE.test(fromAddress.split("@")[0] ?? ""));
  const bulk = Boolean(unsubscribe) || Boolean(listId) || ["bulk", "list", "junk"].includes(precedence) || auto;
  return { bulk, noreply, auto, list_id: listId };
}

export function gmailThreadUrl(host: string, threadId: string | undefined): string | null {
  if (!threadId || !/gmail|googlemail|google/i.test(host) || !/^\d+$/.test(threadId)) return null;
  try {
    return `https://mail.google.com/mail/u/0/#all/${BigInt(threadId).toString(16)}`;
  } catch {
    return null;
  }
}

export function messageToSignal(
  msg: ImapFetchedMessage,
  parsed: ParsedMail,
  ctx: { uidValidity: string; mailbox: string; host: string; locale: string },
): NewSignal {
  const from = addrList(parsed.from)[0] ?? {
    name: msg.envelope?.from?.[0]?.name ?? null,
    address: msg.envelope?.from?.[0]?.address?.toLowerCase() ?? null,
  };
  const to = addrList(parsed.to);
  const cc = addrList(parsed.cc);
  const subject = (parsed.subject ?? msg.envelope?.subject ?? "").trim() || t(ctx.locale, "mail.noSubject");
  const date = parsed.date ?? (msg.internalDate ? new Date(msg.internalDate) : undefined) ?? new Date();
  const text = (parsed.text ?? "").trim() || stripHtml(parsed.html || "");
  const flags = classifyBulk(parsed, from.address);
  const seen = msg.flags?.has("\\Seen") ?? false;
  const flagged = msg.flags?.has("\\Flagged") ?? false;
  const answered = msg.flags?.has("\\Answered") ?? false;
  const attachments = (parsed.attachments ?? [])
    .filter((a) => !a.related)
    .map((a) => ({ filename: a.filename ?? null, contentType: a.contentType, size: a.size }));
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  const fromText = from.name ? `${from.name} <${from.address ?? ""}>` : (from.address ?? "?");
  const header = [
    `${t(ctx.locale, "mail.label.from")}: ${fromText}`,
    `${t(ctx.locale, "mail.label.to")}: ${to
      .slice(0, 5)
      .map((a) => a.address ?? a.name ?? "?")
      .join(", ")}${to.length > 5 ? ` +${to.length - 5}` : ""}`,
    `${t(ctx.locale, "mail.label.date")}: ${date.toISOString()}`,
    ...(attachments.length ? [`${t(ctx.locale, "mail.label.attachments")}: ${attachments.map((a) => a.filename ?? a.contentType).join(", ")}`] : []),
    ...(flags.bulk ? [`[${t(ctx.locale, "mail.label.bulk")}]`] : []),
  ].join("\n");
  const body = `${header}\n\n${excerpt(text, BODY_CHARS)}`.trim();
  return {
    source: IMAP_SOURCE,
    external_id: `${ctx.uidValidity}:${msg.uid}`,
    kind: "email",
    title: subject.length > 200 ? subject.slice(0, 199) + "…" : subject,
    body,
    url: gmailThreadUrl(ctx.host, msg.threadId),
    actor: from.address ?? from.name ?? null,
    occurred_at: date.toISOString(),
    metadata: {
      uid: msg.uid,
      uidvalidity: ctx.uidValidity,
      mailbox: ctx.mailbox,
      messageId: parsed.messageId ?? msg.envelope?.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      references,
      threadId: msg.threadId ?? null,
      emailId: msg.emailId ?? null,
      labels: msg.labels ? [...msg.labels] : [],
      from,
      to,
      cc,
      date: date.toISOString(),
      hasAttachments: attachments.length > 0,
      attachments,
      size: msg.size ?? msg.source?.length ?? null,
      seen,
      flagged,
      answered,
      flags: { bulk: flags.bulk, noreply: flags.noreply, auto: flags.auto, list_id: flags.list_id, seen, flagged, answered },
    },
  };
}

function isAuthError(e: unknown): boolean {
  const err = e as { authenticationFailed?: boolean; code?: string; serverResponseCode?: string; message?: string } | undefined;
  if (!err) return false;
  if (err.authenticationFailed) return true;
  const code = String(err.code ?? err.serverResponseCode ?? "").toUpperCase();
  if (code === "AUTHENTICATIONFAILED" || code === "AUTHORIZATIONFAILED") return true;
  return /AUTHENTICATIONFAILED|invalid credentials|authentication failed|LOGIN failed|application-specific password/i.test(String(err.message ?? ""));
}

function searchResultToUids(r: number[] | false | undefined | { all?: number[] }): number[] {
  if (!r) return [];
  if (Array.isArray(r)) return r;
  return Array.isArray(r.all) ? r.all : [];
}

// ── Sensor ──────────────────────────────────────────────────────────

export interface ImapSensorOptions {
  createClient?: ImapClientFactory;
  parse?: MailParser;
}

export function createImapSensor(opts: ImapSensorOptions = {}): Sensor {
  const createClient = opts.createClient ?? defaultClientFactory;
  const parse = opts.parse ?? defaultParser;
  return {
    name: IMAP_SOURCE,
    description: "IMAP mailbox (Gmail app password or any IMAP server): new messages as email signals",

    configured(config): boolean {
      return Boolean(config.host && config.user && config.password);
    },

    async poll(ctx: SensorContext): Promise<SensorPollResult> {
      const warnings = new Warnings();
      const signals: NewSignal[] = [];
      const host = String(ctx.config.host ?? "imap.gmail.com");
      const port = Number(ctx.config.port ?? 993);
      const user = String(ctx.config.user ?? "");
      const pass = String(ctx.config.password ?? "");
      const mailbox = String(ctx.config.mailbox ?? "INBOX");
      const sinceDays = Math.max(0, Number(ctx.config.since_days ?? 7));
      const maxMessages = Math.max(1, Number(ctx.config.max_messages ?? 50));
      const locale = String(ctx.config.locale ?? "zh-CN");
      if (!host || !user || !pass) throw new SensorConfigError("imap: host, user and password are required");

      const account = sha1(`${host}:${port}:${user}`).slice(0, 12);
      const now = ctx.now();
      const client = createClient({
        host,
        port,
        secure: port === 993 || ctx.config.secure !== false,
        auth: { user, pass },
        logger: false,
        connectionTimeout: CONNECT_TIMEOUT_MS,
        greetingTimeout: CONNECT_TIMEOUT_MS,
        socketTimeout: 120_000,
        disableAutoIdle: true,
        clientInfo: { name: "taskcenter", version: "0.1" },
      });

      try {
        await withTimeout(client.connect(), CONNECT_TIMEOUT_MS + 2000, "imap connect");
      } catch (e) {
        if (isAuthError(e)) throw new SensorConfigError(`imap: authentication failed for ${user}@${host} (${errorMessage(e)})`);
        warnings.add(`imap connect ${host}: ${errorMessage(e)}`);
        ctx.logger.warn("imap connect failed", { host, error: errorMessage(e) });
        try {
          client.close?.();
        } catch {
          /* ignore */
        }
        return { signals, warnings: warnings.list, summary: "connect failed" };
      }

      let lock: { release(): void } | undefined;
      let processed = 0;
      let queued = 0;
      try {
        lock = await withTimeout(client.getMailboxLock(mailbox), CONNECT_TIMEOUT_MS, "imap mailbox lock");
        const mb = client.mailbox;
        if (!mb) throw new Error(`mailbox ${mailbox} not selected`);
        const uidValidity = String(mb.uidValidity);
        const prevValidity = ctx.cursors.get("uidvalidity");
        const prevAccount = ctx.cursors.get("account");
        const prevMailbox = ctx.cursors.get("mailbox");
        let lastUid = Number(ctx.cursors.get("last_uid") ?? 0) || 0;
        if (prevValidity !== uidValidity || prevAccount !== account || prevMailbox !== mailbox) {
          if (prevValidity !== undefined) ctx.logger.info("imap cursor reset (uidvalidity/account/mailbox changed)", { from: prevValidity, to: uidValidity });
          lastUid = 0;
        }

        let uids: number[];
        if (lastUid === 0) {
          const since = daysAgo(sinceDays, now);
          const found = searchResultToUids(await withTimeout(client.search({ since }, { uid: true }), CONNECT_TIMEOUT_MS, "imap search"));
          uids = found.sort((a, b) => a - b).slice(-maxMessages);
          // nothing in range: start from the next uid so later polls are incremental
          if (uids.length === 0) lastUid = Math.max(0, mb.uidNext - 1);
        } else {
          const found = searchResultToUids(await withTimeout(client.search({ uid: `${lastUid + 1}:*` }, { uid: true }), CONNECT_TIMEOUT_MS, "imap search"));
          const fresh = found.filter((u) => u > lastUid).sort((a, b) => a - b);
          queued = Math.max(0, fresh.length - maxMessages);
          uids = fresh.slice(0, maxMessages);
        }

        let maxUid = lastUid;
        if (uids.length) {
          const query = { uid: true, envelope: true, flags: true, internalDate: true, source: true, threadId: true, labels: true, size: true };
          for await (const msg of client.fetch(uids, query, { uid: true })) {
            try {
              if (!msg.source) throw new Error("no source");
              const parsed = await parse(msg.source);
              signals.push(messageToSignal(msg, parsed, { uidValidity, mailbox, host, locale }));
              processed++;
            } catch (e) {
              warnings.add(`uid ${msg.uid}: ${errorMessage(e)}`);
            }
            if (msg.uid > maxUid) maxUid = msg.uid;
          }
        }
        ctx.cursors.set("uidvalidity", uidValidity);
        ctx.cursors.set("account", account);
        ctx.cursors.set("mailbox", mailbox);
        ctx.cursors.set("last_uid", String(maxUid));
        if (queued > 0) warnings.add(`${queued} more message(s) pending (max_messages=${maxMessages})`);
      } catch (e) {
        if (isAuthError(e)) throw new SensorConfigError(`imap: ${errorMessage(e)}`);
        warnings.add(`imap ${mailbox}: ${errorMessage(e)}`);
        ctx.logger.warn("imap poll failed", { error: errorMessage(e) });
      } finally {
        try {
          lock?.release();
        } catch {
          /* ignore */
        }
        try {
          await withTimeout(client.logout(), 5000, "imap logout");
        } catch {
          try {
            client.close?.();
          } catch {
            /* ignore */
          }
        }
      }
      return { signals, warnings: warnings.list, summary: `${processed} message(s) fetched from ${mailbox}${queued ? `, ${queued} queued` : ""}` };
    },
  };
}

export const imapSensor = createImapSensor();
