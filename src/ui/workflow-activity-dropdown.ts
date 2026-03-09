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
import type { WorkflowActivityTracker } from "../workflows/workflow-activity-tracker";
import type { WorkflowExecution, WorkflowExecutionStatus } from "../types";
import { logger } from "../utils/logger";

const log = logger("WorkflowActivityDropdown");

/**
 * Callback signature for navigating to a workflow conversation.
 *
 * @param conversationId - The conversation ID to switch to.
 */
export type NavigateToConversationCallback = (conversationId: string) => void;

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

	/**
	 * @param tracker    - The workflow activity tracker providing execution data.
	 * @param onNavigate - Callback invoked when the user clicks an entry to navigate
	 *                     to that workflow's conversation.
	 */
	constructor(
		tracker: WorkflowActivityTracker,
		onNavigate: NavigateToConversationCallback
	) {
		this.tracker = tracker;
		this.onNavigate = onNavigate;
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
		document.body.appendChild(this.dropdownEl);
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
			document.addEventListener("click", this.outsideClickHandler!);
			document.addEventListener("keydown", this.escapeHandler!);
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
			document.removeEventListener("click", this.outsideClickHandler);
			this.outsideClickHandler = null;
		}

		if (this.escapeHandler) {
			document.removeEventListener("keydown", this.escapeHandler);
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

		const entries = this.tracker.getIndicatorEntries();

		if (entries.length === 0) {
			// Empty state
			const emptyEl = this.dropdownEl.createDiv({
				cls: "notor-workflow-activity-empty",
			});
			emptyEl.textContent = "No recent workflow activity";
			return;
		}

		for (const execution of entries) {
			this.renderEntry(this.dropdownEl, execution);
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

		const viewportWidth = window.innerWidth;
		if (left + 300 > viewportWidth) {
			left = viewportWidth - 308;
		}

		// If the dropdown would go below the viewport, position above the anchor
		const viewportHeight = window.innerHeight;
		if (top + 300 > viewportHeight) {
			top = anchorRect.top - 4; // will be adjusted by max-height CSS
			this.dropdownEl.style.maxHeight = `${anchorRect.top - 16}px`;
			this.dropdownEl.style.bottom = `${viewportHeight - anchorRect.top + 4}px`;
			this.dropdownEl.style.top = "auto";
		} else {
			this.dropdownEl.style.top = `${top}px`;
		}

		this.dropdownEl.style.left = `${left}px`;
		this.dropdownEl.style.position = "fixed";
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
