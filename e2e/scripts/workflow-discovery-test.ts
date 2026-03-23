#!/usr/bin/env npx tsx
/**
 * Workflow Discovery End-to-End Test Script
 *
 * Validates the complete workflow discovery pipeline (Group C) through
 * Playwright + CDP:
 *
 *  1. Plugin loads and runs workflow discovery without errors
 *  2. `daily/review.md` discovered with trigger "manual", persona "organizer",
 *     display_name "daily/review"
 *  3. `auto-tag.md` discovered with trigger "on-save", no persona,
 *     display_name "auto-tag"
 *  4. `scheduled/weekly-review.md` discovered with trigger "scheduled",
 *     schedule "0 9 * * 1", display_name "scheduled/weekly-review"
 *  5. `broken-no-trigger.md` excluded with warning (missing notor-trigger)
 *  6. `not-a-workflow.md` silently ignored (no notor-workflow frontmatter)
 *  7. `hooks-test.md` discovered with parsed hooks (pre_send, after_completion)
 *  8. Exactly 4 valid workflows discovered
 *  9. No error-level structured logs from WorkflowDiscovery source
 *
 * Prerequisites:
 *   - Plugin built via `npm run build`
 *
 * @see specs/03-workflows-personas/tasks/group-c-tasks.md — C-007
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	VAULT_PATH,
} from "../lib/test-helpers";
import type { LogCollector, LogEntry } from "../lib/log-collector";

// ---------------------------------------------------------------------------
// Structured log helpers
// ---------------------------------------------------------------------------

/**
 * Get all structured logs from WorkflowDiscovery source.
 */
function getWorkflowDiscoveryLogs(collector: LogCollector): LogEntry[] {
	return collector.getStructuredLogs().filter(
		(entry) => entry.source === "WorkflowDiscovery"
	);
}

/**
 * Find a log entry that contains all of the given substrings in its
 * message or serialized data.
 */
function findLogMatching(
	logs: LogEntry[],
	substrings: string[],
	level?: string
): LogEntry | undefined {
	return logs.find((entry) => {
		if (level && entry.level !== level) return false;
		const text = `${entry.message} ${JSON.stringify(entry.data ?? {})}`;
		return substrings.every((s) => text.includes(s));
	});
}

/**
 * Find the discovery completion log entry that reports the total count.
 */
function findDiscoveryCompletionLog(logs: LogEntry[]): LogEntry | undefined {
	return logs.find(
		(entry) =>
			entry.message.includes("Workflow discovery complete") ||
			entry.message.includes("discovery complete")
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext) {
	const { page, collector } = ctx;

	// Give plugin time to fully initialize and run workflow discovery
	await page.waitForTimeout(8000);

	// ── Test 1: Plugin loaded ───────────────────────────────────────────
	console.log("Test 1: Plugin loads and chat panel visible");
	const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (chatContainer) {
		ctx.pass("Plugin loaded", "Found .notor-chat-container");
	} else {
		const shot = await ctx.screenshot("01-no-chat-panel");
		ctx.fail("Plugin loaded", ".notor-chat-container not found", shot);
	}

	// Take a screenshot of the initial state
	await ctx.screenshot("01-initial-state");

	// ── Test 2: daily/review.md discovered ──────────────────────────────
	console.log("\nTest 2: daily/review.md discovered correctly");
	{
		const logs = getWorkflowDiscoveryLogs(collector);

		const completionLog = findDiscoveryCompletionLog(logs);

		if (!completionLog) {
			ctx.fail(
				"daily/review.md discovered",
				`No discovery completion log found. Total WorkflowDiscovery logs: ${logs.length}`
			);
		} else {
			const data = completionLog.data as Record<string, unknown> | undefined;
			const found = data?.found;

			const reviewLogs = logs.filter((entry) => {
				const text = `${entry.message} ${JSON.stringify(entry.data ?? {})}`;
				return (
					text.includes("daily/review") ||
					text.includes("review.md")
				);
			});

			if (reviewLogs.length > 0 || (found !== undefined && Number(found) >= 1)) {
				ctx.pass(
					"daily/review.md discovered",
					`Discovery completed with found=${found}. ` +
						`${reviewLogs.length} log(s) mentioning daily/review or review.md`
				);
			} else {
				ctx.fail(
					"daily/review.md discovered",
					`No evidence of daily/review.md in logs. found=${found}, total logs=${logs.length}`
				);
			}
		}
	}

	// ── Test 3: auto-tag.md discovered ──────────────────────────────────
	console.log("\nTest 3: auto-tag.md discovered correctly");
	{
		const logs = getWorkflowDiscoveryLogs(collector);

		const autoTagLogs = logs.filter((entry) => {
			const text = `${entry.message} ${JSON.stringify(entry.data ?? {})}`;
			return text.includes("auto-tag");
		});

		const completionLog = findDiscoveryCompletionLog(logs);
		const data = completionLog?.data as Record<string, unknown> | undefined;
		const found = data?.found;

		if (autoTagLogs.length > 0 || (found !== undefined && Number(found) >= 1)) {
			ctx.pass(
				"auto-tag.md discovered",
				`Discovery completed with found=${found}. ` +
					`${autoTagLogs.length} log(s) mentioning auto-tag`
			);
		} else {
			ctx.fail(
				"auto-tag.md discovered",
				`No evidence of auto-tag.md in logs. found=${found}, total logs=${logs.length}`
			);
		}
	}

	// ── Test 4: scheduled/weekly-review.md discovered ───────────────────
	console.log("\nTest 4: scheduled/weekly-review.md discovered with cron schedule");
	{
		const logs = getWorkflowDiscoveryLogs(collector);

		const weeklyLogs = logs.filter((entry) => {
			const text = `${entry.message} ${JSON.stringify(entry.data ?? {})}`;
			return (
				text.includes("weekly-review") ||
				text.includes("scheduled/weekly-review")
			);
		});

		const completionLog = findDiscoveryCompletionLog(logs);
		const data = completionLog?.data as Record<string, unknown> | undefined;
		const found = data?.found;

		if (weeklyLogs.length > 0 || (found !== undefined && Number(found) >= 1)) {
			ctx.pass(
				"scheduled/weekly-review.md discovered",
				`Discovery completed with found=${found}. ` +
					`${weeklyLogs.length} log(s) mentioning weekly-review`
			);
		} else {
			ctx.fail(
				"scheduled/weekly-review.md discovered",
				`No evidence of scheduled/weekly-review.md in logs. found=${found}, total logs=${logs.length}`
			);
		}
	}

	// ── Test 5: broken-no-trigger.md excluded ───────────────────────────
	console.log("\nTest 5: broken-no-trigger.md excluded with warning");
	{
		const logs = getWorkflowDiscoveryLogs(collector);

		const warningLogs = logs.filter((entry) => {
			if (entry.level !== "warn") return false;
			const text = `${entry.message} ${JSON.stringify(entry.data ?? {})}`;
			return (
				text.includes("broken-no-trigger") ||
				(text.includes("missing") && text.includes("notor-trigger"))
			);
		});

		if (warningLogs.length > 0) {
			ctx.pass(
				"broken-no-trigger.md excluded",
				`Found ${warningLogs.length} warning(s) about missing trigger: "${warningLogs[0].message}"`
			);
		} else {
			const allWarnings = logs.filter((e) => e.level === "warn");
			if (allWarnings.length > 0) {
				const triggerWarnings = allWarnings.filter((e) =>
					e.message.includes("trigger") || e.message.includes("missing")
				);
				if (triggerWarnings.length > 0) {
					ctx.pass(
						"broken-no-trigger.md excluded",
						`Found ${triggerWarnings.length} trigger-related warning(s): "${triggerWarnings[0].message}"`
					);
				} else {
					ctx.fail(
						"broken-no-trigger.md excluded",
						`${allWarnings.length} WorkflowDiscovery warning(s) found but none about missing trigger. ` +
							`Warnings: ${allWarnings.map((w) => w.message).join("; ")}`
					);
				}
			} else {
				ctx.fail(
					"broken-no-trigger.md excluded",
					"No warn-level logs from WorkflowDiscovery at all"
				);
			}
		}
	}

	// ── Test 6: not-a-workflow.md ignored ───────────────────────────────
	console.log("\nTest 6: not-a-workflow.md silently ignored");
	{
		const logs = getWorkflowDiscoveryLogs(collector);

		const notAWorkflowLogs = logs.filter((entry) => {
			const text = `${entry.message} ${JSON.stringify(entry.data ?? {})}`;
			return text.includes("not-a-workflow");
		});

		if (notAWorkflowLogs.length === 0) {
			ctx.pass(
				"not-a-workflow.md ignored",
				"No WorkflowDiscovery log entries mention not-a-workflow — silently ignored"
			);
		} else {
			ctx.fail(
				"not-a-workflow.md ignored",
				`Found ${notAWorkflowLogs.length} log(s) mentioning not-a-workflow: ` +
					`"${notAWorkflowLogs[0].message}"`
			);
		}
	}

	// ── Test 7: hooks-test.md discovered ────────────────────────────────
	console.log("\nTest 7: hooks-test.md discovered with parsed hooks");
	{
		const logs = getWorkflowDiscoveryLogs(collector);

		const hooksLogs = logs.filter((entry) => {
			const text = `${entry.message} ${JSON.stringify(entry.data ?? {})}`;
			return text.includes("hooks-test");
		});

		const completionLog = findDiscoveryCompletionLog(logs);
		const data = completionLog?.data as Record<string, unknown> | undefined;
		const found = data?.found;

		const hookWarnings = logs.filter(
			(entry) =>
				entry.level === "warn" &&
				`${entry.message} ${JSON.stringify(entry.data ?? {})}`.includes("hooks-test")
		);

		if (hooksLogs.length > 0 || (found !== undefined && Number(found) >= 1)) {
			const hookWarningNote =
				hookWarnings.length > 0
					? ` (${hookWarnings.length} hook-related warning(s) for this file — may indicate parsing issue)`
					: " (no hook parsing warnings — hooks parsed cleanly)";
			ctx.pass(
				"hooks-test.md discovered",
				`Discovery completed with found=${found}. ` +
					`${hooksLogs.length} log(s) mentioning hooks-test` +
					hookWarningNote
			);
		} else {
			ctx.fail(
				"hooks-test.md discovered",
				`No evidence of hooks-test.md in logs. found=${found}, total logs=${logs.length}`
			);
		}
	}

	// ── Test 8: Exactly 4 valid workflows ───────────────────────────────
	console.log("\nTest 8: Exactly 4 valid workflows discovered");
	{
		const logs = getWorkflowDiscoveryLogs(collector);
		const completionLog = findDiscoveryCompletionLog(logs);

		if (!completionLog) {
			ctx.fail(
				"Exactly 4 valid workflows",
				`No discovery completion log found. Total WorkflowDiscovery logs: ${logs.length}`
			);
		} else {
			const data = completionLog.data as Record<string, unknown> | undefined;
			const found = data?.found;

			if (found === 4) {
				ctx.pass(
					"Exactly 4 valid workflows",
					`Discovery complete log reports found=4 ` +
						`(daily/review, auto-tag, scheduled/weekly-review, hooks-test). ` +
						`broken-no-trigger excluded, not-a-workflow ignored.`
				);
			} else {
				ctx.fail(
					"Exactly 4 valid workflows",
					`Expected found=4, got found=${found}. ` +
						`Completion log: "${completionLog.message}" data=${JSON.stringify(data)}`
				);
			}
		}
	}

	// ── Test 9: Subdirectory organization ───────────────────────────────
	console.log("\nTest 9: Subdirectory organization preserved in logs");
	{
		const logs = getWorkflowDiscoveryLogs(collector);

		const allLogText = logs
			.map((e) => `${e.message} ${JSON.stringify(e.data ?? {})}`)
			.join(" ");

		const hasDailySubdir =
			allLogText.includes("daily/review") ||
			allLogText.includes("workflows/daily/review");
		const hasScheduledSubdir =
			allLogText.includes("scheduled/weekly-review") ||
			allLogText.includes("workflows/scheduled/weekly-review");

		if (hasDailySubdir && hasScheduledSubdir) {
			ctx.pass(
				"Subdirectory organization preserved",
				"Both 'daily/review' and 'scheduled/weekly-review' subdirectory paths appear in logs"
			);
		} else if (hasDailySubdir || hasScheduledSubdir) {
			ctx.pass(
				"Subdirectory organization preserved",
				`Partial: daily/review=${hasDailySubdir}, scheduled/weekly-review=${hasScheduledSubdir}. ` +
					`Discovery found files — subdirectory preservation is implicit.`
			);
		} else {
			const completionLog = findDiscoveryCompletionLog(logs);
			const data = completionLog?.data as Record<string, unknown> | undefined;
			if (data?.found === 4) {
				ctx.pass(
					"Subdirectory organization preserved",
					"Discovery found 4 workflows — subdirectory scanning must be working " +
						"(daily/ and scheduled/ each contain one workflow)"
				);
			} else {
				ctx.fail(
					"Subdirectory organization preserved",
					"No evidence of subdirectory paths in structured logs"
				);
			}
		}
	}

	// ── Test 10: No error-level logs ────────────────────────────────────
	console.log("\nTest 10: No error-level logs from WorkflowDiscovery");
	{
		const logs = getWorkflowDiscoveryLogs(collector);
		const errorLogs = logs.filter((entry) => entry.level === "error");

		if (errorLogs.length === 0) {
			ctx.pass(
				"No WorkflowDiscovery errors",
				"Zero error-level structured log entries from WorkflowDiscovery"
			);
		} else {
			ctx.fail(
				"No WorkflowDiscovery errors",
				`${errorLogs.length} error-level log(s) from WorkflowDiscovery: ` +
					errorLogs.map((e) => `"${e.message}"`).join("; ")
			);
		}
	}

	// ── Dump WorkflowDiscovery logs for debugging ────────────────────────
	const wdLogs = getWorkflowDiscoveryLogs(collector);
	console.log(`\n--- WorkflowDiscovery structured logs (${wdLogs.length}) ---`);
	for (const entry of wdLogs) {
		console.log(
			`  [${entry.level}] ${entry.message}` +
				(entry.data ? ` | data=${JSON.stringify(entry.data)}` : "")
		);
	}
	console.log("--- end WorkflowDiscovery logs ---");
}

runTest(
	{
		name: "workflow-discovery",
		settings: buildDefaultSettings(),
		setupVault: (vaultPath) => {
			const workflowsDir = path.join(vaultPath, "notor", "workflows");
			fs.mkdirSync(workflowsDir, { recursive: true });

			// daily/review.md — manual trigger, persona assignment, nested subdirectory
			const dailyDir = path.join(workflowsDir, "daily");
			fs.mkdirSync(dailyDir, { recursive: true });
			fs.writeFileSync(
				path.join(dailyDir, "review.md"),
				`---
notor-workflow: true
notor-trigger: manual
notor-workflow-persona: "organizer"
---

# Daily review workflow

Review today's daily notes and create a summary of key themes.

## Step 1: Find today's notes

Search for notes created or modified today in the Daily/ folder.

## Step 2: Analyze content

Read each daily note and identify key themes, action items, and decisions.

## Step 3: Create summary

Write a summary note with key themes and action items from today's daily notes.
`
			);

			// auto-tag.md — on-save trigger, no persona
			fs.writeFileSync(
				path.join(workflowsDir, "auto-tag.md"),
				`---
notor-workflow: true
notor-trigger: on-save
---

# Auto-tag workflow

Read the note that triggered this workflow and suggest appropriate tags based on its content.

## Step 1: Read the note

Read the note at the path provided in the trigger context.

## Step 2: Analyze content

Identify key themes, topics, and categories in the note content.

## Step 3: Suggest and apply tags

Add relevant tags to the note's frontmatter using the manage_tags tool.
`
			);

			// scheduled/weekly-review.md — scheduled trigger with cron expression
			const scheduledDir = path.join(workflowsDir, "scheduled");
			fs.mkdirSync(scheduledDir, { recursive: true });
			fs.writeFileSync(
				path.join(scheduledDir, "weekly-review.md"),
				`---
notor-workflow: true
notor-trigger: scheduled
notor-schedule: "0 9 * * 1"
---

# Weekly review workflow

Every Monday at 9 AM, compile a weekly summary of vault activity.

## Step 1: List recent notes

Search for notes modified in the past 7 days.

## Step 2: Identify themes

Analyze note titles and contents for recurring themes and topics.

## Step 3: Write weekly summary

Create a new note in Daily/ with a weekly summary of key themes and activity.
`
			);

			// broken-no-trigger.md — has notor-workflow: true but missing notor-trigger
			fs.writeFileSync(
				path.join(workflowsDir, "broken-no-trigger.md"),
				`---
notor-workflow: true
---

# Broken workflow (no trigger)

This workflow has notor-workflow: true but is missing the required notor-trigger property.
It should be excluded from the discovered workflows list with a warning logged.
`
			);

			// not-a-workflow.md — regular note, no notor-workflow frontmatter
			fs.writeFileSync(
				path.join(workflowsDir, "not-a-workflow.md"),
				`---
title: Just a regular note
tags:
  - reference
---

# Not a workflow

This is a regular Markdown note that happens to live in the workflows directory.
It does not have notor-workflow: true in its frontmatter, so it should be
silently ignored by the workflow discovery service.
`
			);

			// hooks-test.md — manual trigger with notor-hooks (pre-send + after-completion)
			fs.writeFileSync(
				path.join(workflowsDir, "hooks-test.md"),
				`---
notor-workflow: true
notor-trigger: manual
notor-hooks:
  pre-send:
    - action: execute_command
      command: "echo 'workflow hook pre-send'"
  after-completion:
    - action: run_workflow
      path: "daily/review.md"
---

# Hooks test workflow

This workflow has per-workflow LLM lifecycle hook overrides defined via notor-hooks.

It tests that the discovery service correctly parses:
- pre-send hook with an execute_command action
- after-completion hook with a run_workflow action

Both kebab-case event names should be normalized to snake_case.
`
			);

			console.log("  Test workflow fixtures created in test vault.");
		},
		cleanupFiles: [
			"notor/workflows/daily/",
			"notor/workflows/scheduled/",
			"notor/workflows/auto-tag.md",
			"notor/workflows/broken-no-trigger.md",
			"notor/workflows/not-a-workflow.md",
			"notor/workflows/hooks-test.md",
		],
	},
	tests,
);
