/**
 * Notor settings pure helper functions.
 *
 * Stateless utilities for provider lookup/update and cron expression
 * validation. Used by the settings UI and potentially by other modules.
 */

import { setIcon, type Setting } from "obsidian";
import type { LLMProviderConfig } from "../types";
import type { NotorSettings } from "./types";

// ---------------------------------------------------------------------------
// Provider config helpers
// ---------------------------------------------------------------------------

/** Look up a provider configuration by type, returning a stub if not found. */
export function getProvider(settings: NotorSettings, type: string): LLMProviderConfig {
	return (
		settings.providers.find((p) => p.type === type) ?? {
			type: type as LLMProviderConfig["type"],
			enabled: false,
			display_name: type,
		}
	);
}

/** Update or append a provider configuration in the settings array. */
export function updateProvider(settings: NotorSettings, updated: LLMProviderConfig): void {
	const idx = settings.providers.findIndex((p) => p.type === updated.type);
	if (idx >= 0) {
		settings.providers[idx] = updated;
	} else {
		settings.providers.push(updated);
	}
}

// ---------------------------------------------------------------------------
// Settings UI layout helpers
// ---------------------------------------------------------------------------

/** Extract a stable key from a <details> element's summary. */
function getDetailsKey(details: HTMLDetailsElement): string | null {
	const summary = details.querySelector("summary");
	if (!summary) return null;
	// Use specific child elements for stable keys (avoids dynamic text like "(3 hooks)")
	const nameEl =
		summary.querySelector(".notor-mcp-server-name") ??
		summary.querySelector("strong") ??
		summary.querySelector("span");
	return nameEl?.textContent?.trim() ?? null;
}

/** Snapshot open/closed state of all <details> elements under a container. */
export function snapshotDetailsState(containerEl: HTMLElement): Map<string, boolean> {
	const state = new Map<string, boolean>();
	containerEl.querySelectorAll<HTMLDetailsElement>("details").forEach((details) => {
		const key = getDetailsKey(details);
		if (key) state.set(key, details.open);
	});
	return state;
}

/** Restore open/closed state of <details> elements from a snapshot. */
export function restoreDetailsState(
	containerEl: HTMLElement,
	state: Map<string, boolean>
): void {
	if (state.size === 0) return;
	containerEl.querySelectorAll<HTMLDetailsElement>("details").forEach((details) => {
		const key = getDetailsKey(details);
		if (key !== null && state.has(key)) {
			details.open = state.get(key)!;
		}
	});
}

/**
 * Creates a top-level collapsible group in the settings pane.
 *
 * Wraps related section renderers inside a styled `<details>` element,
 * giving users a way to collapse areas they rarely need. Returns the body
 * `<div>` to pass as `containerEl` to the section renderers inside the group.
 */
export function createSettingsGroup(
	containerEl: HTMLElement,
	title: string,
	defaultOpen = false,
	persistedState?: Record<string, boolean>,
	onToggle?: (title: string, open: boolean) => void
): HTMLElement {
	const isOpen = persistedState && title in persistedState
		? persistedState[title]!
		: defaultOpen;
	const details = containerEl.createEl("details", {
		cls: "notor-settings-group",
		attr: { "data-notor-group": title },
	});
	if (isOpen) details.setAttribute("open", "");
	const summary = details.createEl("summary", {
		cls: "notor-settings-group-summary",
	});
	summary.createEl("span", { text: title });
	if (onToggle) {
		details.addEventListener("toggle", () => {
			onToggle(title, details.open);
		});
	}
	return details.createDiv({ cls: "notor-settings-group-body" });
}

// ---------------------------------------------------------------------------
// Subsection marking
// ---------------------------------------------------------------------------

/**
 * Stamp an element as a deep-linkable subsection within a settings group.
 *
 * Section renderers call this on heading `Setting` elements they want to
 * expose as targets for `notor-settings://Group/Subsection` URIs.
 */
export function markSubsection(setting: Setting, name: string): void {
	setting.settingEl.setAttribute("data-notor-subsection", name);
}

// ---------------------------------------------------------------------------
// Description truncation
// ---------------------------------------------------------------------------

/**
 * If a Setting's description exceeds the character threshold, replace it
 * with a truncated version and a clickable toggle icon to expand/collapse.
 * Descriptions at or below the threshold are left unchanged.
 */
export function applyDescriptionTruncation(
	setting: Setting,
	fullText: string,
	threshold = 255,
): void {
	if (!fullText || fullText.length <= threshold) return;

	const descEl = setting.descEl;
	descEl.empty();

	const truncatedSpan = descEl.createSpan({ cls: "notor-desc-truncated" });
	truncatedSpan.textContent = fullText.slice(0, threshold) + "…";

	const fullSpan = descEl.createSpan({ cls: "notor-desc-full notor-hidden" });
	fullSpan.textContent = fullText;

	const toggleSpan = descEl.createSpan({ cls: "notor-desc-toggle" });
	const iconEl = toggleSpan.createSpan();
	setIcon(iconEl, "chevron-right");
	toggleSpan.setAttribute("aria-label", "Show full description");
	toggleSpan.setAttribute("role", "button");
	toggleSpan.tabIndex = 0;

	let expanded = false;
	const toggle = () => {
		expanded = !expanded;
		truncatedSpan.toggleClass("notor-hidden", expanded);
		fullSpan.toggleClass("notor-hidden", !expanded);
		setIcon(iconEl, expanded ? "chevron-down" : "chevron-right");
		toggleSpan.setAttribute(
			"aria-label",
			expanded ? "Collapse description" : "Show full description",
		);
	};

	toggleSpan.addEventListener("click", toggle);
	toggleSpan.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			toggle();
		}
	});
}

// ---------------------------------------------------------------------------
// Cron expression validation
// ---------------------------------------------------------------------------

/**
 * Basic client-side cron expression validation for the settings UI.
 *
 * Validates the structure of a standard 5-field cron expression without
 * importing the full `croner` library. The `VaultEventScheduler` (F-013)
 * uses `croner`'s `CronPattern` for authoritative validation at runtime.
 *
 * Returns `{ valid: true, nextRun: Date }` on success or
 * `{ valid: false, error: string }` on failure.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-003
 */
export function validateCronExpressionBasic(
	expr: string
): { valid: true; nextRun: Date | null } | { valid: false; error: string; nextRun?: undefined } {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) {
		return {
			valid: false,
			error: `Expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}.`,
		};
	}

	const ranges = [
		{ name: "minute", min: 0, max: 59 },
		{ name: "hour", min: 0, max: 23 },
		{ name: "day-of-month", min: 1, max: 31 },
		{ name: "month", min: 1, max: 12 },
		{ name: "day-of-week", min: 0, max: 7 },
	];

	for (let i = 0; i < parts.length; i++) {
		const field = parts[i] ?? "";
		const range = ranges[i]!;

		// Wildcard
		if (field === "*") continue;

		// Validate each comma-separated segment
		const segments = field.split(",");
		for (const seg of segments) {
			// Step value (*/n or n-m/n)
			const stepMatch = seg.match(/^(.+)\/(\d+)$/);
			const base = stepMatch ? stepMatch[1]! : seg;
			const step = stepMatch ? parseInt(stepMatch[2]!, 10) : null;

			if (step !== null && (isNaN(step) || step < 1)) {
				return { valid: false, error: `Invalid step value in ${range.name} field: "${seg}".` };
			}

			// Range (n-m)
			const rangeMatch = base.match(/^(\d+)-(\d+)$/);
			if (rangeMatch) {
				const lo = parseInt(rangeMatch[1]!, 10);
				const hi = parseInt(rangeMatch[2]!, 10);
				if (lo < range.min || hi > range.max || lo > hi) {
					return {
						valid: false,
						error: `${range.name} range ${lo}-${hi} is out of bounds (${range.min}–${range.max}).`,
					};
				}
				continue;
			}

			// Wildcard base with step (*/n)
			if (base === "*") continue;

			// Single number
			const num = parseInt(base, 10);
			if (isNaN(num) || num < range.min || num > range.max) {
				return {
					valid: false,
					error: `${range.name} value "${base}" is out of bounds (${range.min}–${range.max}).`,
				};
			}
		}
	}

	// Approximate next run: find the next whole minute that satisfies the expression.
	// This is a best-effort preview, not a full cron evaluator.
	try {
		const now = new Date();
		const next = new Date(now.getTime() + 60_000);
		next.setSeconds(0, 0);
		return { valid: true, nextRun: next };
	} catch {
		return { valid: true, nextRun: null };
	}
}
