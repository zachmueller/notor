/**
 * Workflow activity indicator — persistent icon + badge in the chat panel header.
 *
 * Always visible in the chat panel header area. Shows:
 * - A clickable workflow/activity icon (anchor for the dropdown, Phase 2)
 * - A numeric badge with the count of active background workflows (hidden when 0)
 * - Animated state when workflows are running; static when idle
 * - Distinct "waiting for approval" visual treatment
 *
 * Animation is CSS-only for performance and respects `prefers-reduced-motion`.
 *
 * @see specs/03-workflows-personas/tasks/group-h-tasks.md — H-002, H-003
 * @see FR-53 — Workflow Activity Indicator
 */

import { setIcon } from "obsidian";
import type { WorkflowActivityTracker } from "../workflows/workflow-activity-tracker";
import { WorkflowActivityDropdown, type NavigateToConversationCallback } from "./workflow-activity-dropdown";
import type { ConversationSession } from "../chat/conversation-session";
import { logger } from "../utils/logger";

const log = logger("WorkflowActivityIndicator");

/**
 * Workflow activity indicator component for the chat panel header.
 *
 * Renders a clickable icon with a numeric badge overlay. Reactively
 * updates badge count and animation state via the tracker's `onChange`
 * callback. The icon is always visible regardless of workflow state.
 *
 * @see specs/03-workflows-personas/tasks/group-h-tasks.md — H-002, H-003
 */
export class WorkflowActivityIndicator {
	private readonly tracker: WorkflowActivityTracker;
	private readonly containerEl: HTMLElement;

	/** The root indicator element rendered in the header. */
	private indicatorEl: HTMLElement | null = null;
	/** The numeric badge element overlaid on the icon. */
	private badgeEl: HTMLElement | null = null;
	/** Unregister function for the tracker onChange callback. */
	private unregisterOnChange: (() => void) | null = null;
	/** The dropdown component for the activity popover (H-004). */
	private dropdown: WorkflowActivityDropdown | null = null;
	/** Callback for navigating to a conversation (H-005). */
	private onNavigateToConversation: NavigateToConversationCallback | null = null;
	/** Optional accessor for active foreground conversation sessions (Phase 3). */
	private readonly getActiveSessions?: () => ConversationSession[];

	/**
	 * @param containerEl - The chat panel header element to render into.
	 * @param tracker - The workflow activity tracker providing state data.
	 * @param getActiveSessions - Optional accessor for active foreground conversation sessions.
	 */
	constructor(
		containerEl: HTMLElement,
		tracker: WorkflowActivityTracker,
		getActiveSessions?: () => ConversationSession[],
	) {
		this.containerEl = containerEl;
		this.tracker = tracker;
		this.getActiveSessions = getActiveSessions;
	}

	// -----------------------------------------------------------------------
	// Rendering
	// -----------------------------------------------------------------------

	/**
	 * Create or update the indicator DOM elements in the header.
	 *
	 * Renders the icon and badge, registers the tracker onChange callback
	 * for reactive updates, and performs an initial update.
	 */
	render(): void {
		// Avoid duplicate rendering
		if (this.indicatorEl) {
			this.update();
			return;
		}

		// Create the indicator container element
		this.indicatorEl = createDiv({
			cls: "notor-workflow-activity-indicator",
			attr: {
				"aria-label": "Workflow activity",
				role: "button",
				tabindex: "0",
			},
		});

		// Set the icon using Obsidian's setIcon API (activity/zap icon)
		setIcon(this.indicatorEl, "activity");

		// Click handler — toggles the dropdown (H-004)
		this.indicatorEl.addEventListener("click", (e) => {
			e.stopPropagation();
			if (this.indicatorEl && this.dropdown) {
				this.dropdown.toggle(this.indicatorEl);
			}
		});

		// Create the numeric badge overlay
		this.badgeEl = this.indicatorEl.createSpan({
			cls: "notor-workflow-activity-badge is-hidden",
		});

		// Insert the indicator into the header actions area.
		// Position it after the first existing button (conversation history)
		// so it appears as the second icon in the header actions.
		const actionsEl = this.containerEl.querySelector(".notor-chat-header-actions");
		if (actionsEl) {
			const firstChild = actionsEl.firstChild;
			const secondChild = firstChild?.nextSibling ?? null;
			actionsEl.insertBefore(this.indicatorEl, secondChild);
		} else {
			// Fallback: append to the container
			this.containerEl.appendChild(this.indicatorEl);
		}

		// Initialize the dropdown component (H-004)
		this.dropdown = new WorkflowActivityDropdown(
			this.tracker,
			(conversationId: string) => {
				this.onNavigateToConversation?.(conversationId);
			},
			this.getActiveSessions,
		);

		// Register the onChange callback for reactive updates
		this.unregisterOnChange = this.tracker.onChange(() => {
			this.update();
		});

		// Initial state update
		this.update();

		log.debug("Workflow activity indicator rendered");
	}

	// -----------------------------------------------------------------------
	// State updates
	// -----------------------------------------------------------------------

	/**
	 * Combined update method — refreshes badge count, visibility, and
	 * animation state from the tracker.
	 *
	 * Called reactively via the tracker's `onChange` callback and on
	 * initial render.
	 */
	update(): void {
		this.updateBadge();
		this.updateAnimationState();
	}

	/**
	 * Read `tracker.getActiveCount()` and update the badge text/visibility.
	 *
	 * Badge is hidden when count is 0 (per FR-53). The indicator icon
	 * itself is always visible.
	 */
	updateBadge(): void {
		if (!this.badgeEl) return;

		const workflowCount = this.tracker.getActiveCount();
		const sessionCount = this.getActiveSessions?.().length ?? 0;
		const count = workflowCount + sessionCount;

		if (count > 0) {
			this.badgeEl.textContent = String(count);
			this.badgeEl.removeClass("is-hidden");
			this.badgeEl.setAttribute("data-count", String(count));
		} else {
			this.badgeEl.textContent = "";
			this.badgeEl.addClass("is-hidden");
			this.badgeEl.setAttribute("data-count", "0");
		}
	}

	/**
	 * Toggle CSS animation classes based on tracker state (H-003).
	 *
	 * - `is-active`: subtle animation when workflows are running
	 * - `is-waiting-approval`: prominent animation when approval needed
	 * - No classes: static/idle state
	 *
	 * Animations are CSS-only and respect `prefers-reduced-motion`.
	 */
	updateAnimationState(): void {
		if (!this.indicatorEl) return;

		const sessions = this.getActiveSessions?.() ?? [];
		const hasActive = this.tracker.hasActiveWorkflows() || sessions.length > 0;
		const hasWaiting = this.tracker.hasWaitingApproval() ||
			sessions.some(s => s.status === "waiting_approval");

		if (hasWaiting) {
			this.indicatorEl.addClass("is-waiting-approval");
			this.indicatorEl.removeClass("is-active");
		} else if (hasActive) {
			this.indicatorEl.addClass("is-active");
			this.indicatorEl.removeClass("is-waiting-approval");
		} else {
			this.indicatorEl.removeClass("is-active");
			this.indicatorEl.removeClass("is-waiting-approval");
		}
	}

	// -----------------------------------------------------------------------
	// Public accessors
	// -----------------------------------------------------------------------

	/**
	 * Return the indicator DOM element (used as anchor for the dropdown — H-004).
	 */
	getIndicatorEl(): HTMLElement | null {
		return this.indicatorEl;
	}

	/**
	 * Set the callback for navigating to a workflow's conversation (H-005).
	 *
	 * Called by `chat-view.ts` during initialization to wire the dropdown
	 * entry click handler to the chat panel's conversation switching logic.
	 *
	 * @param callback - Function that receives a conversation ID and switches
	 *                   the chat panel to display that conversation.
	 */
	setOnNavigateToConversation(callback: NavigateToConversationCallback): void {
		this.onNavigateToConversation = callback;
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Remove DOM elements and unregister the tracker callback.
	 *
	 * Called during `chat-view.ts` `onClose()`.
	 */
	destroy(): void {
		if (this.unregisterOnChange) {
			this.unregisterOnChange();
			this.unregisterOnChange = null;
		}

		// Destroy the dropdown (H-004)
		this.dropdown?.destroy();
		this.dropdown = null;

		if (this.indicatorEl) {
			this.indicatorEl.remove();
			this.indicatorEl = null;
		}

		this.badgeEl = null;

		log.debug("Workflow activity indicator destroyed");
	}
}
