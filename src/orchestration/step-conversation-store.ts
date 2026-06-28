/**
 * `StepConversationStore` (INT-006) — persists orchestration step conversations
 * with their `orchestration_edges` header and backfills the `next`/`prev` chain.
 *
 * Each conversation-step turn produces one **step conversation** whose JSONL
 * header carries the net-new orchestration fields (`_type:
 * "orchestration_step_conversation"`, `orchestration_session_id` /
 * `_flow_name` / `_step_name` / `_iteration`, and `orchestration_edges`). The
 * header schema is the **single authority of [contracts/edges.md]** — this module
 * references it and does not redefine it.
 *
 * **Edge backfill (Phase 2 — `next`/`prev` only).** When step turn N+1's
 * conversation is persisted with a `prev` edge to turn N, turn N's header is
 * updated with a reciprocal `next` edge (the same way the old scalar prev/next was
 * backfilled). The store remembers each conversation id's file path as it writes,
 * so the reciprocal backfill needs no directory scan. The chain is acyclic by
 * construction (strictly increasing iteration; each turn links only to the prior
 * one). `child`/`parent` edges are Phase-7 composition and are not produced here.
 *
 * Step conversations are written into the same history directory as ordinary
 * conversations but are **hidden from the flat list** by their `_type` marker
 * (the generalized `isHiddenFromConversationList` predicate, INT-006); the
 * run-tree (POL-003) is their only navigational surface.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-006
 * @see specs/ZZ-misc/orchestration/contracts/edges.md — §1/§2 header + edges
 */

import type { ChatMessage } from "../providers/provider";
import type { OrchestrationEdge } from "../types";
import { logger } from "../utils/logger";

const log = logger("StepConversationStore");

/** One step conversation to persist. */
export interface StepConversationRecord {
	conversationId: string;
	sessionId: string;
	flowName: string;
	stepName: string;
	iteration: number;
	/** Preceding step conversation id (for the `prev` edge + reciprocal `next`). `null` for the first. */
	prevConversationId: string | null;
	createdAtMs: number;
	providerId: string;
	modelId: string;
	messages: ChatMessage[];
}

/** The persistence seam the executor calls (optional — unit tests omit it). */
export interface StepConversationStore {
	/** Persist a step conversation (header + messages) and backfill the chain. */
	persist(record: StepConversationRecord): Promise<void>;
}

/** The minimal durable FS surface the vault-backed store needs. */
export interface StepConversationFs {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}

/**
 * Build the orchestration step-conversation JSONL header object. Exposed for the
 * history hidden-from-list unit test (the Phase-2 gate) to construct realistic
 * fixtures without duplicating the field set.
 */
export function buildStepConversationHeader(record: StepConversationRecord): Record<string, unknown> {
	const edges: OrchestrationEdge[] = [];
	if (record.prevConversationId) {
		edges.push({ kind: "prev", conversation_id: record.prevConversationId });
	}
	const isoCreated = new Date(record.createdAtMs).toISOString();
	return {
		_type: "orchestration_step_conversation",
		id: record.conversationId,
		title: `[${record.flowName}] ${record.stepName} — iteration ${record.iteration}`,
		created_at: isoCreated,
		updated_at: isoCreated,
		provider_id: record.providerId,
		model_id: record.modelId,
		total_input_tokens: 0,
		total_output_tokens: 0,
		estimated_cost: null,
		mode: "act",
		orchestration_session_id: record.sessionId,
		orchestration_flow_name: record.flowName,
		orchestration_step_name: record.stepName,
		orchestration_iteration: record.iteration,
		orchestration_edges: edges,
	};
}

/**
 * A {@link StepConversationStore} backed by a durable {@link StepConversationFs}.
 * Writes step conversations into `historyDir` and backfills the reciprocal `next`
 * edge on the predecessor using an in-memory conversation-id → path map kept for
 * the run's lifetime.
 */
export class VaultStepConversationStore implements StepConversationStore {
	/** conversation id → its JSONL file path (for reciprocal `next` backfill). */
	private readonly pathById = new Map<string, string>();

	constructor(
		private readonly fs: StepConversationFs,
		private readonly historyDir: string,
	) {}

	async persist(record: StepConversationRecord): Promise<void> {
		const path = this.filePath(record);
		this.pathById.set(record.conversationId, path);

		const header = buildStepConversationHeader(record);
		const lines: string[] = [JSON.stringify(header)];
		for (const msg of record.messages) {
			lines.push(JSON.stringify({ _type: "message", ...msg }));
		}

		if (!(await this.fs.exists(this.historyDir))) {
			await this.fs.mkdir(this.historyDir);
		}
		await this.fs.write(path, lines.join("\n") + "\n");
		log.debug("Persisted step conversation", {
			id: record.conversationId,
			step: record.stepName,
			iteration: record.iteration,
		});

		// Backfill the reciprocal `next` edge on the predecessor (Phase 2).
		if (record.prevConversationId) {
			await this.backfillNextEdge(record.prevConversationId, record.conversationId);
		}
	}

	/** Add a `next` edge to `predecessorId`'s header pointing at `nextId`. */
	private async backfillNextEdge(predecessorId: string, nextId: string): Promise<void> {
		const path = this.pathById.get(predecessorId);
		if (!path) {
			// Predecessor not persisted by this store (e.g. recovery minted a new
			// chain) — the dangling edge is tolerated; the run-tree skips it.
			log.debug("Skipping next-edge backfill — predecessor path unknown", { predecessorId });
			return;
		}
		try {
			const content = await this.fs.read(path);
			const newline = content.indexOf("\n");
			const headerLine = newline >= 0 ? content.slice(0, newline) : content;
			const rest = newline >= 0 ? content.slice(newline) : "";
			const header = JSON.parse(headerLine) as Record<string, unknown>;
			const edges = Array.isArray(header.orchestration_edges)
				? (header.orchestration_edges as OrchestrationEdge[])
				: [];
			// Idempotent: don't duplicate an existing next edge to the same target.
			if (!edges.some((e) => e.kind === "next" && e.conversation_id === nextId)) {
				edges.push({ kind: "next", conversation_id: nextId });
			}
			header.orchestration_edges = edges;
			await this.fs.write(path, JSON.stringify(header) + rest);
		} catch (e) {
			log.warn("Failed to backfill next edge", { predecessorId, error: String(e) });
		}
	}

	private filePath(record: StepConversationRecord): string {
		// Deterministic, collision-free filename; hidden from the flat list by the
		// header `_type` marker (no `_subagent_` filename needed).
		return `${this.historyDir.replace(/\/+$/, "")}/orchestration_step_${record.conversationId}.jsonl`;
	}
}
