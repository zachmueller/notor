/**
 * Tests for Part 3 metadata-aware attachment token estimation.
 */

import { describe, it, expect } from "vitest";
import { estimateAttachmentSnapshotTokens, estimateTokenCount } from "./tokens";
import type { PersistedAttachmentMeta } from "../types";

const textSnap: PersistedAttachmentMeta = {
	id: "1",
	type: "vault_note",
	path: "A.md",
	section: null,
	display_name: "A",
	content_length: 8,
	status: "resolved",
	content: "abcdefgh",
};

const legacyMeta: PersistedAttachmentMeta = {
	id: "2",
	type: "vault_note",
	path: "B.md",
	section: null,
	display_name: "B",
	content_length: 8,
	status: "resolved",
	// no content/content_hash/binary_content — legacy record
};

describe("estimateAttachmentSnapshotTokens", () => {
	it("returns 0 for empty/nullish input", () => {
		expect(estimateAttachmentSnapshotTokens(null)).toBe(0);
		expect(estimateAttachmentSnapshotTokens(undefined)).toBe(0);
		expect(estimateAttachmentSnapshotTokens([])).toBe(0);
	});

	it("counts text content plus a small wrapper overhead", () => {
		expect(estimateAttachmentSnapshotTokens([textSnap])).toBe(estimateTokenCount("abcdefgh") + 8);
	});

	it("ignores legacy records (content already embedded in message content)", () => {
		expect(estimateAttachmentSnapshotTokens([legacyMeta])).toBe(0);
	});

	it("uses image dimensions for vault image snapshots", () => {
		const img: PersistedAttachmentMeta = {
			id: "3",
			type: "vault_image",
			path: "p.png",
			section: null,
			display_name: "p.png",
			content_length: null,
			status: "resolved",
			content_hash: "hash",
			media_type: "image/png",
			width: 300,
			height: 300,
		};
		// Anthropic heuristic: ceil(w*h/750)
		expect(estimateAttachmentSnapshotTokens([img])).toBe(Math.ceil((300 * 300) / 750));
	});
});
