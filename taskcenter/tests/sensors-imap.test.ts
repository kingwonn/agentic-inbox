import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";
import type { LoadedConfig } from "../src/config/load.js";
import { openDb } from "../src/core/db.js";
import { silentLogger } from "../src/core/logger.js";
import { Repo } from "../src/core/repo.js";
import { createImapSensor, gmailThreadUrl, type ImapClientLike, type ImapClientOptions, type ImapFetchedMessage } from "../src/sensors/imap.js";
import { makeSensorContext, type SensorEntry } from "../src/sensors/registry.js";
import { SensorConfigError } from "../src/sensors/util.js";

const ROOT = resolve(import.meta.dirname, "..");

function harness() {
  const repo = new Repo(openDb(":memory:"));
  const loaded: LoadedConfig = { config: ConfigSchema.parse({}), configPath: null, rootDir: ROOT, resolve: (p) => (p.startsWith("/") ? p : resolve(ROOT, p)) };
  return { repo, loaded };
}

function rfc822(opts: { from: string; to?: string; subject: string; date: string; messageId: string; text?: string; html?: string; extraHeaders?: string[]; attachment?: boolean }): Buffer {
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to ?? "me@example.com"}`,
    `Subject: ${opts.subject}`,
    `Date: ${opts.date}`,
    `Message-ID: ${opts.messageId}`,
    "MIME-Version: 1.0",
    ...(opts.extraHeaders ?? []),
  ];
  if (opts.attachment) {
    const b = "BOUNDARY42";
    headers.push(`Content-Type: multipart/mixed; boundary="${b}"`);
    return Buffer.from(
      `${headers.join("\r\n")}\r\n\r\n--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${opts.text ?? ""}\r\n--${b}\r\nContent-Type: application/pdf; name="invoice.pdf"\r\nContent-Disposition: attachment; filename="invoice.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--${b}--\r\n`,
    );
  }
  if (opts.html) {
    headers.push("Content-Type: text/html; charset=utf-8");
    return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${opts.html}\r\n`);
  }
  headers.push("Content-Type: text/plain; charset=utf-8");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${opts.text ?? ""}\r\n`);
}

interface FakeMessage extends ImapFetchedMessage {
  received: Date;
}

/** In-memory IMAP server + client: records calls, supports since/uid-range search and fetch. */
class FakeImap implements ImapClientLike {
  calls: string[] = [];
  mailbox: { path: string; uidValidity: bigint; uidNext: number; exists: number } | false = false;
  connected = false;
  constructor(
    public store: { uidValidity: bigint; messages: FakeMessage[] },
    public failConnect?: Error,
  ) {}
  async connect() {
    this.calls.push("connect");
    if (this.failConnect) throw this.failConnect;
    this.connected = true;
  }
  async logout() {
    this.calls.push("logout");
    this.connected = false;
  }
  close() {
    this.calls.push("close");
  }
  async getMailboxLock(path: string) {
    this.calls.push(`lock:${path}`);
    const max = Math.max(0, ...this.store.messages.map((m) => m.uid));
    this.mailbox = { path, uidValidity: this.store.uidValidity, uidNext: max + 1, exists: this.store.messages.length };
    return { release: () => this.calls.push("release") };
  }
  async search(query: Record<string, unknown>) {
    this.calls.push(`search:${JSON.stringify(query, (_k, v) => (v instanceof Date ? v.toISOString() : v))}`);
    let list = this.store.messages;
    if (query.since instanceof Date) list = list.filter((m) => m.received >= (query.since as Date));
    if (typeof query.uid === "string") {
      const [lo] = query.uid.split(":").map(Number);
      const max = Math.max(0, ...this.store.messages.map((m) => m.uid));
      list = list.filter((m) => m.uid >= Math.min(lo, max)); // "N:*" quirk: returns the last message when N > max
    }
    return list.map((m) => m.uid);
  }
  async *fetch(range: number[] | string) {
    this.calls.push(`fetch:${Array.isArray(range) ? range.join(",") : range}`);
    const wanted = new Set(Array.isArray(range) ? range : []);
    for (const m of this.store.messages) if (wanted.has(m.uid)) yield m;
  }
}

function msg(uid: number, received: Date, src: Buffer, extra: Partial<FakeMessage> = {}): FakeMessage {
  return { uid, received, source: src, flags: new Set(), internalDate: received, size: src.length, ...extra };
}

function setup(store: FakeImap["store"], failConnect?: Error) {
  let client: FakeImap | undefined;
  let lastOptions: ImapClientOptions | undefined;
  const sensor = createImapSensor({
    createClient: (o) => {
      lastOptions = o;
      client = new FakeImap(store, failConnect);
      return client;
    },
  });
  const h = harness();
  const entry: SensorEntry = {
    sensor,
    config: { enabled: true, host: "imap.gmail.com", port: 993, user: "me@gmail.com", password: "app-pass", mailbox: "INBOX", since_days: 7, max_messages: 2, locale: "en" },
    enabled: true,
  };
  const now = new Date("2026-11-05T12:00:00Z");
  const poll = () => sensor.poll(makeSensorContext(entry, { repo: h.repo, logger: silentLogger, loaded: h.loaded, now: () => now }));
  return { sensor, h, entry, poll, client: () => client!, options: () => lastOptions!, now };
}

describe("sensors/imap", () => {
  const d = (s: string) => new Date(s);
  const store = {
    uidValidity: 1700000000n,
    messages: [
      msg(1, d("2026-10-01T10:00:00Z"), rfc822({ from: "Old <old@example.com>", subject: "ancient", date: "Thu, 01 Oct 2026 10:00:00 +0000", messageId: "<old@x>", text: "too old" })),
      msg(
        5,
        d("2026-11-03T10:00:00Z"),
        rfc822({
          from: "Alice Smith <alice@example.com>",
          subject: "Lunch tomorrow?",
          date: "Tue, 03 Nov 2026 10:00:00 +0000",
          messageId: "<a1@example.com>",
          text: "Hi,\n\nAre you free for lunch tomorrow at 12?\n\nAlice",
          attachment: true,
        }),
        { threadId: "1234567890123456789", flags: new Set(["\\Seen"]) },
      ),
      msg(
        7,
        d("2026-11-04T09:00:00Z"),
        rfc822({
          from: "GitHub <noreply@github.com>",
          subject: "[repo] New release",
          date: "Wed, 04 Nov 2026 09:00:00 +0000",
          messageId: "<n1@github.com>",
          html: "<html><body><p>Hello <b>there</b></p><p>Release <a href='x'>v1</a> is out</p><style>p{}</style></body></html>",
          extraHeaders: ["List-Unsubscribe: <https://github.com/unsub>", "Precedence: bulk"],
        }),
      ),
    ],
  };

  it("seeds from since_days on first run (capped) and sets the uid cursor", async () => {
    const s = setup(store);
    const r1 = await s.poll();
    expect(r1.warnings ?? []).toEqual([]);
    expect(s.options().auth).toEqual({ user: "me@gmail.com", pass: "app-pass" });
    expect(s.options().secure).toBe(true);
    expect(s.client().calls[0]).toBe("connect");
    expect(s.client().calls.some((c) => c.startsWith('search:{"since":"2026-10-29'))).toBe(true);
    expect(s.client().calls.at(-2)).toBe("release");
    expect(s.client().calls.at(-1)).toBe("logout");
    expect(r1.signals.map((x) => x.external_id)).toEqual(["1700000000:5", "1700000000:7"]);

    const lunch = r1.signals[0];
    expect(lunch.kind).toBe("email");
    expect(lunch.title).toBe("Lunch tomorrow?");
    expect(lunch.actor).toBe("alice@example.com");
    expect(lunch.body).toContain("From: Alice Smith <alice@example.com>");
    expect(lunch.body).toContain("Are you free for lunch tomorrow at 12?");
    expect(lunch.occurred_at).toBe("2026-11-03T10:00:00.000Z");
    expect(lunch.url).toBe(gmailThreadUrl("imap.gmail.com", "1234567890123456789"));
    expect(lunch.metadata).toMatchObject({
      uid: 5,
      messageId: "<a1@example.com>",
      threadId: "1234567890123456789",
      hasAttachments: true,
      seen: true,
      from: { name: "Alice Smith", address: "alice@example.com" },
    });
    expect((lunch.metadata?.attachments as Array<{ filename: string }>)[0].filename).toBe("invoice.pdf");
    expect((lunch.metadata?.flags as { bulk: boolean }).bulk).toBe(false);

    const release = r1.signals[1];
    expect(release.actor).toBe("noreply@github.com");
    expect(release.body).toContain("Hello there");
    expect(release.body).toContain("Release v1 is out");
    expect(release.body).not.toContain("<b>");
    expect(release.body).toContain("[bulk/notification mail]");
    expect(release.metadata?.flags).toMatchObject({ bulk: true, noreply: true, seen: false });

    expect(s.h.repo.cursors.get("imap", "uidvalidity")).toBe("1700000000");
    expect(s.h.repo.cursors.get("imap", "last_uid")).toBe("7");
    for (const sig of r1.signals) expect(s.h.repo.signals.upsert(sig).isNew).toBe(true);

    // second poll: incremental search, nothing new (server returns last message for "8:*")
    const r2 = await s.poll();
    expect(r2.signals).toEqual([]);
    expect(s.client().calls.some((c) => c === 'search:{"uid":"8:*"}')).toBe(true);
    expect(s.client().calls.some((c) => c.startsWith("fetch:"))).toBe(false);

    // new mail arrives
    store.messages.push(msg(9, d("2026-11-05T08:00:00Z"), rfc822({ from: "bob@example.com", subject: "Re: Lunch", date: "Thu, 05 Nov 2026 08:00:00 +0000", messageId: "<b1@x>", text: "Sure!", extraHeaders: ["In-Reply-To: <a1@example.com>", "References: <a1@example.com>"] })));
    const r3 = await s.poll();
    expect(r3.signals.map((x) => x.external_id)).toEqual(["1700000000:9"]);
    expect(r3.signals[0].metadata?.inReplyTo).toBe("<a1@example.com>");
    expect(r3.signals[0].metadata?.references).toEqual(["<a1@example.com>"]);
    expect(s.h.repo.cursors.get("imap", "last_uid")).toBe("9");

    // uidvalidity change -> reseed from since_days
    store.uidValidity = 1800000000n;
    const r4 = await s.poll();
    expect(s.client().calls.some((c) => c.startsWith('search:{"since"'))).toBe(true);
    expect(r4.signals.every((x) => x.external_id.startsWith("1800000000:"))).toBe(true);
    expect(r4.warnings?.some((w) => w.includes("pending"))).toBe(true); // 3 recent messages, max 2
    store.messages.pop();
    store.uidValidity = 1700000000n;
  });

  it("treats connection problems as warnings and auth failures as config errors", async () => {
    const s = setup(store, Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }));
    const r = await s.poll();
    expect(r.signals).toEqual([]);
    expect(r.warnings?.[0]).toContain("ETIMEDOUT");
    const auth = setup(store, Object.assign(new Error("Invalid credentials (Failure)"), { authenticationFailed: true, code: "AUTHENTICATIONFAILED" }));
    await expect(auth.poll()).rejects.toBeInstanceOf(SensorConfigError);
  });

  it("configured() needs host/user/password", () => {
    const s = setup(store);
    expect(s.sensor.configured({ host: "x", user: "u", password: "p" })).toBe(true);
    expect(s.sensor.configured({ host: "x", user: "", password: "p" })).toBe(false);
  });

  it("builds gmail thread urls only for numeric thread ids on google hosts", () => {
    expect(gmailThreadUrl("imap.gmail.com", "1234567890")).toBe("https://mail.google.com/mail/u/0/#all/499602d2");
    expect(gmailThreadUrl("imap.fastmail.com", "1234567890")).toBe(null);
    expect(gmailThreadUrl("imap.gmail.com", "T1")).toBe(null);
  });
});
