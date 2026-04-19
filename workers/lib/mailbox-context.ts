// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface MailboxRef {
	id: string;
	email: string;
}

interface ResolveMailboxIdArgs {
	mailboxId?: string;
	listMailboxes: () => Promise<MailboxRef[]>;
}

/**
 * Resolve mailbox context for MCP tools.
 *
 * Behavior:
 * 1) If mailboxId is provided, normalize and return it.
 * 2) If mailboxId is omitted and only one mailbox exists, auto-select it.
 * 3) If none/many mailboxes exist, throw an explicit error so callers can
 *    prompt users to choose a mailbox.
 */
export async function resolveMailboxId(args: ResolveMailboxIdArgs): Promise<string> {
	if (args.mailboxId?.trim()) {
		return args.mailboxId.trim().toLowerCase();
	}

	const mailboxes = await args.listMailboxes();
	if (mailboxes.length === 0) {
		throw new Error("No mailboxes found. Create a mailbox first, then retry.");
	}

	if (mailboxes.length === 1) {
		return mailboxes[0].id.toLowerCase();
	}

	const mailboxList = mailboxes.map((m) => m.id).join(", ");
	throw new Error(
		`Multiple mailboxes found (${mailboxList}). Provide mailboxId explicitly.`,
	);
}
