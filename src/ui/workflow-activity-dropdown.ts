/**
 * Workflow activity dropdown — popover listing active and recent workflow executions.
 *
 * Opens when the user clicks the activity indicator icon. Shows workflow entries
 * with status badges, trigger source descriptions, and timestamps. Each entry
 * is clickable to navigate to the workflow's conversation.
 *
 * Uses a custom positioned `<div>` (not Obsidian's `Menu` API) for rich content
 * per entry and live update capability while open.
 *
 * @see specs/03-workflows-personas/tasks/group-h-tasks.md — H-004, H-005
 * @see FR-53 — Workflow Activity Indicator
 */

import { setIcon } from "obsidian";
import type { WorkflowActivityTracker, FlowRunEntry } from "../workflows/workflow-activity-tracker";
import type { WorkflowExecution, WorkflowExecutionStatus } from "../types";
import type { ConversationSession } from "../chat/conversation-session";
import { logger } from "../utils/logger";

const log = logger("WorkflowActivityDropdown");

/**
 * Callback signature for navigating to a workflow conversation.
 *
 * @param conversationId - The conversation ID to switch to.
 */
export type NavigateToConversationCallback = (conversationId: string) => void;

/**
 * Callback to open the run-tree view rooted at a flow-run session (POL-004 /
 * FR-179). A `flow-run` entry click routes here instead of `onNavigate`.
 */
export type OpenRunTreeCallback = (sessionId: string) => void;

/**
 * Callback to stop a live orchestration flow run (F1 Fix 1). Wired to the
 * plugin's `OrchestrationRunRegistry.abort(sessionId)`; surfaced as a stop
 * icon-button on `active` flow-run rows.
 */
export type StopFlowRunCallback = (sessionId: string) => void;

/**
 * Predicate for whether a flow run is actually live in the abort registry (F1
 * Fix 1). The Stop button is only rendered when this returns `true`, so a
 * background child, a stale post-crash entry, or an already-finalized run — all
 * of which the registry cannot `abort` — no longer show a dead Stop button.
 */
export type IsFlowRunLivePredicate = (sessionId: string) => boolean;

/**
 * Workflow activity dropdown component.
 *
 * Renders a positioned popover below the activity indicator icon showing
 * active and recently completed workflow executions. Entries are clickable
 * to navigate to the corresponding conversation. Updates live while open
 * via the tracker's `onChange` callback.
 *
 * @see specs/03-workflows-personas/tasks/group-h-tasks.md — H-004, H-005
 */
export class WorkflowActivityDropdown {
	private readonly tracker: WorkflowActivityTracker;
	private readonly onNavigate: NavigateToConversationCallback;

	/** The dropdown container element, or null when closed. */
	private dropdownEl: HTMLElement | null = null;
	/** Unregister function for the tracker onChange callback. */
	private unregisterOnChange: (() => void) | null = null;
	/** Bound reference for the outside-click dismiss handler. */
	private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
	/** Bound reference for the Escape key dismiss handler. */
	private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
	/** The anchor element the dropdown is positioned relative to. */
	private anchorEl: HTMLElement | null = null;

	/** Optional accessor for active foreground conversation sessions (Phase 3). */
	private readonly getActiveSessions?: () => ConversationSession[];
	/** Optional accessor for the conversation ID currently shown in THIS panel. */
	private readonly getCurrentConversationId?: () => string | null;

	/**
	 * @param tracker                   - The workflow activity tracker providing execution data.
	 * @param onNavigate                - Callback invoked when the user clicks an entry to navigate
	 *                                    to that workflow's conversation.
	 * @param getActiveSessions         - Optional accessor for active foreground conversation sessions.
	 * @param getCurrentConversationId  - Optional accessor for the conversation ID currently open in
	 *                                    this panel, used to highlight the matching dropdown entry.
	 */
	/** Optional run-tree opener for `flow-run` entries (POL-004). */
	private readonly onOpenRunTree?: OpenRunTreeCallback;

	/** Optional stop callback for live `flow-run` entries (F1 Fix 1). */
	private readonly onStopFlowRun?: StopFlowRunCallback;

	/** Optional liveness predicate gating the Stop button (F1 Fix 1). */
	private readonly isFlowRunLive?: IsFlowRunLivePredicate;

	constructor(
		tracker: WorkflowActivityTracker,
		onNavigate: NavigateToConversationCallback,
		getActiveSessions?: () => ConversationSession[],
		getCurrentConversationId?: () => string | null,
		onOpenRunTree?: OpenRunTreeCallback,
		onStopFlowRun?: StopFlowRunCallback,
		isFlowRunLive?: IsFlowRunLivePredicate,
	) {
		this.tracker = tracker;
		this.onNavigate = onNavigate;
		this.getActiveSessions = getActiveSessions;
		this.getCurrentConversationId = getCurrentConversationId;
		this.onOpenRunTree = onOpenRunTree;
		this.onStopFlowRun = onStopFlowRun;
		this.isFlowRunLive = isFlowRunLive;
	}

	// -----------------------------------------------------------------------
	// Open / Close
	// -----------------------------------------------------------------------

	/**
	 * Check whether the dropdown is currently open.
	 */
	isOpen(): boolean {
		return this.dropdownEl !== null;
	}

	/**
	 * Toggle the dropdown open/closed.
	 *
	 * @param anchorEl - The indicator icon element for positioning.
	 */
	toggle(anchorEl: HTMLElement): void {
		if (this.isOpen()) {
			this.close();
		} else {
			this.open(anchorEl);
		}
	}

	/**
	 * Create and display the dropdown, positioned below or near the anchor element.
	 *
	 * @param anchorEl - The indicator icon element for positioning.
	 */
	open(anchorEl: HTMLElement): void {
		// Close any existing dropdown first
		if (this.dropdownEl) {
			this.close();
		}

		this.anchorEl = anchorEl;

		// Create the dropdown container
		this.dropdownEl = createDiv({
			cls: "notor-workflow-activity-dropdown",
		});

		// Render entries
		this.renderEntries();

		// Position relative to the anchor — append to the document body
		// so the dropdown is not clipped by overflow: hidden on parent containers.
		activeDocument.body.appendChild(this.dropdownEl);
		this.positionDropdown(anchorEl);

		// Register live update callback
		this.unregisterOnChange = this.tracker.onChange(() => {
			this.renderEntries();
		});

		// Register dismiss handlers
		this.outsideClickHandler = (e: MouseEvent) => {
			const target = e.target as Node;
			// Close if click is outside both the dropdown and the anchor
			if (
				this.dropdownEl &&
				!this.dropdownEl.contains(target) &&
				!anchorEl.contains(target)
			) {
				this.close();
			}
		};

		this.escapeHandler = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				this.close();
			}
		};

		// Use setTimeout to avoid the opening click from immediately closing
		setTimeout(() => {
			activeDocument.addEventListener("click", this.outsideClickHandler!);
			activeDocument.addEventListener("keydown", this.escapeHandler!);
		}, 0);

		log.debug("Workflow activity dropdown opened");
	}

	/**
	 * Remove the dropdown from the DOM and clean up listeners.
	 */
	close(): void {
		if (this.unregisterOnChange) {
			this.unregisterOnChange();
			this.unregisterOnChange = null;
		}

		if (this.outsideClickHandler) {
			activeDocument.removeEventListener("click", this.outsideClickHandler);
			this.outsideClickHandler = null;
		}

		if (this.escapeHandler) {
			activeDocument.removeEventListener("keydown", this.escapeHandler);
			this.escapeHandler = null;
		}

		if (this.dropdownEl) {
			this.dropdownEl.remove();
			this.dropdownEl = null;
		}

		this.anchorEl = null;

		log.debug("Workflow activity dropdown closed");
	}

	// -----------------------------------------------------------------------
	// Rendering
	// -----------------------------------------------------------------------

	/**
	 * Render (or re-render) the entry list inside the dropdown.
	 *
	 * Called on initial open and reactively via the tracker's onChange callback
	 * to support live updates while the dropdown is visible.
	 */
	private renderEntries(): void {
		if (!this.dropdownEl) return;

		this.dropdownEl.empty();

		const workflowEntries = this.tracker.getIndicatorEntries();
		const sessions = this.getActiveSessions?.() ?? [];
		const flowRuns = this.tracker.getFlowRunEntries();

		if (workflowEntries.length === 0 && sessions.length === 0 && flowRuns.length === 0) {
			// Empty state
			const emptyEl = this.dropdownEl.createDiv({
				cls: "notor-workflow-activity-empty",
			});
			emptyEl.textContent = "No recent activity";
			return;
		}

		// Flow-runs section (POL-004) — typed `flow-run` entries open the run-tree.
		if (flowRuns.length > 0) {
			const showHeader = sessions.length > 0 || workflowEntries.length > 0;
			const sectionEl = showHeader
				? this.dropdownEl.createDiv({ cls: "notor-workflow-activity-section" })
				: this.dropdownEl;
			if (showHeader) {
				sectionEl.createDiv({
					cls: "notor-workflow-activity-section-header",
					text: "Flows",
				});
			}
			for (const run of flowRuns) {
				this.renderFlowRunEntry(sectionEl, run);
			}
		}

		// Conversations section (active foreground sessions)
		if (sessions.length > 0) {
			const sectionEl = this.dropdownEl.createDiv({
				cls: "notor-workflow-activity-section",
			});
			sectionEl.createDiv({
				cls: "notor-workflow-activity-section-header",
				text: "Conversations",
			});
			for (const session of sessions) {
				this.renderSessionEntry(sectionEl, session);
			}
		}

		// Workflows section
		if (workflowEntries.length > 0) {
			if (sessions.length > 0) {
				// Add section header only when both sections are present
				const sectionEl = this.dropdownEl.createDiv({
					cls: "notor-workflow-activity-section",
				});
				sectionEl.createDiv({
					cls: "notor-workflow-activity-section-header",
					text: "Workflows",
				});
				for (const execution of workflowEntries) {
					this.renderEntry(sectionEl, execution);
				}
			} else {
				for (const execution of workflowEntries) {
					this.renderEntry(this.dropdownEl, execution);
				}
			}
		}
	}

	/**
	 * Render a single workflow execution entry row.
	 *
	 * Each entry shows: workflow name, trigger source, status badge, and timestamp.
	 * Clicking the entry navigates to the workflow's conversation (H-005).
	 */
	private renderEntry(container: HTMLElement, execution: WorkflowExecution): void {
		const entryEl = container.createDiv({
			cls: "notor-workflow-activity-entry",
		});

		// Top row: workflow name + status badge
		const topRow = entryEl.createDiv({ cls: "notor-workflow-activity-entry-top" });

		const nameEl = topRow.createSpan({ cls: "workflow-name" });
		nameEl.textContent = execution.workflow_name;

		const badgeEl = topRow.createSpan({
			cls: `status-badge status-${execution.status}`,
		});
		badgeEl.textContent = this.getStatusLabel(execution.status);

		// Add status icon for certain states
		this.addStatusIcon(badgeEl, execution.status);

		// Bottom row: trigger source + timestamp
		const bottomRow = entryEl.createDiv({ cls: "notor-workflow-activity-entry-bottom" });

		if (execution.trigger_source) {
			const triggerEl = bottomRow.createSpan({ cls: "trigger-source" });
			triggerEl.textContent = execution.trigger_source;
		}

		const timestampEl = bottomRow.createSpan({ cls: "timestamp" });
		timestampEl.textContent = this.formatTimestamp(execution);

		// Click handler — navigate to the workflow's conversation (H-005)
		entryEl.addEventListener("click", () => {
			this.onNavigate(execution.conversation_id);
			this.close();
		});
	}

	/**
	 * Render a single flow-run entry (POL-004). Clicking it **opens the run-tree
	 * view** rooted at the flow's session (unlike a background-workflow entry,
	 * which navigates to its conversation).
	 */
	private renderFlowRunEntry(container: HTMLElement, run: FlowRunEntry): void {
		const entryEl = container.createDiv({ cls: "notor-workflow-activity-entry" });

		const topRow = entryEl.createDiv({ cls: "notor-workflow-activity-entry-top" });
		topRow.createSpan({ cls: "workflow-name", text: run.flowName });
		const badgeEl = topRow.createSpan({ cls: `status-badge status-${run.status}` });
		badgeEl.textContent = run.status;

		// F1 Fix 1: a live (`active`) run gets a stop icon-button that aborts it via
		// the run registry. `stopPropagation` keeps the row's open-run-tree click
		// from firing when the user clicks Stop. Gate on the liveness predicate too:
		// a background child, a stale post-crash entry, or an already-finalized run
		// is `active` in the indicator but absent from the abort registry, so its
		// Stop would be a silent no-op — don't render it.
		const isLive = this.isFlowRunLive?.(run.sessionId) ?? true;
		if (run.status === "active" && isLive && this.onStopFlowRun) {
			const stopBtn = topRow.createSpan({ cls: "notor-flow-run-stop-button" });
			stopBtn.setAttr("role", "button");
			stopBtn.setAttr("aria-label", "Stop flow run");
			setIcon(stopBtn, "square");
			stopBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.onStopFlowRun?.(run.sessionId);
			});
		}

		const bottomRow = entryEl.createDiv({ cls: "notor-workflow-activity-entry-bottom" });
		bottomRow.createSpan({ cls: "trigger-source", text: "orchestration flow" });

		entryEl.addEventListener("click", () => {
			if (this.onOpenRunTree) this.onOpenRunTree(run.sessionId);
			this.close();
		});
	}

	/**
	 * Render a single active conversation session entry row.
	 *
	 * Each entry shows: conversation title, status badge, and elapsed time.
	 * Clicking the entry navigates to the session's conversation.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 3, Step 3b
	 */
	private renderSessionEntry(container: HTMLElement, session: ConversationSession): void {
		const entryEl = container.createDiv({
			cls: "notor-workflow-activity-entry",
		});

		if (this.getCurrentConversationId?.() === session.conversationId) {
			entryEl.addClass("is-current");
		}

		// Top row: conversation title + status badge
		const topRow = entryEl.createDiv({ cls: "notor-workflow-activity-entry-top" });

		const nameEl = topRow.createSpan({ cls: "workflow-name" });
		nameEl.textContent = session.title || "Untitled conversation";

		const statusLabel = session.status === "waiting_approval"
			? "Waiting for approval"
			: "Streaming";
		const statusClass = session.status === "waiting_approval"
			? "waiting_approval"
			: "running";

		const badgeEl = topRow.createSpan({
			cls: `status-badge status-${statusClass}`,
		});
		badgeEl.textContent = statusLabel;

		// Add status icon
		const iconEl = createSpan({ cls: "status-icon" });
		if (session.status === "waiting_approval") {
			setIcon(iconEl, "alert-circle");
		} else {
			setIcon(iconEl, "loader");
		}
		badgeEl.insertBefore(iconEl, badgeEl.firstChild);

		// Bottom row: elapsed time
		const bottomRow = entryEl.createDiv({ cls: "notor-workflow-activity-entry-bottom" });

		const timestampEl = bottomRow.createSpan({ cls: "timestamp" });
		timestampEl.textContent = this.formatRelativeTime(new Date(session.startedAt));

		// Click handler — navigate to the session's conversation
		entryEl.addEventListener("click", () => {
			this.onNavigate(session.conversationId);
			this.close();
		});
	}

	// -----------------------------------------------------------------------
	// Status helpers
	// -----------------------------------------------------------------------

	/**
	 * Get a human-readable label for a workflow execution status.
	 */
	private getStatusLabel(status: WorkflowExecutionStatus): string {
		switch (status) {
			case "running":
				return "Running…";
			case "waiting_approval":
				return "Waiting for approval";
			case "completed":
				return "Completed";
			case "errored":
				return "Errored";
			case "stopped":
				return "Stopped";
			case "queued":
				return "Queued";
			default:
				return status;
		}
	}

	/**
	 * Add a status-appropriate icon to the badge element.
	 */
	private addStatusIcon(badgeEl: HTMLElement, status: WorkflowExecutionStatus): void {
		const iconEl = createSpan({ cls: "status-icon" });

		switch (status) {
			case "running":
				setIcon(iconEl, "loader");
				break;
			case "waiting_approval":
				setIcon(iconEl, "alert-circle");
				break;
			case "completed":
				setIcon(iconEl, "check-circle");
				break;
			case "errored":
				setIcon(iconEl, "x-circle");
				break;
			case "stopped":
				setIcon(iconEl, "octagon-pause");
				break;
			case "queued":
				setIcon(iconEl, "clock");
				break;
		}

		badgeEl.insertBefore(iconEl, badgeEl.firstChild);
	}

	// -----------------------------------------------------------------------
	// Timestamp formatting
	// -----------------------------------------------------------------------

	/**
	 * Format a timestamp for display in the dropdown.
	 *
	 * For active workflows: relative time since start (e.g., "2m ago").
	 * For completed workflows: relative time since completion.
	 */
	private formatTimestamp(execution: WorkflowExecution): string {
		const isActive =
			execution.status === "running" ||
			execution.status === "waiting_approval" ||
			execution.status === "queued";

		const referenceTime = isActive
			? execution.started_at
			: execution.completed_at ?? execution.started_at;

		return this.formatRelativeTime(new Date(referenceTime));
	}

	/**
	 * Format a date as a relative time string.
	 */
	private formatRelativeTime(date: Date): string {
		const now = Date.now();
		const diff = now - date.getTime();
		const seconds = Math.floor(diff / 1000);
		const minutes = Math.floor(diff / 60000);
		const hours = Math.floor(diff / 3600000);
		const days = Math.floor(diff / 86400000);

		if (seconds < 10) return "Just now";
		if (seconds < 60) return `${seconds}s ago`;
		if (minutes < 60) return `${minutes}m ago`;
		if (hours < 24) return `${hours}h ago`;
		if (days < 7) return `${days}d ago`;
		return date.toLocaleDateString();
	}

	// -----------------------------------------------------------------------
	// Positioning
	// -----------------------------------------------------------------------

	/**
	 * Position the dropdown below the anchor element.
	 *
	 * Uses `getBoundingClientRect()` for accurate positioning relative to
	 * the viewport, then adjusts to stay within screen bounds.
	 */
	private positionDropdown(anchorEl: HTMLElement): void {
		if (!this.dropdownEl) return;

		const anchorRect = anchorEl.getBoundingClientRect();

		// Position below the anchor, aligned to its right edge
		let top = anchorRect.bottom + 4;
		let left = anchorRect.right - 280; // dropdown min-width is ~280px

		// Ensure the dropdown stays within the viewport
		if (left < 8) {
			left = 8;
		}

		const viewportWidth = activeWindow.innerWidth;
		if (left + 300 > viewportWidth) {
			left = viewportWidth - 308;
		}

		// If the dropdown would go below the viewport, position above the anchor
		const viewportHeight = activeWindow.innerHeight;
		if (top + 300 > viewportHeight) {
			top = anchorRect.top - 4; // will be adjusted by max-height CSS
			this.dropdownEl.style.maxHeight = `${anchorRect.top - 16}px`;
			this.dropdownEl.style.bottom = `${viewportHeight - anchorRect.top + 4}px`;
			this.dropdownEl.setCssProps({ '--notor-dropdown-top': 'auto' });
		} else {
			this.dropdownEl.setCssProps({ '--notor-dropdown-top': `${top}px` });
		}

		this.dropdownEl.style.left = `${left}px`;
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Close the dropdown if open and unregister all listeners.
	 *
	 * Called during indicator or chat view cleanup.
	 */
	destroy(): void {
		this.close();
	}
}
