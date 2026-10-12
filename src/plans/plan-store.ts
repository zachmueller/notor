/**
 * PlanStore — persists the latest plan document for each conversation.
 *
 * A plan is a conversation-owned artifact, stored as a sidecar next to the
 * conversation's JSONL in the plugin-dir history folder:
 *
 *   `{history_path}{conversationId}.plan.json`
 *
 * Living in the plugin directory means writing a plan needs no vault write
 * access, so it works in Plan mode. Only the latest revision is kept: a
 * re-submission overwrites the file. `HistoryManager.deleteConversationFile`
 * removes the sidecar when the conversation is deleted or pruned.
 *
 * @see ai/notor/ideas — "Plan document flow with inline commenting and hand-back"
 */

import { normalizePath, type DataAdapter } from "obsidian";
import type { AnchoredComment } from "../comments/types";
import { logger } from "../utils/logger";

const log = logger("PlanStore");

export type PlanStatus = "pending-review" | "changes-requested" | "approved" | "rejected";

export interface StoredPlan {
	schema_version: 1;
	conversation_id: string;
	title: string;
	/** The plan body as markdown. */
	markdown: string;
	status: PlanStatus;
	updated_at: string;
	/** Inline comments on the current revision that have not been sent yet. */
	comments: AnchoredComment[];
}

/** Filename suffix for plan sidecars inside the history directory. */
export const PLAN_SIDECAR_SUFFIX = ".plan.json";

/** Path of a conversation's plan sidecar, given the history directory. */
export function planSidecarPath(historyPath: string, conversationId: string): string {
	return normalizePath(`${historyPath}${historyPath.endsWith("/") ? "" : "/"}${conversationId}${PLAN_SIDECAR_SUFFIX}`);
}

export class PlanStore {
	private readonly cache = new Map<string, StoredPlan | null>();
	private readonly writeChains = new Map<string, Promise<void>>();
	private readonly listeners = new Set<(conversationId: string) => void>();

	constructor(
		private readonly adapter: Pick<DataAdapter, "exists" | "read" | "write" | "remove" | "mkdir">,
		private readonly getHistoryPath: () => string,
	) {}

	/** Subscribe to changes (submit / status / comments / delete). Returns an unsubscribe fn. */
	onChange(cb: (conversationId: string) => void): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	/** Synchronous read of an already-loaded plan (undefined = not loaded yet). */
	peek(conversationId: string): StoredPlan | null | undefined {
		return this.cache.get(conversationId);
	}

	async load(conversationId: string): Promise<StoredPlan | null> {
		if (this.cache.has(conversationId)) return this.cache.get(conversationId) ?? null;
		const path = this.pathFor(conversationId);
		let plan: StoredPlan | null = null;
		try {
			if (await this.adapter.exists(path)) {
				const parsed = JSON.parse(await this.adapter.read(path)) as Partial<StoredPlan>;
				if (parsed && typeof parsed.markdown === "string" && parsed.conversation_id === conversationId) {
					plan = {
						schema_version: 1,
						conversation_id: conversationId,
						title: typeof parsed.title === "string" ? parsed.title : "Plan",
						markdown: parsed.markdown,
						status: parsed.status ?? "pending-review",
						updated_at: parsed.updated_at ?? new Date(0).toISOString(),
						comments: Array.isArray(parsed.comments) ? parsed.comments : [],
					};
				} else {
					log.warn("Ignoring malformed plan file", { path });
				}
			}
		} catch (e) {
			log.warn("Failed to load plan", { conversationId, error: String(e) });
		}
		this.cache.set(conversationId, plan);
		return plan;
	}

	/**
	 * Store a (re)submitted plan, overwriting the previous revision.
	 *
	 * Pending comments are kept only when the markdown is byte-identical — the
	 * reload case, where `resumePendingToolCalls` re-executes the same
	 * `submit_plan` call. A real revision starts with no comments, since the
	 * old anchors no longer apply and their feedback was already sent.
	 */
	async submit(conversationId: string, title: string, markdown: string): Promise<StoredPlan> {
		const existing = await this.load(conversationId);
		const plan: StoredPlan = {
			schema_version: 1,
			conversation_id: conversationId,
			title,
			markdown,
			status: "pending-review",
			updated_at: new Date().toISOString(),
			comments: existing && existing.markdown === markdown ? existing.comments : [],
		};
		await this.persist(plan);
		return plan;
	}

	async setStatus(conversationId: string, status: PlanStatus): Promise<void> {
		const plan = await this.load(conversationId);
		if (!plan || plan.status === status) return;
		await this.persist({ ...plan, status, updated_at: new Date().toISOString() });
	}

	async updateComments(conversationId: string, comments: AnchoredComment[]): Promise<void> {
		const plan = await this.load(conversationId);
		if (!plan) return;
		await this.persist({ ...plan, comments: [...comments] });
	}

	async delete(conversationId: string): Promise<void> {
		const path = this.pathFor(conversationId);
		await this.enqueue(conversationId, async () => {
			try {
				if (await this.adapter.exists(path)) await this.adapter.remove(path);
			} catch (e) {
				log.warn("Failed to delete plan", { conversationId, error: String(e) });
			}
		});
		this.cache.set(conversationId, null);
		this.emit(conversationId);
	}

	/** Drop cached entries (e.g. after the history path changes). */
	invalidate(): void {
		this.cache.clear();
	}

	private pathFor(conversationId: string): string {
		return planSidecarPath(this.getHistoryPath(), conversationId);
	}

	private async persist(plan: StoredPlan): Promise<void> {
		this.cache.set(plan.conversation_id, plan);
		const path = this.pathFor(plan.conversation_id);
		const dir = path.slice(0, path.lastIndexOf("/"));
		await this.enqueue(plan.conversation_id, async () => {
			if (dir && !(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
			await this.adapter.write(path, JSON.stringify(plan, null, 2));
		});
		this.emit(plan.conversation_id);
	}

	/** Serialize writes per conversation so a later write never lands first. */
	private enqueue(conversationId: string, op: () => Promise<void>): Promise<void> {
		const prev = this.writeChains.get(conversationId) ?? Promise.resolve();
		const next = prev.then(op, op);
		this.writeChains.set(conversationId, next);
		void next.finally(() => {
			if (this.writeChains.get(conversationId) === next) this.writeChains.delete(conversationId);
		});
		return next;
	}

	private emit(conversationId: string): void {
		for (const cb of this.listeners) {
			try {
				cb(conversationId);
			} catch (e) {
				log.error("PlanStore listener failed", { error: String(e) });
			}
		}
	}
}
