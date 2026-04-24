/**
 * ChatBlockRegistry — maps block kinds to their render and wire-serialization definitions.
 *
 * @see specs/ZZ-misc/extension-chat-blocks-design.md — Section 5
 */

import type { Message } from "../../types";
import type { App } from "obsidian";
import type { CollapsibleCard, CollapsibleCardOpts } from "./collapsible-card";
import type { PendingMemoryManager } from "../../memory/pending-memory-manager";
import { logger } from "../../utils/logger";

const log = logger("ChatBlockRegistry");

export interface ChatBlockRenderContext {
	message: Message;
	app: App;
	openInternalLink: (linkText: string) => void;
	collapsibleCard: (container: HTMLElement, opts: CollapsibleCardOpts) => CollapsibleCard;
	/** Available when the memory subsystem is enabled; null otherwise. */
	pendingMemoryManager: PendingMemoryManager | null;
}

export interface ChatBlockDefinition<TData extends Record<string, unknown> = Record<string, unknown>> {
	kind: string;
	displayName: string;
	icon?: string;
	render: (container: HTMLElement, data: TData, ctx: ChatBlockRenderContext) => void;
	toLLMText?: (data: TData) => string | null;
	excludeFromCompaction?: boolean;
	renderLoading?: (container: HTMLElement, ctx: ChatBlockRenderContext) => void;
}

export class ChatBlockRegistry {
	private readonly _defs = new Map<string, ChatBlockDefinition>();

	register(def: ChatBlockDefinition): void {
		if (this._defs.has(def.kind)) {
			log.error("Duplicate block kind registration — keeping first", { kind: def.kind });
			return;
		}
		this._defs.set(def.kind, def);
	}

	unregister(kind: string): void {
		this._defs.delete(kind);
	}

	get(kind: string): ChatBlockDefinition | undefined {
		return this._defs.get(kind);
	}

	has(kind: string): boolean {
		return this._defs.has(kind);
	}

	list(): ChatBlockDefinition[] {
		return Array.from(this._defs.values());
	}
}
