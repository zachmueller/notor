/**
 * `OrchestrationRunTreeView` (POL-003 / FR-178) — the unified run-tree `ItemView`.
 *
 * A read-only consumer of the contracts in
 * specs/ZZ-misc/orchestration/contracts/edges.md: it renders a run as a navigable,
 * collapsible tree **unified** across orchestration steps (via `orchestration_edges`
 * `next`/`prev` for the step chain and `child`/`parent` for cross-flow descent) and
 * sub-agents (via the `parent_conversation_id` scalar). It defines no schema of its
 * own.
 *
 * v1 scope (per the spec "Out of Scope" + the run-tree idea note):
 *  - **read-only navigation** — selecting a node loads its conversation in the main
 *    chat (`switchToConversationById`); no retry/resume/edit node actions;
 *  - **smart auto-expand** to the focus node, collapse finished branches (ephemeral,
 *    not persisted);
 *  - **live for active runs / static for completed** — subscribes to the
 *    `WorkflowActivityTracker.onChange()` write points while a run is active;
 *  - **tolerates dangling edges** — a recovery re-run mints new conversation ids, so
 *    a `next`/`prev`/`child` target may be an abandoned pre-crash conversation;
 *    unresolved targets are skipped silently (an edge is a hint, not a guarantee).
 *
 * It needs **no** cycle-detection / infinite-expansion guards — the edges are a
 * tree-constrained DAG (edges.md §3) — but it must skip dangling targets, which the
 * `visited` set + resolve-or-skip render does.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-7-composability.md — POL-003
 * @see specs/ZZ-misc/orchestration/contracts/edges.md
 */

import { ItemView, normalizePath, setIcon } from "obsidian";
import type { WorkspaceLeaf, ViewStateResult } from "obsidian";
import type NotorPlugin from "../main";
import type { OrchestrationEdge } from "../types";
import {
	type CodeStepLog,
	type CodeStepTurn,
	extractCodeStepTurns,
	spliceCodeSteps,
} from "../orchestration/code-step-overlay";
import { SessionLogReader } from "../orchestration/session-log-reader";
import { logger } from "../utils/logger";

const log = logger("RunTreeView");

export const ORCHESTRATION_RUN_TREE_VIEW_TYPE = "notor-run-tree-view";

/** A node in the run tree, resolved from a step / sub-agent conversation header. */
interface RunTreeNode {
	/** Conversation id for a real conversation node; a synthetic `code-step:{sid}:{turn}` key for a code step. */
	conversationId: string;
	title: string;
	flowName?: string;
	stepName?: string;
	iteration?: number;
	sessionId?: string;
	kind: "step" | "child-flow" | "sub-agent" | "code-step";
	/** Resolved child node ids (next-chain successors, child-flow entries, sub-agents). */
	children: RunTreeNode[];
	/** True when this node's conversation file resolved (false ⇒ dangling — render label only). */
	resolved: boolean;
	/** Code-step logic-path logs (only on `code-step` nodes), rendered as leaf rows beneath the node. */
	logs?: CodeStepLog[];
	/** False for a `code-step` node (no conversation to open). Defaults to true. */
	clickable?: boolean;
}

/** A scanned conversation header (the subset the tree reads). */
interface ScannedHeader {
	id: string;
	title?: string;
	_type?: string;
	schema_version?: number;
	orchestration_session_id?: string;
	orchestration_flow_name?: string;
	orchestration_step_name?: string;
	orchestration_iteration?: number;
	orchestration_edges?: OrchestrationEdge[];
	parent_conversation_id?: string;
	sub_agent_name?: string;
}

export class OrchestrationRunTreeView extends ItemView {
	private rootSessionId?: string;
	private rootConversationId?: string;
	private treeEl?: HTMLElement;
	private unsubscribe?: () => void;
	/** conversation id → manual collapse state (ephemeral; not persisted). */
	private readonly collapsed = new Set<string>();
	private selectedId?: string;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: NotorPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return ORCHESTRATION_RUN_TREE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Run tree";
	}

	getIcon(): string {
		return "git-branch";
	}

	getState(): Record<string, unknown> {
		return { rootSessionId: this.rootSessionId, rootConversationId: this.rootConversationId };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const s = (state ?? {}) as Record<string, unknown>;
		this.rootSessionId =
			typeof s.rootSessionId === "string" ? s.rootSessionId : this.rootSessionId;
		this.rootConversationId =
			typeof s.rootConversationId === "string" ? s.rootConversationId : this.rootConversationId;
		await this.rebuild();
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("notor-run-tree-container");
		// Live updates: re-render on the activity tracker's write points
		// (turn.start / turn.complete / event.emitted surface through it).
		try {
			const tracker = this.plugin.getWorkflowActivityTracker?.();
			this.unsubscribe = tracker?.onChange?.(() => void this.rebuild());
		} catch (e) {
			log.debug("Run-tree live subscription unavailable", { error: String(e) });
		}
		await this.rebuild();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	// -- Build -----------------------------------------------------------------

	private async rebuild(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		if (!container) return;
		container.empty();
		container.addClass("notor-run-tree-container");

		const header = container.createDiv({ cls: "notor-run-tree-header" });
		header.createEl("h3", { text: "Run tree" });

		this.treeEl = container.createDiv({ cls: "notor-run-tree" });

		if (!this.rootSessionId && !this.rootConversationId) {
			this.treeEl.createDiv({
				cls: "notor-run-tree-empty",
				text: "No run selected. Open the run tree from a run_flow / sub-agent card, the activity indicator, or a progress Notice.",
			});
			return;
		}

		let headers: Map<string, ScannedHeader>;
		try {
			headers = await this.scanHeaders();
		} catch (e) {
			log.warn("Run-tree scan failed", { error: String(e) });
			this.treeEl.createDiv({ cls: "notor-run-tree-empty", text: "Could not read the run history." });
			return;
		}

		const roots = this.buildRoots(headers);
		if (roots.length === 0) {
			this.treeEl.createDiv({
				cls: "notor-run-tree-empty",
				text: "No step conversations found for this run yet.",
			});
			return;
		}

		// Overlay code steps (no conversation file — read from each session's log)
		// so the run-tree shows deterministic steps + their `orchestration.log`
		// logic-path logs, interleaved with conversation steps by hop order.
		await this.overlayCodeSteps(roots);

		// Aggregate rollup header (whole-run token sums from the scanned step headers).
		this.renderRollupHeader(header, roots);

		const visited = new Set<string>();
		for (const root of roots) {
			this.renderNode(this.treeEl, root, visited, 0);
		}
	}

	/**
	 * Scan the history directory for orchestration step + sub-agent conversation
	 * headers (read-only). The run-tree reads headers directly rather than through
	 * `HistoryManager.loadConversation` (which rejects the hidden `_type`s).
	 */
	private async scanHeaders(): Promise<Map<string, ScannedHeader>> {
		const headers = new Map<string, ScannedHeader>();
		const dir = normalizePath(this.plugin.settings.history_path);
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(dir))) return headers;

		const listing = await adapter.list(dir);
		for (const file of listing.files) {
			if (!file.endsWith(".jsonl")) continue;
			const fname = file.split("/").pop() ?? file;
			// Only orchestration step + sub-agent conversation files (the hidden ones).
			if (!fname.startsWith("orchestration_step_") && !fname.includes("_subagent_")) continue;
			try {
				const content = await adapter.read(file);
				const nl = content.indexOf("\n");
				const headerLine = nl >= 0 ? content.slice(0, nl) : content;
				if (!headerLine.trim()) continue;
				const h = JSON.parse(headerLine) as ScannedHeader;
				h.schema_version ??= 1;
				if (h.id) headers.set(h.id, h);
			} catch (e) {
				log.debug("Skipping unreadable run-tree header", { file, error: String(e) });
			}
		}
		return headers;
	}

	/**
	 * Build the root node(s): the step conversations of the root session, chained
	 * by `next`/`prev`, with `child` edges + sub-agents descended recursively.
	 */
	private buildRoots(headers: Map<string, ScannedHeader>): RunTreeNode[] {
		// Index sub-agent children by their parent conversation id.
		const subAgentsByParent = new Map<string, ScannedHeader[]>();
		for (const h of headers.values()) {
			if (h.parent_conversation_id) {
				const list = subAgentsByParent.get(h.parent_conversation_id) ?? [];
				list.push(h);
				subAgentsByParent.set(h.parent_conversation_id, list);
			}
		}

		// Find the entry step(s) of the root session: a step conversation in the
		// session with no resolvable `prev` edge (the first turn).
		const inSession = (h: ScannedHeader): boolean =>
			this.rootSessionId
				? h.orchestration_session_id === this.rootSessionId
				: h.id === this.rootConversationId;

		const sessionSteps = [...headers.values()].filter(inSession);
		const entrySteps = sessionSteps.filter((h) => {
			const prev = (h.orchestration_edges ?? []).find((e) => e.kind === "prev");
			return !prev || !headers.has(prev.conversation_id);
		});
		// Fall back to the explicit root conversation when no clear entry is found.
		const seeds =
			entrySteps.length > 0
				? entrySteps
				: this.rootConversationId && headers.has(this.rootConversationId)
					? [headers.get(this.rootConversationId)!]
					: sessionSteps.slice(0, 1);

		const built = new Set<string>();
		return seeds.map((seed) => this.buildNode(seed, headers, subAgentsByParent, built));
	}

	private buildNode(
		h: ScannedHeader,
		headers: Map<string, ScannedHeader>,
		subAgentsByParent: Map<string, ScannedHeader[]>,
		built: Set<string>,
	): RunTreeNode {
		const node: RunTreeNode = {
			conversationId: h.id,
			title: h.title ?? h.orchestration_step_name ?? h.sub_agent_name ?? h.id,
			flowName: h.orchestration_flow_name,
			stepName: h.orchestration_step_name,
			iteration: h.orchestration_iteration,
			sessionId: h.orchestration_session_id,
			kind: h.sub_agent_name ? "sub-agent" : "step",
			children: [],
			resolved: true,
		};
		if (built.has(h.id)) return node; // tree-constrained DAG ⇒ this only guards re-entry
		built.add(h.id);

		const edges = h.orchestration_edges ?? [];

		// Descend into child flows (child edges → the child flow's entry conversation).
		for (const edge of edges) {
			if (edge.kind !== "child") continue;
			const target = headers.get(edge.conversation_id);
			if (target) {
				const childNode = this.buildNode(target, headers, subAgentsByParent, built);
				childNode.kind = "child-flow";
				node.children.push(childNode);
			}
			// Dangling child target (recovery re-run minted a new id) — skipped.
		}

		// Sub-agent children (the parent_conversation_id scalar).
		for (const sub of subAgentsByParent.get(h.id) ?? []) {
			node.children.push(this.buildNode(sub, headers, subAgentsByParent, built));
		}

		// Chain the next step in the same flow as a sibling under the same parent
		// (the run-tree shows the step chain as a linear descent).
		const next = edges.find((e) => e.kind === "next");
		if (next) {
			const target = headers.get(next.conversation_id);
			if (target && !built.has(target.id)) {
				node.children.push(this.buildNode(target, headers, subAgentsByParent, built));
			}
			// Dangling next target — skipped silently (FR-126 recovery tolerance).
		}

		return node;
	}

	/**
	 * Overlay code-step nodes onto the built conversation tree. Code steps create
	 * no conversation file (so the header scan misses them) — but they leave a
	 * `turn.start`/`turn.complete` pair (`conversation_id: null`) plus `step.log`
	 * entries in each session's `session-log.jsonl`. This reads those logs (reusing
	 * {@link SessionLogReader}), reconstructs the per-session code-step turns, and
	 * splices a synthesized node per turn at its hop position (the shared
	 * `iteration`/`turn` counter). Failure is non-fatal: a missing/corrupt log for
	 * one session is skipped so the conversation tree still renders.
	 */
	private async overlayCodeSteps(roots: RunTreeNode[]): Promise<void> {
		const sessionIds = new Set<string>();
		const collect = (n: RunTreeNode): void => {
			if (n.sessionId) sessionIds.add(n.sessionId);
			n.children.forEach(collect);
		};
		roots.forEach(collect);
		if (sessionIds.size === 0) return;

		let turnsBySession: Map<string, CodeStepTurn[]>;
		try {
			turnsBySession = await this.scanCodeStepTurns(sessionIds);
		} catch (e) {
			log.debug("Run-tree code-step overlay scan failed", { error: String(e) });
			return;
		}

		spliceCodeSteps<RunTreeNode>({
			roots,
			turnsBySession,
			rootSessionId: this.rootSessionId,
			makeCodeStepNode: (turn, sessionId) => this.makeCodeStepNode(turn, sessionId),
		});
	}

	/** Synthesize a `code-step` {@link RunTreeNode} from a reconstructed turn. */
	private makeCodeStepNode(turn: CodeStepTurn, sessionId: string): RunTreeNode {
		const title = turn.emittedTopic ? `${turn.step} → ${turn.emittedTopic}` : turn.step;
		return {
			conversationId: `code-step:${sessionId}:${turn.turn}`,
			title,
			stepName: turn.step,
			iteration: turn.turn,
			sessionId,
			kind: "code-step",
			children: [],
			resolved: true,
			logs: turn.logs,
			clickable: false,
		};
	}

	/**
	 * Read each session's `session-log.jsonl` and reconstruct its code-step turns.
	 * Reads from the orchestration sessions root (not `history_path` — that holds
	 * conversation files only). Per-session failures (absent / unparseable log) are
	 * skipped so one bad session never breaks the overlay.
	 */
	private async scanCodeStepTurns(sessionIds: Set<string>): Promise<Map<string, CodeStepTurn[]>> {
		const out = new Map<string, CodeStepTurn[]>();
		const sessionsRoot = normalizePath(`${this.plugin.settings.notor_dir}/orchestrations/sessions`);
		const adapter = this.plugin.app.vault.adapter;
		const reader = new SessionLogReader();
		for (const sid of sessionIds) {
			const path = normalizePath(`${sessionsRoot}/${sid}/session-log.jsonl`);
			try {
				if (!(await adapter.exists(path))) continue;
				const parsed = reader.parse(await adapter.read(path));
				const turns = extractCodeStepTurns(parsed.entries);
				if (turns.length > 0) out.set(sid, turns);
			} catch (e) {
				log.debug("Run-tree: skipping unreadable session log", { sid, error: String(e) });
			}
		}
		return out;
	}

	// -- Render ----------------------------------------------------------------

	private renderRollupHeader(headerEl: HTMLElement, roots: RunTreeNode[]): void {
		// Count nodes as a cheap whole-run summary (token/cost rollup lives on the
		// child_run_metadata peek card; the tree header shows structure scale).
		let count = 0;
		const walk = (n: RunTreeNode) => {
			count += 1;
			n.children.forEach(walk);
		};
		roots.forEach(walk);
		const rollup = headerEl.createDiv({ cls: "notor-run-tree-rollup" });
		rollup.createSpan({ text: `${count} node${count !== 1 ? "s" : ""}` });
	}

	private renderNode(
		parentEl: HTMLElement,
		node: RunTreeNode,
		visited: Set<string>,
		depth: number,
	): void {
		if (visited.has(node.conversationId)) return; // never render a node twice
		visited.add(node.conversationId);

		const nodeEl = parentEl.createDiv({ cls: "notor-run-tree-node" });
		nodeEl.style.paddingLeft = `${depth * 14}px`;
		if (node.conversationId === this.selectedId) nodeEl.addClass("is-selected");
		if (node.kind === "code-step") nodeEl.addClass("is-code-step");

		const headerRow = nodeEl.createDiv({ cls: "notor-run-tree-node-header" });

		const hasChildren = node.children.length > 0;
		const isCollapsed = this.collapsed.has(node.conversationId);
		if (hasChildren) {
			const toggle = headerRow.createSpan({ cls: "notor-run-tree-toggle" });
			setIcon(toggle, isCollapsed ? "chevron-right" : "chevron-down");
			toggle.addEventListener("click", (e) => {
				e.stopPropagation();
				if (isCollapsed) this.collapsed.delete(node.conversationId);
				else this.collapsed.add(node.conversationId);
				void this.rebuild();
			});
		} else {
			headerRow.createSpan({ cls: "notor-run-tree-toggle-spacer" });
		}

		const iconEl = headerRow.createSpan({ cls: "notor-run-tree-node-icon" });
		setIcon(
			iconEl,
			node.kind === "child-flow"
				? "git-branch"
				: node.kind === "sub-agent"
					? "bot"
					: node.kind === "code-step"
						? "code"
						: "circle-dot",
		);

		const labelEl = headerRow.createSpan({ cls: "notor-run-tree-node-label" });
		labelEl.textContent = node.title;

		// A code-step node has no conversation to open — select-only (highlight),
		// don't navigate. Conversation/sub-agent nodes navigate the main chat.
		const clickable = node.clickable !== false;
		if (clickable) {
			headerRow.addEventListener("click", () => {
				this.selectedId = node.conversationId;
				void this.navigateTo(node.conversationId);
				void this.rebuild();
			});
		} else {
			headerRow.addClass("is-not-clickable");
			headerRow.addEventListener("click", () => {
				this.selectedId = node.conversationId;
				void this.rebuild();
			});
		}

		if (hasChildren && !isCollapsed) {
			const childrenEl = nodeEl.createDiv({ cls: "notor-run-tree-node-children" });
			for (const child of node.children) {
				this.renderNode(childrenEl, child, visited, depth + 1);
			}
		}

		// Code-step logic-path logs: plain leaf rows beneath the node (not
		// RunTreeNodes — no navigation, no `visited` key, excluded from the count).
		if (node.kind === "code-step" && node.logs && node.logs.length > 0 && !isCollapsed) {
			const logsEl = nodeEl.createDiv({ cls: "notor-run-tree-logs" });
			logsEl.style.paddingLeft = `${(depth + 1) * 14}px`;
			for (const entry of node.logs) {
				this.renderLogRow(logsEl, entry);
			}
		}
	}

	/** Render one code-step log line as a non-interactive, level-colored row. */
	private renderLogRow(parentEl: HTMLElement, entry: CodeStepLog): void {
		const row = parentEl.createDiv({ cls: `notor-run-tree-log is-${entry.level}` });
		row.createSpan({ cls: "notor-run-tree-log-level", text: `[${entry.level}]` });
		row.createSpan({ cls: "notor-run-tree-log-message", text: entry.message });
		if (entry.data !== undefined) {
			let serialized: string;
			try {
				serialized = JSON.stringify(entry.data) ?? "";
			} catch {
				// Non-serializable (circular / BigInt) — fall back to a safe label.
				serialized = "[unserializable data]";
			}
			if (serialized) row.setAttribute("title", serialized);
		}
	}

	private async navigateTo(conversationId: string): Promise<void> {
		await this.plugin.openChatPanel();
		const orchestrator = this.plugin.getActiveOrchestrator();
		if (!orchestrator) return;
		const found = await orchestrator.switchToConversationById(conversationId);
		if (!found) {
			log.debug("Run-tree node has no openable conversation (e.g. a code step)", { conversationId });
		}
	}
}
