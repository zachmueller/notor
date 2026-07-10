/**
 * Dispatch-time attachment hydration (Part 3).
 *
 * User messages persist only the user's typed prose in their `content`; the
 * resolved attachment content lives in the per-message `attachments` snapshot
 * (see `PersistedAttachmentMeta` / `buildAttachmentSnapshot`). This module
 * rebuilds the `<attachments>` XML block + media `ContentBlock[]` from that
 * snapshot and merges it back into the message content ONLY at dispatch time,
 * so the heavy content reaches the LLM without ever touching stored/displayed
 * content.
 *
 * Hydration never mutates the input message — it returns a new object (or the
 * original by identity when there is nothing to hydrate). This matters because
 * `ConversationManager.getMessages()` shares stored Message object references.
 *
 * @see src/context/attachment.ts — buildAttachmentSnapshot / reconstructResolvedAttachment
 */

import type { App } from "obsidian";
import type { Attachment } from "../context/attachment";
import {
	buildAttachmentsBlock,
	hasAttachmentSnapshot,
	reconstructResolvedAttachment,
} from "../context/attachment";
import { assembleUserMessage, assembleUserContent } from "../context/message-assembler";
import { getTextContent } from "../media/types";
import type { Message } from "../types";
import { logger } from "../utils/logger";

const log = logger("AttachmentHydration");

/** Image processing settings threaded through to re-resolution of vault media. */
export interface HydrationImageSettings {
	maxDimension: number;
	compressionQuality: number;
}

/**
 * Rebuild a user message's dispatch content from its attachment snapshot.
 *
 * Returns the original message unchanged (by identity) when there is nothing to
 * hydrate: non-user messages, messages without attachments, and legacy messages
 * whose attachment content is still embedded in `content` (no Part-3 snapshot).
 *
 * @param onWarn - Invoked once per attachment that could not be faithfully
 *   reconstructed (missing/edited source, unavailable external bytes). The turn
 *   still proceeds with whatever could be rebuilt.
 */
export async function hydrateMessageForDispatch(
	app: App,
	msg: Message,
	imageSettings?: HydrationImageSettings,
	providerType?: string,
	onWarn?: (warning: string) => void,
): Promise<Message> {
	if (msg.role !== "user") return msg;
	const snapshots = msg.attachments;
	if (!snapshots || snapshots.length === 0) return msg;
	if (!snapshots.some(hasAttachmentSnapshot)) return msg; // legacy — leave inert

	const resolved: Attachment[] = [];
	for (const meta of snapshots) {
		if (!hasAttachmentSnapshot(meta)) continue;
		const { attachment, warning } = await reconstructResolvedAttachment(
			app,
			meta,
			imageSettings,
			providerType,
		);
		if (warning) {
			onWarn?.(warning);
			log.warn("Attachment hydration warning", { path: meta.path, warning });
		}
		if (attachment) resolved.push(attachment);
	}

	if (resolved.length === 0) return msg;

	const { text, contentBlocks } = buildAttachmentsBlock(resolved);
	if (!text && contentBlocks.length === 0) return msg;

	// Stored content is prose-only; prepend the reconstructed attachments block.
	const prose = getTextContent(msg.content);
	const assembledText = assembleUserMessage({
		attachments: text ?? undefined,
		userText: prose,
	});
	const hydratedContent = assembleUserContent(assembledText, contentBlocks);

	return { ...msg, content: hydratedContent };
}

/**
 * Hydrate a list of messages for dispatch, in parallel. Non-hydratable messages
 * pass through by identity. The stored messages are never mutated.
 */
export async function hydrateMessagesForDispatch(
	app: App,
	msgs: Message[],
	imageSettings?: HydrationImageSettings,
	providerType?: string,
	onWarn?: (warning: string) => void,
): Promise<Message[]> {
	return Promise.all(
		msgs.map((m) => hydrateMessageForDispatch(app, m, imageSettings, providerType, onWarn)),
	);
}
