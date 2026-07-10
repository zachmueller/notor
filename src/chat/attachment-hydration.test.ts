/**
 * Tests for Part 3 dispatch-time attachment hydration.
 *
 * Covers the vault-free paths: text-note hydration produces the same content
 * the pre-refactor inline assembly would have, legacy/non-user/no-attachment
 * messages pass through by identity (never mutated).
 */

import { describe, it, expect } from "vitest";
import { hydrateMessageForDispatch } from "./attachment-hydration";
import {
	buildAttachmentSnapshot,
	createVaultNoteAttachment,
	type Attachment,
} from "../context/attachment";
import { getTextContent } from "../media/types";
import type { Message } from "../types";

const app = {} as never; // text-note + passthrough paths never touch the vault

function resolvedNote(path: string, content: string): Attachment {
	return { ...createVaultNoteAttachment(path), content, content_length: content.length, status: "resolved" };
}

function userMsg(partial: Partial<Message>): Message {
	return {
		id: "m1",
		conversation_id: "c1",
		role: "user",
		content: "hello",
		timestamp: "2026-01-01T00:00:00.000Z",
		...partial,
	} as Message;
}

describe("hydrateMessageForDispatch", () => {
	it("prepends the rebuilt <attachments> block ahead of the prose", async () => {
		const snap = buildAttachmentSnapshot(resolvedNote("Climate.md", "Climate content."));
		const msg = userMsg({ content: "Summarize this.", attachments: [snap] });

		const out = await hydrateMessageForDispatch(app, msg);
		const text = getTextContent(out.content);

		expect(text).toContain("<attachments>");
		expect(text).toContain("Climate content.");
		expect(text.trimEnd().endsWith("Summarize this.")).toBe(true);
		// Original message is never mutated.
		expect(msg.content).toBe("Summarize this.");
		expect(out).not.toBe(msg);
	});

	it("passes non-user messages through by identity", async () => {
		const msg = userMsg({ role: "assistant", content: "hi" });
		expect(await hydrateMessageForDispatch(app, msg)).toBe(msg);
	});

	it("passes messages with no attachments through by identity", async () => {
		const msg = userMsg({ content: "just prose" });
		expect(await hydrateMessageForDispatch(app, msg)).toBe(msg);
	});

	it("passes legacy (metadata-only) messages through by identity", async () => {
		const msg = userMsg({
			content: "<attachments>\n  <vault-note path=\"A.md\">old</vault-note>\n</attachments>\n\nprose",
			attachments: [
				{
					id: "1",
					type: "vault_note",
					path: "A.md",
					section: null,
					display_name: "A",
					content_length: 3,
					status: "resolved",
				},
			],
		});
		expect(await hydrateMessageForDispatch(app, msg)).toBe(msg);
	});
});
