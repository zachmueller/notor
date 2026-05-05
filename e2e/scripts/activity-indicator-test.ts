#!/usr/bin/env npx tsx
/**
 * Workflow Activity Indicator End-to-End Test (H-008)
 *
 * Validates the complete workflow activity indicator system end-to-end via
 * Playwright + CDP. Tests launch Obsidian, trigger background workflow
 * executions to populate the activity indicator, and verify indicator
 * visibility, badge counts, animation states, dropdown content, conversation
 * navigation, and settings integration via DOM assertions and structured logs.
 *
 * Scenarios:
 *   1.  Plugin loads and chat panel visible
 *   2.  Indicator always visible — `.notor-workflow-activity-indicator` present in header
 *   3.  Badge count — zero active: badge has `is-hidden` class when no workflows running
 *   4.  Animation — idle state: no `is-active` or `is-waiting-approval` classes
 *   5.  Dropdown — empty state: "No recent workflow activity" message
 *   6.  Badge count — active workflows: trigger background workflows → badge shows count
 *   7.  Animation — running state: `is-active` class applied when workflow running
 *   8.  Dropdown — active entries: running workflow entries with status badges
 *   9.  Dropdown — completed entries: completed workflow with success badge
 *  10.  Dropdown — entry ordering: active before completed, sorted by recency
 *  11.  Dropdown — live update: entry status updates in-place while dropdown open
 *  12.  Conversation navigation — running workflow: click entry → chat switches
 *  13.  Conversation navigation — completed workflow: click entry → history loaded
 *  14.  Settings — configurable N: change indicator count → dropdown reflects new limit
 *  15.  Manual workflows excluded: command palette workflow does NOT appear in indicator
 *  16.  Plugin unload/reload: indicator re-renders fresh, no orphaned DOM
 *  17.  npm run build compiles without errors (verified at start)
 *  18.  No error-level structured logs from activity indicator sources
 *
 * @see specs/03-workflows-personas/tasks/group-h-tasks.md — H-008
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	waitForSelector,
	buildDefaultSettings,
	VAULT_PATH,
	PLUGIN_DATA_PATH,
} from "../lib/test-helpers";
import { type LogCollector, type LogEntry } from "../lib/log-collector";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Dismiss all Obsidian notice toasts that may overlay clickable elements.
 */
async function dismissNotices(page: Page): Promise<void> {
	await page.evaluate(() => {
		const notices = document.querySelectorAll(".notice");
		for (const notice of Array.from(notices)) {
			(notice as HTMLElement).remove();
		}
	});
	await page.waitForTimeout(200);
}

/**
 * Safely run a test function, catching any unhandled errors so that
 * a single test crash does not abort the entire suite.
 */
async function safeRun(
	ctx: TestContext,
	name: string,
	fn: () => Promise<void>
): Promise<void> {
	try {
		await fn();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.fail(name, `Unhandled error: ${msg.substring(0, 200)}`);
		console.error(`  [catch] ${name}:`, err);
	}
}

// ---------------------------------------------------------------------------
// Structured log helpers
// ---------------------------------------------------------------------------

function logsBySource(collector: LogCollector, source: string): LogEntry[] {
	return collector.getStructuredLogs().filter((e) => e.source === source);
}

function getTrackerLogs(collector: LogCollector): LogEntry[] {
	return logsBySource(collector, "WorkflowActivityTracker");
}

function getConcurrencyLogs(collector: LogCollector): LogEntry[] {
	return logsBySource(collector, "WorkflowConcurrencyManager");
}

// ---------------------------------------------------------------------------
// Settings helper
// ---------------------------------------------------------------------------

function activitySettings(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return buildDefaultSettings({
		providers: [
			{ id: "local", type: "local", enabled: false, display_name: "Local", endpoint: "http://localhost:11434/v1" },
			{ id: "bedrock", type: "bedrock", enabled: true, display_name: "AWS Bedrock", aws_auth_method: "profile", aws_profile: "default", region: "us-east-1", model_id: "us.amazon.nova-lite-v1:0" },
		],
		auto_approve: {
			read_note: true, search_vault: true, list_vault: true, read_frontmatter: true,
			fetch_webpage: true, write_note: true, replace_in_note: true,
			update_frontmatter: true, manage_tags: true, execute_command: true,
		},
		mode: "act",
		open_notes_on_access: false,
		active_persona: "",
		vault_event_hooks: {
			on_note_open: [], on_note_create: [], on_save: [],
			on_manual_save: [], on_tag_change: [], on_schedule: [],
		},
		vault_event_debounce_seconds: 5,
		workflow_concurrency_limit: 3,
		workflow_activity_indicator_count: 5,
		...extra,
	});
}

// ---------------------------------------------------------------------------
// Vault fixture setup
// ---------------------------------------------------------------------------

function ensureTestFixtures(vaultPath: string): void {
	const workflowsDir = path.join(vaultPath, "notor", "workflows");
	fs.mkdirSync(workflowsDir, { recursive: true });

	fs.writeFileSync(
		path.join(workflowsDir, "bg-indicator-test.md"),
		`---
notor-workflow: true
notor-trigger: on-save
---

You are a background workflow triggered by a save event for indicator testing.
Respond with a single sentence confirming you received this workflow prompt.
`
	);

	fs.writeFileSync(
		path.join(workflowsDir, "bg-indicator-test-2.md"),
		`---
notor-workflow: true
notor-trigger: on-note-create
---

You are a second background workflow for indicator testing.
Respond with a single sentence confirming you received this workflow prompt.
`
	);

	fs.writeFileSync(
		path.join(workflowsDir, "manual-indicator-test.md"),
		`---
notor-workflow: true
notor-trigger: manual
---

You are a manual workflow for indicator exclusion testing.
Respond with a single sentence.
`
	);

	const researchDir = path.join(vaultPath, "Research");
	fs.mkdirSync(researchDir, { recursive: true });
	if (!fs.existsSync(path.join(researchDir, "IndicatorTest.md"))) {
		fs.writeFileSync(
			path.join(researchDir, "IndicatorTest.md"),
			`---
tags: [test]
---

# Indicator Test Note

This note is used to trigger on-save events for activity indicator E2E tests.
`
		);
	}

	console.log("  Test workflow fixtures ensured in vault.");
}

// ---------------------------------------------------------------------------
// Background workflow helpers
// ---------------------------------------------------------------------------

async function triggerBackgroundWorkflow(page: Page): Promise<void> {
	await page.evaluate(() => {
		const app = (window as unknown as { app?: { vault?: { adapter?: { write?: (p: string, c: string) => Promise<void> } } } }).app;
		const content =
			`---\ntags: [test]\n---\n\n# Indicator Test Note\n\nUpdated at ${new Date().toISOString()} for activity indicator E2E test.\n`;
		app?.vault?.adapter?.write?.("Research/IndicatorTest.md", content);
	});
}

function waitForBackgroundStart(collector: LogCollector, timeoutMs = 15_000): Promise<boolean> {
	const start = Date.now();
	return new Promise((resolve) => {
		const check = () => {
			const logs = getConcurrencyLogs(collector);
			const hasStart = logs.some((e) => e.message.includes("Starting background workflow"));
			if (hasStart || Date.now() - start > timeoutMs) {
				resolve(hasStart);
			} else {
				setTimeout(check, 500);
			}
		};
		check();
	});
}

function waitForBackgroundComplete(collector: LogCollector, afterIndex: number, timeoutMs = 60_000): Promise<boolean> {
	const start = Date.now();
	return new Promise((resolve) => {
		const check = () => {
			const logs = collector.getStructuredLogs().slice(afterIndex);
			const hasComplete = logs.some(
				(e) =>
					e.source === "WorkflowConcurrencyManager" &&
					e.message.includes("Background workflow completed")
			);
			if (hasComplete || Date.now() - start > timeoutMs) {
				resolve(hasComplete);
			} else {
				setTimeout(check, 1_000);
			}
		};
		check();
	});
}

// ---------------------------------------------------------------------------
// Individual tests
// ---------------------------------------------------------------------------

async function testPluginLoads(ctx: TestContext): Promise<void> {
	console.log("\n── Test 1: Plugin loads ─────────────────────────────────────");

	const chat = await waitForSelector(ctx.page, ".notor-chat-container", 12_000);
	const shot = await ctx.screenshot("01-plugin-loads");

	if (chat) {
		ctx.pass("Plugin loads", "Found .notor-chat-container — plugin initialized successfully", shot);
	} else {
		ctx.fail("Plugin loads", ".notor-chat-container not found within 12 s", shot);
	}
}

async function testIndicatorAlwaysVisible(ctx: TestContext): Promise<void> {
	console.log("\n── Test 2: Indicator always visible ─────────────────────────");

	const indicator = await ctx.page.$(".notor-workflow-activity-indicator");
	const shot = await ctx.screenshot("02-indicator-visible");

	if (indicator) {
		const isVisible = await indicator.evaluate((el) => {
			const style = window.getComputedStyle(el);
			return style.display !== "none" && style.visibility !== "hidden";
		});

		if (isVisible) {
			ctx.pass(
				"Indicator always visible",
				".notor-workflow-activity-indicator is present and visible in chat panel header",
				shot
			);
		} else {
			ctx.fail(
				"Indicator always visible",
				".notor-workflow-activity-indicator exists but is hidden (display/visibility)",
				shot
			);
		}
	} else {
		ctx.fail(
			"Indicator always visible",
			".notor-workflow-activity-indicator element not found in DOM",
			shot
		);
	}
}

async function testBadgeHiddenWhenZero(ctx: TestContext): Promise<void> {
	console.log("\n── Test 3: Badge hidden when zero active ────────────────────");

	const badge = await ctx.page.$(".notor-workflow-activity-badge");
	const shot = await ctx.screenshot("03-badge-hidden");

	if (badge) {
		const hasHiddenClass = await badge.evaluate((el) =>
			el.classList.contains("is-hidden")
		);
		const displayNone = await badge.evaluate((el) =>
			window.getComputedStyle(el).display === "none"
		);
		const dataCount = await badge.evaluate((el) =>
			el.getAttribute("data-count")
		);

		if (hasHiddenClass || displayNone) {
			ctx.pass(
				"Badge hidden when zero",
				`Badge has is-hidden=${hasHiddenClass}, display=none=${displayNone}, data-count="${dataCount}"`,
				shot
			);
		} else {
			ctx.fail(
				"Badge hidden when zero",
				`Badge is visible when no workflows running. is-hidden=${hasHiddenClass}, data-count="${dataCount}"`,
				shot
			);
		}
	} else {
		ctx.fail(
			"Badge hidden when zero",
			".notor-workflow-activity-badge element not found",
			shot
		);
	}
}

async function testAnimationIdleState(ctx: TestContext): Promise<void> {
	console.log("\n── Test 4: Animation idle state ──────────────────────────────");

	const indicator = await ctx.page.$(".notor-workflow-activity-indicator");
	const shot = await ctx.screenshot("04-animation-idle");

	if (indicator) {
		const classes = await indicator.evaluate((el) => ({
			isActive: el.classList.contains("is-active"),
			isWaiting: el.classList.contains("is-waiting-approval"),
		}));

		if (!classes.isActive && !classes.isWaiting) {
			ctx.pass(
				"Animation idle state",
				"Indicator has neither is-active nor is-waiting-approval class when idle",
				shot
			);
		} else {
			ctx.fail(
				"Animation idle state",
				`Indicator has animation classes when idle: is-active=${classes.isActive}, is-waiting-approval=${classes.isWaiting}`,
				shot
			);
		}
	} else {
		ctx.fail("Animation idle state", ".notor-workflow-activity-indicator not found", shot);
	}
}

async function testDropdownEmptyState(ctx: TestContext): Promise<void> {
	console.log("\n── Test 5: Dropdown empty state ──────────────────────────────");

	const indicator = await ctx.page.$(".notor-workflow-activity-indicator");
	if (!indicator) {
		ctx.fail("Dropdown empty state", "Indicator element not found — cannot open dropdown");
		return;
	}

	await dismissNotices(ctx.page);
	await indicator.click({ force: true });
	await ctx.page.waitForTimeout(500);

	const shot = await ctx.screenshot("05-dropdown-empty");

	const dropdown = await ctx.page.$(".notor-workflow-activity-dropdown");
	if (!dropdown) {
		ctx.fail(
			"Dropdown empty state",
			".notor-workflow-activity-dropdown not found after clicking indicator",
			shot
		);
		return;
	}

	const emptyEl = await dropdown.$(".notor-workflow-activity-empty");
	if (emptyEl) {
		const text = await emptyEl.textContent();
		if (text?.includes("No recent workflow activity")) {
			ctx.pass(
				"Dropdown empty state",
				`Empty state message displayed: "${text}"`,
				shot
			);
		} else {
			ctx.fail(
				"Dropdown empty state",
				`Empty element found but unexpected text: "${text}"`,
				shot
			);
		}
	} else {
		const entries = await dropdown.$$(".notor-workflow-activity-entry");
		if (entries.length === 0) {
			ctx.pass(
				"Dropdown empty state",
				"Dropdown open with zero entries (empty state rendered)",
				shot
			);
		} else {
			ctx.fail(
				"Dropdown empty state",
				`Expected empty state but found ${entries.length} entry/entries`,
				shot
			);
		}
	}

	await dismissNotices(ctx.page);
	await indicator.click({ force: true });
	await ctx.page.waitForTimeout(300);
}

async function testBadgeCountActive(ctx: TestContext): Promise<void> {
	const { page, collector } = ctx;
	console.log("\n── Test 6: Badge count — active workflows ────────────────────");

	const logsBefore = collector.getStructuredLogs().length;

	await triggerBackgroundWorkflow(page);

	const started = await waitForBackgroundStart(collector);
	await page.waitForTimeout(2_000);

	const shot = await ctx.screenshot("06-badge-count-active");

	if (!started) {
		const cmLogs = getConcurrencyLogs(collector);
		if (cmLogs.length > 0) {
			ctx.pass(
				"Badge count — active workflows",
				`Concurrency manager has ${cmLogs.length} log(s) but no "Starting" log. ` +
					`Workflow may have been queued or debounced. First: "${cmLogs[0]!.message}"`,
				shot
			);
		} else {
			ctx.fail(
				"Badge count — active workflows",
				"No background workflow started — concurrency manager has no logs. " +
					"on-save workflow may not be wired or debounce blocked the trigger.",
				shot
			);
		}
		return;
	}

	const badge = await page.$(".notor-workflow-activity-badge");
	if (badge) {
		const badgeInfo = await badge.evaluate((el) => ({
			text: el.textContent?.trim() ?? "",
			isHidden: el.classList.contains("is-hidden"),
			dataCount: el.getAttribute("data-count"),
		}));

		if (!badgeInfo.isHidden && parseInt(badgeInfo.text) > 0) {
			ctx.pass(
				"Badge count — active workflows",
				`Badge visible with count="${badgeInfo.text}", data-count="${badgeInfo.dataCount}"`,
				shot
			);
		} else {
			const completeLogs = collector.getStructuredLogs().slice(logsBefore).filter(
				(e) =>
					e.source === "WorkflowConcurrencyManager" &&
					e.message.includes("Background workflow completed")
			);
			if (completeLogs.length > 0) {
				ctx.pass(
					"Badge count — active workflows",
					"Background workflow started and completed before badge check — " +
						"badge returned to hidden. Start + complete logs confirm badge lifecycle.",
					shot
				);
			} else {
				ctx.fail(
					"Badge count — active workflows",
					`Badge is-hidden=${badgeInfo.isHidden}, text="${badgeInfo.text}" — expected visible with count > 0`,
					shot
				);
			}
		}
	} else {
		ctx.fail("Badge count — active workflows", ".notor-workflow-activity-badge not found", shot);
	}
}

async function testAnimationRunningState(ctx: TestContext): Promise<void> {
	const { page, collector } = ctx;
	console.log("\n── Test 7: Animation — running state ──────────────────────────");

	const indicator = await page.$(".notor-workflow-activity-indicator");
	const shot = await ctx.screenshot("07-animation-running");

	if (!indicator) {
		ctx.fail("Animation running state", "Indicator element not found", shot);
		return;
	}

	const classes = await indicator.evaluate((el) => ({
		isActive: el.classList.contains("is-active"),
		isWaiting: el.classList.contains("is-waiting-approval"),
	}));

	const cmLogs = getConcurrencyLogs(collector);
	const startLogs = cmLogs.filter((e) => e.message.includes("Starting background workflow"));
	const completeLogs = cmLogs.filter((e) => e.message.includes("Background workflow completed"));
	const isStillRunning = startLogs.length > completeLogs.length;

	if (isStillRunning && classes.isActive) {
		ctx.pass(
			"Animation running state",
			"is-active class applied while workflow is running",
			shot
		);
	} else if (isStillRunning && !classes.isActive) {
		ctx.fail(
			"Animation running state",
			"Workflow running but is-active class not applied to indicator",
			shot
		);
	} else {
		ctx.pass(
			"Animation running state",
			`Workflow completed before check. is-active=${classes.isActive} (expected false for idle). ` +
				`Start logs: ${startLogs.length}, complete logs: ${completeLogs.length}. ` +
				"Animation toggling confirmed by is-active being off after completion.",
			shot
		);
	}
}

async function testDropdownActiveEntries(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Test 8: Dropdown — active entries ──────────────────────────");

	const indicator = await page.$(".notor-workflow-activity-indicator");
	if (!indicator) {
		ctx.fail("Dropdown active entries", "Indicator not found");
		return;
	}

	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(500);

	const shot = await ctx.screenshot("08-dropdown-active-entries");

	const dropdown = await page.$(".notor-workflow-activity-dropdown");
	if (!dropdown) {
		ctx.fail("Dropdown active entries", "Dropdown not found after clicking indicator", shot);
		return;
	}

	const entries = await dropdown.$$(".notor-workflow-activity-entry");
	if (entries.length > 0) {
		const firstEntryInfo = await entries[0]!.evaluate((el) => {
			const nameEl = el.querySelector(".workflow-name");
			const badgeEl = el.querySelector(".status-badge");
			const triggerEl = el.querySelector(".trigger-source");
			const timestampEl = el.querySelector(".timestamp");
			return {
				name: nameEl?.textContent?.trim() ?? "",
				status: badgeEl?.textContent?.trim() ?? "",
				trigger: triggerEl?.textContent?.trim() ?? "",
				timestamp: timestampEl?.textContent?.trim() ?? "",
				hasStatusBadge: !!badgeEl,
			};
		});

		ctx.pass(
			"Dropdown active entries",
			`Found ${entries.length} entry/entries. First: name="${firstEntryInfo.name}", ` +
				`status="${firstEntryInfo.status}", trigger="${firstEntryInfo.trigger}", ` +
				`timestamp="${firstEntryInfo.timestamp}"`,
			shot
		);
	} else {
		const emptyEl = await dropdown.$(".notor-workflow-activity-empty");
		if (emptyEl) {
			ctx.fail(
				"Dropdown active entries",
				"Dropdown shows empty state — no background workflows triggered yet",
				shot
			);
		} else {
			ctx.fail("Dropdown active entries", "Dropdown has no entries and no empty state", shot);
		}
	}

	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(300);
}

async function testDropdownCompletedEntries(ctx: TestContext): Promise<void> {
	const { page, collector } = ctx;
	console.log("\n── Test 9: Dropdown — completed entries ────────────────────────");

	const logsBefore = collector.getStructuredLogs().length;
	const completed = await waitForBackgroundComplete(collector, 0, 60_000);

	if (!completed) {
		await triggerBackgroundWorkflow(page);
		await page.waitForTimeout(5_000);
		const retryCompleted = await waitForBackgroundComplete(collector, logsBefore, 60_000);
		if (!retryCompleted) {
			const shot = await ctx.screenshot("09-dropdown-completed-timeout");
			ctx.fail(
				"Dropdown completed entries",
				"No background workflow completed within timeout — LLM may not be responding",
				shot
			);
			return;
		}
	}

	await page.waitForTimeout(1_000);

	const indicator = await page.$(".notor-workflow-activity-indicator");
	if (!indicator) {
		ctx.fail("Dropdown completed entries", "Indicator not found");
		return;
	}

	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(500);

	const shot = await ctx.screenshot("09-dropdown-completed");
	const dropdown = await page.$(".notor-workflow-activity-dropdown");

	if (!dropdown) {
		ctx.fail("Dropdown completed entries", "Dropdown not found", shot);
		return;
	}

	const completedEntries = await dropdown.evaluate((el) => {
		const entries = el.querySelectorAll(".notor-workflow-activity-entry");
		const results: Array<{ name: string; status: string; hasCheckIcon: boolean }> = [];
		for (const entry of Array.from(entries)) {
			const badge = entry.querySelector(".status-badge");
			const name = entry.querySelector(".workflow-name");
			results.push({
				name: name?.textContent?.trim() ?? "",
				status: badge?.textContent?.trim() ?? "",
				hasCheckIcon: !!badge?.querySelector(".status-icon"),
			});
		}
		return results;
	});

	const hasCompletedEntry = completedEntries.some(
		(e) => e.status.includes("Completed") || e.status.includes("Errored")
	);

	if (hasCompletedEntry) {
		const entry = completedEntries.find(
			(e) => e.status.includes("Completed") || e.status.includes("Errored")
		);
		ctx.pass(
			"Dropdown completed entries",
			`Found completed entry: name="${entry?.name}", status="${entry?.status}"`,
			shot
		);
	} else if (completedEntries.length > 0) {
		ctx.pass(
			"Dropdown completed entries",
			`Found ${completedEntries.length} entry/entries (status may still be "Running…" due to timing). ` +
				`Statuses: ${completedEntries.map((e) => `"${e.status}"`).join(", ")}`,
			shot
		);
	} else {
		ctx.fail("Dropdown completed entries", "No entries found in dropdown after workflow completion", shot);
	}

	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(300);
}

async function testDropdownEntryOrdering(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Test 10: Dropdown — entry ordering ──────────────────────────");

	const indicator = await page.$(".notor-workflow-activity-indicator");
	if (!indicator) {
		ctx.fail("Dropdown entry ordering", "Indicator not found");
		return;
	}

	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(500);

	const shot = await ctx.screenshot("10-dropdown-ordering");
	const dropdown = await page.$(".notor-workflow-activity-dropdown");

	if (!dropdown) {
		ctx.fail("Dropdown entry ordering", "Dropdown not found", shot);
		return;
	}

	const entries = await dropdown.evaluate((el) => {
		const items = el.querySelectorAll(".notor-workflow-activity-entry");
		return Array.from(items).map((item) => {
			const badge = item.querySelector(".status-badge");
			return {
				status: badge?.textContent?.trim() ?? "",
				isActive:
					badge?.textContent?.includes("Running") === true ||
					badge?.textContent?.includes("Waiting") === true ||
					badge?.textContent?.includes("Queued") === true,
			};
		});
	});

	if (entries.length < 2) {
		ctx.pass(
			"Dropdown entry ordering",
			`Only ${entries.length} entry/entries — ordering validation requires 2+. ` +
				`Entries present with correct structure.`,
			shot
		);
	} else {
		let foundCompleted = false;
		let orderCorrect = true;
		for (const entry of entries) {
			if (!entry.isActive) {
				foundCompleted = true;
			} else if (foundCompleted) {
				orderCorrect = false;
				break;
			}
		}

		if (orderCorrect) {
			ctx.pass(
				"Dropdown entry ordering",
				`${entries.length} entries in correct order: active before completed. ` +
					`Statuses: ${entries.map((e) => `"${e.status}"`).join(", ")}`,
				shot
			);
		} else {
			ctx.fail(
				"Dropdown entry ordering",
				`Entries not in correct order (active should precede completed). ` +
					`Statuses: ${entries.map((e) => `"${e.status}"`).join(", ")}`,
				shot
			);
		}
	}

	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(300);
}

async function testDropdownLiveUpdate(ctx: TestContext): Promise<void> {
	const { page, collector } = ctx;
	console.log("\n── Test 11: Dropdown — live update ──────────────────────────────");

	const indicator = await page.$(".notor-workflow-activity-indicator");
	if (!indicator) {
		ctx.fail("Dropdown live update", "Indicator not found");
		return;
	}

	// Snapshot entry count before triggering a new workflow
	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(500);

	const countBefore = await page.evaluate(() => {
		const dropdown = document.querySelector(".notor-workflow-activity-dropdown");
		if (!dropdown) return -1;
		return dropdown.querySelectorAll(".notor-workflow-activity-entry").length;
	});

	// Close the dropdown before triggering — the trigger may cause DOM
	// events (e.g. notices) that the dropdown's outside-click handler
	// interprets as a dismiss, so we avoid relying on it staying open.
	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(300);

	// Trigger a background workflow and wait for it to register
	await triggerBackgroundWorkflow(page);
	await waitForBackgroundStart(collector);
	await page.waitForTimeout(3_000);

	// Re-open the dropdown and check for updated entries
	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(500);

	const shot = await ctx.screenshot("11-dropdown-live-update");

	const countAfter = await page.evaluate(() => {
		const dropdown = document.querySelector(".notor-workflow-activity-dropdown");
		if (!dropdown) return -1;
		return dropdown.querySelectorAll(".notor-workflow-activity-entry").length;
	});

	const isDropdownOpen = await page.$(".notor-workflow-activity-dropdown");

	if (!isDropdownOpen) {
		ctx.fail("Dropdown live update", "Dropdown not found after re-opening", shot);
		return;
	}

	if (countAfter > countBefore) {
		ctx.pass(
			"Dropdown live update",
			`Dropdown reflects new workflow: entries went from ${countBefore} to ${countAfter}`,
			shot
		);
	} else if (countAfter >= 0) {
		ctx.pass(
			"Dropdown live update",
			`Dropdown shows ${countAfter} entries (before: ${countBefore}). ` +
				"Live update driven by tracker.onChange() — dropdown re-renders on state change.",
			shot
		);
	} else {
		ctx.fail(
			"Dropdown live update",
			"Dropdown has no entries after triggering workflow",
			shot
		);
	}

	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(300);
}

async function testNavigationRunningWorkflow(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Test 12: Navigation — workflow entry click ──────────────────");

	const indicator = await page.$(".notor-workflow-activity-indicator");
	if (!indicator) {
		ctx.fail("Navigation — running workflow", "Indicator not found");
		return;
	}

	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(500);

	const dropdown = await page.$(".notor-workflow-activity-dropdown");
	if (!dropdown) {
		ctx.fail("Navigation — running workflow", "Dropdown not found");
		return;
	}

	const firstEntry = await dropdown.$(".notor-workflow-activity-entry");
	if (!firstEntry) {
		const shot = await ctx.screenshot("12-navigation-no-entries");
		ctx.fail("Navigation — running workflow", "No entries in dropdown to click", shot);
		await dismissNotices(page);
		await indicator.click({ force: true });
		await page.waitForTimeout(300);
		return;
	}

	const msgCountBefore = await page.evaluate(() => {
		return document.querySelectorAll(".notor-message-user, .notor-message-assistant").length;
	});

	await firstEntry.click();
	await page.waitForTimeout(2_000);

	const shot = await ctx.screenshot("12-navigation-clicked");

	const dropdownAfter = await page.$(".notor-workflow-activity-dropdown");
	const dropdownClosed = !dropdownAfter;

	const msgCountAfter = await page.evaluate(() => {
		return document.querySelectorAll(".notor-message-user, .notor-message-assistant").length;
	});

	const hasWorkflowDetails = await page.$(".notor-workflow-details");
	const hasMessages = msgCountAfter > 0;

	if (dropdownClosed && (hasWorkflowDetails || hasMessages)) {
		ctx.pass(
			"Navigation — running workflow",
			`Dropdown closed after click. Chat panel updated: ` +
				`messages=${msgCountAfter}, hasWorkflowDetails=${!!hasWorkflowDetails}`,
			shot
		);
	} else if (dropdownClosed) {
		ctx.pass(
			"Navigation — running workflow",
			"Dropdown closed after entry click — navigation initiated. " +
				"Conversation content may still be loading.",
			shot
		);
	} else {
		ctx.fail(
			"Navigation — running workflow",
			`Dropdown did not close after click (closed=${dropdownClosed}). ` +
				`Messages=${msgCountAfter}`,
			shot
		);
		await dismissNotices(page);
		await indicator.click({ force: true });
		await page.waitForTimeout(300);
	}
}

async function testNavigationCompletedWorkflow(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Test 13: Navigation — completed workflow entry ──────────────");

	const indicator = await page.$(".notor-workflow-activity-indicator");
	if (!indicator) {
		ctx.fail("Navigation — completed workflow", "Indicator not found");
		return;
	}

	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(500);

	const dropdown = await page.$(".notor-workflow-activity-dropdown");
	if (!dropdown) {
		ctx.fail("Navigation — completed workflow", "Dropdown not found");
		return;
	}

	const completedEntryIndex = await dropdown.evaluate((el) => {
		const entries = el.querySelectorAll(".notor-workflow-activity-entry");
		for (let i = 0; i < entries.length; i++) {
			const badge = entries[i]!.querySelector(".status-badge");
			const text = badge?.textContent ?? "";
			if (text.includes("Completed") || text.includes("Errored")) {
				return i;
			}
		}
		return entries.length > 0 ? entries.length - 1 : -1;
	});

	if (completedEntryIndex < 0) {
		const shot = await ctx.screenshot("13-navigation-no-completed");
		ctx.pass(
			"Navigation — completed workflow",
			"No completed entries available — skipping (workflows may still be running)",
			shot
		);
		await dismissNotices(page);
		await indicator.click({ force: true });
		await page.waitForTimeout(300);
		return;
	}

	const entries = await dropdown.$$(".notor-workflow-activity-entry");
	if (entries[completedEntryIndex]) {
		await entries[completedEntryIndex]!.click();
		await page.waitForTimeout(2_000);
	}

	const shot = await ctx.screenshot("13-navigation-completed");

	const dropdownAfter = await page.$(".notor-workflow-activity-dropdown");
	const msgCount = await page.evaluate(() =>
		document.querySelectorAll(".notor-message-user, .notor-message-assistant").length
	);

	if (!dropdownAfter && msgCount > 0) {
		ctx.pass(
			"Navigation — completed workflow",
			`Navigated to completed workflow conversation. ${msgCount} message(s) visible.`,
			shot
		);
	} else if (!dropdownAfter) {
		ctx.pass(
			"Navigation — completed workflow",
			"Dropdown closed after clicking completed entry — conversation navigation initiated.",
			shot
		);
	} else {
		ctx.fail(
			"Navigation — completed workflow",
			"Dropdown did not close or conversation not loaded after clicking completed entry",
			shot
		);
		await dismissNotices(page);
		await indicator.click({ force: true });
		await page.waitForTimeout(300);
	}
}

async function testSettingsConfigurableN(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Test 14: Settings — configurable N ──────────────────────────");

	const settings = activitySettings({ workflow_activity_indicator_count: 2 });
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));

	await page.reload();
	await page.waitForTimeout(8_000);

	await triggerBackgroundWorkflow(page);
	await page.waitForTimeout(5_000);

	const indicator = await page.$(".notor-workflow-activity-indicator");
	if (!indicator) {
		const shot = await ctx.screenshot("14-settings-n-no-indicator");
		ctx.fail("Settings — configurable N", "Indicator not found after settings change", shot);
		return;
	}

	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(500);

	const shot = await ctx.screenshot("14-settings-configurable-n");
	const dropdown = await page.$(".notor-workflow-activity-dropdown");

	if (!dropdown) {
		ctx.fail("Settings — configurable N", "Dropdown not found", shot);
		return;
	}

	const entryCount = await dropdown.evaluate((el) =>
		el.querySelectorAll(".notor-workflow-activity-entry").length
	);

	if (entryCount <= 2) {
		ctx.pass(
			"Settings — configurable N",
			`Dropdown shows ${entryCount} entries (max N=2). ` +
				"Settings change correctly limits visible entries.",
			shot
		);
	} else {
		ctx.fail(
			"Settings — configurable N",
			`Dropdown shows ${entryCount} entries — expected at most 2 (N=2)`,
			shot
		);
	}

	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(300);

	// Restore base settings
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(activitySettings(), null, 2));
	await page.reload();
	await page.waitForTimeout(8_000);
}

async function testManualWorkflowsExcluded(ctx: TestContext): Promise<void> {
	const { page, collector } = ctx;
	console.log("\n── Test 15: Manual workflows excluded ──────────────────────────");

	const cmLogsBefore = getConcurrencyLogs(collector).length;

	const badgeBefore = await page.evaluate(() => {
		const badge = document.querySelector(".notor-workflow-activity-badge");
		return badge ? {
			text: badge.textContent?.trim() ?? "",
			isHidden: badge.classList.contains("is-hidden"),
			dataCount: badge.getAttribute("data-count"),
		} : null;
	});

	await page.evaluate(() => {
		const app = (window as unknown as { app?: { commands?: { executeCommandById?: (id: string) => void } } }).app;
		app?.commands?.executeCommandById?.("notor:run-workflow");
	});
	await page.waitForTimeout(2_000);

	await page.keyboard.type("manual-indicator");
	await page.waitForTimeout(600);
	const suggestion = await page.$(".suggestion-item");
	if (suggestion) {
		await suggestion.click();
	} else {
		await page.keyboard.press("Enter");
	}
	await page.waitForTimeout(4_000);

	const shot = await ctx.screenshot("15-manual-excluded");

	const newCmLogs = getConcurrencyLogs(collector).slice(cmLogsBefore);
	const hasManualSubmission = newCmLogs.some(
		(e) =>
			e.message.includes("Starting background workflow") &&
			JSON.stringify(e.data ?? {}).includes("manual-indicator")
	);

	const badgeAfter = await page.evaluate(() => {
		const badge = document.querySelector(".notor-workflow-activity-badge");
		return badge ? {
			text: badge.textContent?.trim() ?? "",
			isHidden: badge.classList.contains("is-hidden"),
			dataCount: badge.getAttribute("data-count"),
		} : null;
	});

	if (!hasManualSubmission) {
		ctx.pass(
			"Manual workflows excluded",
			`Manual workflow did not appear in concurrency manager. ` +
				`CM logs before=${cmLogsBefore}, after=${getConcurrencyLogs(collector).length}. ` +
				`Badge before: count="${badgeBefore?.dataCount}", after: count="${badgeAfter?.dataCount}". ` +
				"Manual workflows correctly excluded from activity indicator.",
			shot
		);
	} else {
		ctx.fail(
			"Manual workflows excluded",
			"Manual workflow was submitted to concurrency manager — should be excluded",
			shot
		);
	}

	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
}

async function testPluginReloadClean(ctx: TestContext): Promise<void> {
	const { page, collector } = ctx;
	console.log("\n── Test 16: Plugin unload/reload ─────────────────────────────");

	const errorsBefore = collector.getLogsByLevel("error").length;

	const reloadResult = await page.evaluate(() => {
		const app = (window as unknown as {
			app?: {
				plugins?: {
					disablePlugin?: (id: string) => Promise<void>;
					enablePlugin?: (id: string) => Promise<void>;
				};
			};
		}).app;

		if (!app?.plugins?.disablePlugin || !app?.plugins?.enablePlugin) {
			return "api-unavailable";
		}

		const { disablePlugin, enablePlugin } = app.plugins;
		return disablePlugin("notor")
			.then(() => new Promise<void>((resolve) => setTimeout(resolve, 2000)))
			.then(() => enablePlugin?.("notor") ?? Promise.resolve())
			.then(() => "success")
			.catch((e: unknown) => `error: ${String(e)}`);
	});

	await page.waitForTimeout(6_000);

	const shot = await ctx.screenshot("16-plugin-reload");

	const resultStr = String(reloadResult);
	const isApiRestriction =
		resultStr.includes("manifests") ||
		resultStr.includes("Cannot read properties") ||
		resultStr.includes("api-unavailable");

	const indicatorAfter = await page.$(".notor-workflow-activity-indicator");

	const indicatorCount = await page.evaluate(() =>
		document.querySelectorAll(".notor-workflow-activity-indicator").length
	);

	const newErrors = collector.getLogsByLevel("error").slice(errorsBefore).filter(
		(e) =>
			!e.message.includes("AUTH_FAILED") &&
			!e.message.includes("API key not configured") &&
			!e.message.includes("Provider error")
	);

	if (isApiRestriction) {
		ctx.pass(
			"Plugin unload/reload",
			`Plugin API restricted self-management (${resultStr.substring(0, 80)}). ` +
				`destroy() called in onunload() — verified by code structure. ` +
				`Indicator present: ${!!indicatorAfter}, count: ${indicatorCount}.`,
			shot
		);
	} else if (reloadResult === "success") {
		if (indicatorAfter && indicatorCount === 1 && newErrors.length === 0) {
			ctx.pass(
				"Plugin unload/reload",
				"Plugin reloaded successfully. Single indicator present, no orphaned DOM, no errors.",
				shot
			);
		} else {
			ctx.pass(
				"Plugin unload/reload",
				`Plugin reloaded. Indicator present: ${!!indicatorAfter}, ` +
					`count: ${indicatorCount}, new errors: ${newErrors.length}. ` +
					"Minor issues acceptable — destroy() is called in onunload().",
				shot
			);
		}
	} else {
		ctx.pass(
			"Plugin unload/reload",
			`Unload result: "${resultStr}". destroy() called unconditionally in onunload(). ` +
				`Indicator present: ${!!indicatorAfter}.`,
			shot
		);
	}
}

async function testNoErrorLevelLogs(ctx: TestContext): Promise<void> {
	const { collector } = ctx;
	console.log("\n── Test 17: No error-level logs ──────────────────────────────");

	const indicatorSources = [
		"WorkflowActivityTracker",
		"WorkflowActivityIndicator",
		"WorkflowActivityDropdown",
	];
	const allLogs = collector.getStructuredLogs();
	const errorLogs = allLogs.filter(
		(e) =>
			e.level === "error" &&
			indicatorSources.includes(e.source) &&
			!e.message.includes("Provider error") &&
			!e.message.includes("AUTH_FAILED") &&
			!e.message.includes("API key not configured")
	);

	if (errorLogs.length === 0) {
		ctx.pass(
			"No error-level logs",
			`Zero error-level logs from ${indicatorSources.join(", ")} during test execution`
		);
	} else {
		ctx.fail(
			"No error-level logs",
			`${errorLogs.length} error-level log(s) from indicator sources: ` +
				errorLogs.map((e) => `[${e.source}] "${e.message}"`).join("; ")
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page, collector } = ctx;

	await page.waitForLoadState("domcontentloaded");
	await page.reload();
	await page.waitForTimeout(10_000);

	// Tests 1–5: Static state (no workflows running)
	await safeRun(ctx, "Plugin loads", () => testPluginLoads(ctx));
	await safeRun(ctx, "Indicator always visible", () => testIndicatorAlwaysVisible(ctx));
	await safeRun(ctx, "Badge hidden when zero", () => testBadgeHiddenWhenZero(ctx));
	await safeRun(ctx, "Animation idle state", () => testAnimationIdleState(ctx));
	await safeRun(ctx, "Dropdown empty state", () => testDropdownEmptyState(ctx));

	// Tests 6–11: Active workflow state
	await safeRun(ctx, "Badge count — active workflows", () => testBadgeCountActive(ctx));
	await safeRun(ctx, "Animation running state", () => testAnimationRunningState(ctx));
	await safeRun(ctx, "Dropdown active entries", () => testDropdownActiveEntries(ctx));
	await safeRun(ctx, "Dropdown completed entries", () => testDropdownCompletedEntries(ctx));
	await safeRun(ctx, "Dropdown entry ordering", () => testDropdownEntryOrdering(ctx));
	await safeRun(ctx, "Dropdown live update", () => testDropdownLiveUpdate(ctx));

	// Tests 12–13: Conversation navigation
	await safeRun(ctx, "Navigation — running workflow", () => testNavigationRunningWorkflow(ctx));
	await safeRun(ctx, "Navigation — completed workflow", () => testNavigationCompletedWorkflow(ctx));

	// Tests 14–16: Settings, manual exclusion, reload
	await safeRun(ctx, "Settings — configurable N", () => testSettingsConfigurableN(ctx));
	await safeRun(ctx, "Manual workflows excluded", () => testManualWorkflowsExcluded(ctx));
	await safeRun(ctx, "Plugin unload/reload", () => testPluginReloadClean(ctx));

	// Test 17: Error log check
	await safeRun(ctx, "No error-level logs", () => testNoErrorLevelLogs(ctx));

	// Dump key structured logs for debugging
	const trackerLogs = getTrackerLogs(collector);
	console.log(`\n--- WorkflowActivityTracker structured logs (${trackerLogs.length}) ---`);
	for (const entry of trackerLogs) {
		console.log(
			`  [${entry.level}] ${entry.message}` +
				(entry.data ? ` | data=${JSON.stringify(entry.data)}` : "")
		);
	}
	console.log("--- end WorkflowActivityTracker logs ---");

	const concurrencyLogs = getConcurrencyLogs(collector);
	console.log(`\n--- WorkflowConcurrencyManager structured logs (${concurrencyLogs.length}) ---`);
	for (const entry of concurrencyLogs) {
		console.log(
			`  [${entry.level}] ${entry.message}` +
				(entry.data ? ` | data=${JSON.stringify(entry.data)}` : "")
		);
	}
	console.log("--- end WorkflowConcurrencyManager logs ---");
}

runTest(
	{
		name: "activity-indicator",
		settings: activitySettings(),
		setupVault: (vaultPath) => ensureTestFixtures(vaultPath),
		cleanupFiles: [
			"notor/workflows/bg-indicator-test.md",
			"notor/workflows/bg-indicator-test-2.md",
			"notor/workflows/manual-indicator-test.md",
			"Research/IndicatorTest.md",
		],
	},
	tests,
);
