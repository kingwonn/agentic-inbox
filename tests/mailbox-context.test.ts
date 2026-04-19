import test from "node:test";
import assert from "node:assert/strict";
import { resolveMailboxId } from "../workers/lib/mailbox-context";

test("resolveMailboxId prefers explicit mailboxId", async () => {
	const mailboxId = await resolveMailboxId({
		mailboxId: "Sales@Example.com",
		listMailboxes: async () => [{ id: "support@example.com", email: "support@example.com" }],
	});

	assert.equal(mailboxId, "sales@example.com");
});

test("resolveMailboxId auto-selects when only one mailbox exists", async () => {
	const mailboxId = await resolveMailboxId({
		listMailboxes: async () => [{ id: "support@example.com", email: "support@example.com" }],
	});

	assert.equal(mailboxId, "support@example.com");
});

test("resolveMailboxId throws when there are no mailboxes", async () => {
	await assert.rejects(
		() =>
			resolveMailboxId({
				listMailboxes: async () => [],
			}),
		/No mailboxes found/,
	);
});

test("resolveMailboxId throws when multiple mailboxes exist and none provided", async () => {
	await assert.rejects(
		() =>
			resolveMailboxId({
				listMailboxes: async () => [
					{ id: "support@example.com", email: "support@example.com" },
					{ id: "sales@example.com", email: "sales@example.com" },
				],
			}),
		/Multiple mailboxes found/,
	);
});
