/**
 * UI-free wikilink → attachment extraction.
 *
 * Shared by the chat input's paste handler (which splices each link in as an
 * inline token) and the external `plugin.api` (which attaches linked notes to
 * a programmatic prompt), so both treat `[[Note]]`, `[[Note#Section]]`, and
 * `[[Note|alias]]` identically.
 */

import type { App } from "obsidian";
import {
	buildAttachmentsBlock,
	createVaultNoteAttachment,
	createVaultNoteSectionAttachment,
	isDuplicate,
	resolveAttachment,
} from "./attachment";
import type { Attachment } from "./attachment";
import { assembleUserMessage } from "./message-assembler";

/** A run of plain text or a resolved wikilink, in source order. */
export type WikilinkSegment =
	| { kind: "text"; text: string }
	| { kind: "link"; raw: string; attachment: Attachment };

const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

/**
 * Split `text` into plain-text runs and resolvable wikilinks.
 *
 * Resolution uses Obsidian's own linkpath resolver so behaviour matches the
 * main editor. Only Markdown notes become links; unresolvable links, media
 * targets, and notes already present in `existing` (or earlier in `text`) stay
 * inline as plain text. A `|alias` suffix is ignored for resolution.
 */
export function parseWikilinkSegments(
	app: App,
	text: string,
	existing: readonly Attachment[] = [],
): WikilinkSegment[] {
	const segments: WikilinkSegment[] = [];
	if (!text.includes("[[")) {
		if (text) segments.push({ kind: "text", text });
		return segments;
	}

	const seen: Attachment[] = [...existing];
	let lastIndex = 0;
	let match: RegExpExecArray | null;
	const pattern = new RegExp(WIKILINK_PATTERN.source, "g");

	while ((match = pattern.exec(text)) !== null) {
		const attachment = resolveWikilink(app, match[1] ?? "");
		if (!attachment || isDuplicate(seen, { path: attachment.path, section: attachment.section })) {
			continue;
		}

		const before = text.slice(lastIndex, match.index);
		if (before) segments.push({ kind: "text", text: before });
		segments.push({ kind: "link", raw: match[0], attachment });
		seen.push(attachment);
		lastIndex = match.index + match[0].length;
	}

	const after = text.slice(lastIndex);
	if (after) segments.push({ kind: "text", text: after });
	return segments;
}

/**
 * Resolve the inner text of a `[[...]]` link to a pending note (or note
 * section) attachment, or null when it isn't a resolvable Markdown note.
 */
function resolveWikilink(app: App, inner: string): Attachment | null {
	const pipeIdx = inner.indexOf("|");
	const target = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
	const hashIdx = target.indexOf("#");
	const linkpath = (hashIdx === -1 ? target : target.slice(0, hashIdx)).trim();
	const section = hashIdx === -1 ? null : target.slice(hashIdx + 1).trim();

	const dest = linkpath ? app.metadataCache.getFirstLinkpathDest(linkpath, "") : null;
	if (!dest || dest.extension !== "md") return null;

	return section && section.length > 0
		? createVaultNoteSectionAttachment(dest.path, section)
		: createVaultNoteAttachment(dest.path);
}

/**
 * Extract the attachments a prompt's wikilinks refer to. The returned text
 * renders each attached link the way a chat-input token does
 * (`[[display name]]`), so the model sees the same prose as in chat.
 */
export function extractWikilinkAttachments(
	app: App,
	text: string,
): { text: string; attachments: Attachment[] } {
	const attachments: Attachment[] = [];
	let out = "";
	for (const seg of parseWikilinkSegments(app, text)) {
		if (seg.kind === "text") {
			out += seg.text;
		} else {
			out += `[[${seg.attachment.display_name}]]`;
			attachments.push(seg.attachment);
		}
	}
	return { text: out, attachments };
}

/**
 * Build a self-contained prompt with each wikilinked note's content inlined
 * as an `<attachments>` block ahead of the prose. For paths that never hydrate
 * attachment snapshots (headless workflows, circuit objectives).
 */
export async function buildPromptWithAttachments(
	app: App,
	text: string,
): Promise<{ prompt: string; attachments: Attachment[] }> {
	const extracted = extractWikilinkAttachments(app, text);
	if (extracted.attachments.length === 0) {
		return { prompt: extracted.text, attachments: [] };
	}

	const resolved = await Promise.all(extracted.attachments.map((a) => resolveAttachment(app, a)));
	const block = buildAttachmentsBlock(resolved);
	return {
		prompt: assembleUserMessage({ attachments: block.text ?? undefined, userText: extracted.text }),
		attachments: resolved,
	};
}
