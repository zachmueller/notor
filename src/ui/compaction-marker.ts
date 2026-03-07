/**
 * Compaction UI markers — inline indicators and permanent markers
 * for auto-compaction events in the chat thread.
 *
 * COMP-004: Shows "Compacting context…" during summarization and
 * a permanent "Context compacted" marker once complete.
 *
 * @see specs/02-context-intelligence/data-model.md — CompactionRecord
 * @see specs/02-context-intelligence/tasks.md — COMP-004
 */

// ---------------------------------------------------------------------------
// Compacting indicator (shown during summarization)
// ---------------------------------------------------------------------------

/**
 * Create and insert a "Compacting context…" indicator in the chat thread.
 *
 * @param container - The chat messages container element.
 * @returns The indicator element (for later replacement with the permanent marker).
 */
export function showCompactingIndicator(container: HTMLElement): HTMLElement {
	const indicator = container.createDiv({
		cls: "notor-compaction-indicator",
	});

	const spinner = indicator.createSpan({ cls: "notor-compaction-spinner" });
	spinner.textContent = "⟳";

	indicator.createSpan({
		cls: "notor-compaction-text",
		text: "Compacting context…",
	});

	// Scroll to the indicator
	indicator.scrollIntoView({ behavior: "smooth", block: "end" });

	return indicator;
}

// ---------------------------------------------------------------------------
// Permanent compaction marker
// ---------------------------------------------------------------------------

/**
 * Replace the compacting indicator with a permanent "Context compacted" marker.
 *
 * If no indicator is provided, creates the marker at the end of the container.
 *
 * @param container - The chat messages container element.
 * @param indicator - The temporary indicator to replace (or null).
 * @param timestamp - ISO 8601 timestamp of the compaction event.
 * @param tokenCount - Token count at compaction time.
 * @returns The permanent marker element.
 */
export function showCompactionMarker(
	container: HTMLElement,
	indicator: HTMLElement | null,
	timestamp: string,
	tokenCount: number
): HTMLElement {
	const marker = createCompactionMarkerEl(timestamp, tokenCount);

	if (indicator && indicator.parentElement === container) {
		container.replaceChild(marker, indicator);
	} else {
		// Remove indicator if it's elsewhere
		indicator?.remove();
		container.appendChild(marker);
	}

	return marker;
}

/**
 * Create a compaction marker element for rendering in the chat thread.
 *
 * Shows "Context compacted" with expandable details (timestamp and token count).
 *
 * @param timestamp - ISO 8601 timestamp of the compaction event.
 * @param tokenCount - Token count at compaction time.
 * @returns The marker DOM element.
 */
function createCompactionMarkerEl(timestamp: string, tokenCount: number): HTMLElement {
	const marker = document.createElement("div");
	marker.className = "notor-compaction-marker";

	const label = marker.createSpan({
		cls: "notor-compaction-marker-label",
		text: "Context compacted",
	});

	// Tooltip with details on hover
	const formattedTime = formatTimestamp(timestamp);
	const formattedTokens = tokenCount.toLocaleString();
	label.title = `Compacted at ${formattedTime}\n${formattedTokens} tokens at compaction`;

	// Expandable details (shown on click)
	const details = marker.createDiv({
		cls: "notor-compaction-marker-details",
	});
	details.style.display = "none";

	details.createDiv({
		cls: "notor-compaction-detail",
		text: `Time: ${formattedTime}`,
	});
	details.createDiv({
		cls: "notor-compaction-detail",
		text: `Tokens at compaction: ${formattedTokens}`,
	});

	// Toggle details on click
	label.addEventListener("click", () => {
		const isHidden = details.style.display === "none";
		details.style.display = isHidden ? "block" : "none";
	});

	return marker;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO 8601 timestamp for display.
 */
function formatTimestamp(iso: string): string {
	try {
		const date = new Date(iso);
		return date.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return iso;
	}
}