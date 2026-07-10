/**
 * Tests for Part 3 attachment snapshot persistence + reconstruction.
 *
 * Covers the pure/vault-free paths: display-name stripping, snapshot building,
 * the new-format discriminator, and reconstruction of text + external-media
 * snapshots (vault-media reconstruction needs a live vault and is exercised in
 * E2E). Also asserts the dispatch block byte-matches the pre-refactor inline
 * assembly for a text note (truncation-parity guard).
 */

import { describe, it, expect } from "vitest";
import {
	createVaultNoteAttachment,
	createVaultNoteSectionAttachment,
	createExternalBinaryAttachment,
	buildAttachmentSnapshot,
	hasAttachmentSnapshot,
	reconstructResolvedAttachment,
	buildAttachmentsBlock,
	type Attachment,
} from "./attachment";

describe("noteDisplayName (via factories)", () => {
	it("strips a single trailing .md from vault notes", () => {
		expect(createVaultNoteAttachment("Research/Climate.md").display_name).toBe("Climate");
		expect(createVaultNoteAttachment("Climate.md").display_name).toBe("Climate");
	});

	it("only strips one .md", () => {
		expect(createVaultNoteAttachment("Foo.md.md").display_name).toBe("Foo.md");
	});

	it("leaves notes without .md untouched", () => {
		expect(createVaultNoteAttachment("Untitled").display_name).toBe("Untitled");
	});

	it("strips .md in section display names", () => {
		expect(createVaultNoteSectionAttachment("Budget.md", "Q3").display_name).toBe("Budget § Q3");
	});

	it("does not strip real media extensions", () => {
		// The image factory shares the split idiom but must keep its extension.
		const img = createExternalBinaryAttachment("/tmp/a.png", "a.png", "AAAA", "image/png");
		expect(img.display_name).toBe("a.png");
	});
});

function resolvedNote(path: string, content: string): Attachment {
	return { ...createVaultNoteAttachment(path), content, content_length: content.length, status: "resolved" };
}

describe("buildAttachmentSnapshot", () => {
	it("stores full content for text notes and no hash/binary", () => {
		const snap = buildAttachmentSnapshot(resolvedNote("A.md", "hello world"));
		expect(snap.content).toBe("hello world");
		expect(snap.content_hash).toBeUndefined();
		expect(snap.binary_content).toBeUndefined();
		expect(hasAttachmentSnapshot(snap)).toBe(true);
	});

	it("stores a hash (not base64) for vault images", () => {
		const img: Attachment = {
			...createVaultNoteAttachment("pic.png"), // base fields
			type: "vault_image",
			binary_content: "BIGBASE64",
			content_hash: "abc123",
			media_type: "image/png",
			width: 100,
			height: 50,
			status: "resolved",
		};
		const snap = buildAttachmentSnapshot(img);
		expect(snap.content_hash).toBe("abc123");
		expect(snap.binary_content).toBeUndefined(); // no base64 bloat for vault media
		expect(snap.media_type).toBe("image/png");
		expect(snap.width).toBe(100);
		expect(hasAttachmentSnapshot(snap)).toBe(true);
	});

	it("keeps base64 for external images (no re-resolvable source)", () => {
		const ext = createExternalBinaryAttachment("/tmp/a.png", "a.png", "EXTB64", "image/png", 10, 20);
		const snap = buildAttachmentSnapshot(ext);
		expect(snap.binary_content).toBe("EXTB64");
		expect(snap.media_type).toBe("image/png");
		expect(hasAttachmentSnapshot(snap)).toBe(true);
	});
});

describe("hasAttachmentSnapshot", () => {
	it("is false for a legacy metadata-only record", () => {
		expect(
			hasAttachmentSnapshot({
				id: "1",
				type: "vault_note",
				path: "A.md",
				section: null,
				display_name: "A",
				content_length: 3,
				status: "resolved",
			}),
		).toBe(false);
	});
});

describe("reconstructResolvedAttachment (vault-free paths)", () => {
	const app = {} as never; // text + external paths never touch the vault

	it("rebuilds a text note from its content snapshot without disk access", async () => {
		const snap = buildAttachmentSnapshot(resolvedNote("A.md", "body text"));
		const { attachment, warning } = await reconstructResolvedAttachment(app, snap);
		expect(warning).toBeUndefined();
		expect(attachment?.type).toBe("vault_note");
		expect(attachment?.content).toBe("body text");
		expect(attachment?.status).toBe("resolved");
	});

	it("rebuilds an external image from stored base64", async () => {
		const ext = createExternalBinaryAttachment("/tmp/a.png", "a.png", "EXTB64", "image/png", 10, 20);
		const snap = buildAttachmentSnapshot(ext);
		const { attachment } = await reconstructResolvedAttachment(app, snap);
		expect(attachment?.binary_content).toBe("EXTB64");
		expect(attachment?.media_type).toBe("image/png");
	});

	it("drops an external image whose bytes are gone", async () => {
		const snap = {
			id: "1",
			type: "external_image",
			path: "/tmp/a.png",
			section: null,
			display_name: "a.png",
			content_length: null,
			status: "resolved",
			binary_content: null,
			media_type: "image/png",
		};
		const { attachment, warning } = await reconstructResolvedAttachment(app, snap);
		expect(attachment).toBeNull();
		expect(warning).toBeTruthy();
	});
});

describe("dispatch block parity", () => {
	it("rebuilt <attachments> matches the original inline assembly for a text note", async () => {
		const original = resolvedNote("Research/Climate.md", "Climate content here.");
		const inline = buildAttachmentsBlock([original]).text;

		const snap = buildAttachmentSnapshot(original);
		const { attachment } = await reconstructResolvedAttachment({} as never, snap);
		const rebuilt = buildAttachmentsBlock([attachment!]).text;

		expect(rebuilt).toBe(inline);
	});
});
