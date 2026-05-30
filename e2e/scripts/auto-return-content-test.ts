#!/usr/bin/env npx tsx
/**
 * Auto-Return Note Content on Edit Failure E2E Test (TEST-007)
 *
 * Validates the feature from commit 86d4047: when `replace_in_note` or
 * `write_note` fails because of a match failure (search text not found) or
 * stale content (note changed since last read), the tool auto-returns the
 * CURRENT note content in the error response so the model can retry without a
 * separate `read_note` — AND the chat UI surfaces that returned content in the
 * failed tool-call card (so the user can see what the model received).
 *
 * Strategy: fully deterministic, NO live LLM. Tools are invoked directly via
 * the plugin's ToolRegistry from page.evaluate(), and a synthetic failed
 * tool_result card is rendered via the real NotorChatView.renderToolResult()
 * to verify the UI rendering fix in isolation.
 *
 * Scenarios:
 *   1. replace_in_note match-failure returns current content (tool layer)
 *   2. replace_in_note stale content returns current content (tool layer)
 *   3. write_note stale content returns current content (tool layer)
 *   4. Chat UI renders returned content on a FAILED tool card (the fix)
 *   5. Regression guards: success card still renders content; an empty-result
 *      failure renders only the error (no spurious content panel)
 *
 * @see src/extensions/builtin-tool-scaffolds/replace-in-note.ts — match/stale auto-return
 * @see src/extensions/builtin-tool-scaffolds/write-note.ts — stale auto-return
 * @see src/ui/message-renderer.ts — renderToolResult (UI rendering of returned content)
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	waitForSelector,
	buildDefaultSettings,
	VAULT_PATH,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants (test-specific only)
// ---------------------------------------------------------------------------

/** Vault-relative path of the fixture note exercised by the tool-layer tests. */
const NOTE_REL = "Auto-Return-Test.md";

/** Unique markers embedded in the fixture body so we can prove the *current*
 *  on-disk content (not the model's stale copy) is what gets returned. */
const BODY_MARKER = "ALPHA-7-CURRENT-BODY";
const STABLE_MARKER = "BETA-9-STABLE";

/** Marker used only inside a synthetic tool_result's `result` field (scenario 4).
 *  Deliberately absent from the `error` field so finding it in the DOM proves the
 *  returned content rendered — not the error headline. */
const UI_CONTENT_MARKER = "OMEGA-5-RETURNED-CONTENT";
/** Marker for the success-card regression guard (scenario 5a). */
const UI_SUCCESS_MARKER = "PSI-2-SUCCESS-CONTENT";

const FIXTURE_CONTENT =
	`---\ntitle: Auto Return Test\nstatus: original\n---\n\n` +
	`# Auto Return Test Note\n\n` +
	`## Target Section\n\n` +
	`Original body marker ${BODY_MARKER} — this is the line an edit would target.\n\n` +
	`## Stable Section\n\n` +
	`Stable content ${STABLE_MARKER} that no edit touches.\n`;

// ---------------------------------------------------------------------------
// Local helpers (test-specific only — NOT duplicates of shared helpers)
// ---------------------------------------------------------------------------

/** Serializable subset of a ToolResult returned from the browser context. */
interface EvaluatedToolResult {
	__err?: string;
	success?: boolean;
	error?: string | null;
	/** Always a string here (objects are JSON-stringified in the browser). */
	result?: string;
	tool_name?: string;
}

/**
 * Execute a built-in tool directly via the plugin's ToolRegistry from the page
 * context, bypassing the LLM. Optionally seeds the stale-content tracker so the
 * stale auto-return path fires deterministically.
 *
 * `seed: "none"`   → clear the tracker (so the match-failure path is exercised).
 * `seed: "stale"`  → clear, then recordRead() the canonical path with a copy of
 *                    the current disk content whose BODY differs, forcing stale.
 */
async function execToolInPage(
	page: TestContext["page"],
	opts: {
		toolName: string;
		params: Record<string, unknown>;
		notePath: string;
		seed: "none" | "stale";
	},
): Promise<EvaluatedToolResult> {
	return page.evaluate(async (args): Promise<EvaluatedToolResult> => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { __err: "notor plugin not found on window.app" };

		const registry = plugin.getToolRegistry?.();
		if (!registry) return { __err: "getToolRegistry() returned nothing" };

		const tool = registry.get(args.toolName);
		if (!tool) return { __err: `tool not found in registry: ${args.toolName}` };

		const tracker = plugin.getStaleTracker?.();
		if (!tracker) return { __err: "getStaleTracker() returned nothing" };
		tracker.clear();

		// Resolve canonical file path + current disk content for seeding.
		const file = (window as any).app.vault.getAbstractFileByPath(args.notePath);
		if (!file) return { __err: `fixture file not found in vault: ${args.notePath}` };
		const diskContent: string = await (window as any).app.vault.read(file);

		if (args.seed === "stale") {
			// Record a divergent BODY so the stale check (full-content + body-hash)
			// fires. recordRead uses the canonical file.path the tool will look up.
			const stale = diskContent.replace(
				"ALPHA-7-CURRENT-BODY",
				"GAMMA-3-OLD-STALE-BODY",
			);
			tracker.recordRead(file.path, stale);
		}

		const toolResult = await tool.execute(args.params, { silentNoteOpener: true });
		return {
			success: toolResult.success,
			error: toolResult.error ?? null,
			result:
				typeof toolResult.result === "string"
					? toolResult.result
					: JSON.stringify(toolResult.result),
			tool_name: toolResult.tool_name,
		};
	}, opts);
}

/** Per-card inspection of a rendered tool_result, keyed by message id. */
interface CardInfo {
	found: boolean;
	summaryText: string;
	hasFull: boolean;
	fullText: string;
	isError: boolean;
	isSuccess: boolean;
}

/**
 * Render a synthetic tool_result message through the REAL NotorChatView and
 * return the rendered card's structure. This exercises the exact production
 * render path (MessageRenderer.renderToolResult) without involving the LLM.
 */
async function renderAndInspect(
	page: TestContext["page"],
	opts: {
		id: string;
		toolName: string;
		success: boolean;
		result: string;
		error: string | null;
	},
): Promise<CardInfo & { __err?: string }> {
	return page.evaluate((args): CardInfo & { __err?: string } => {
		const leaves =
			(window as any).app?.workspace?.getLeavesOfType("notor-chat-view") ?? [];
		const view = leaves.find((l: any) => typeof l?.view?.renderToolResult === "function")?.view;
		if (!view) {
			return {
				__err: "no notor-chat-view with renderToolResult()",
				found: false, summaryText: "", hasFull: false, fullText: "", isError: false, isSuccess: false,
			};
		}

		const message = {
			id: args.id,
			conversation_id: "e2e-synthetic",
			role: "tool_result",
			content: "",
			timestamp: new Date().toISOString(),
			tool_call: null,
			tool_result: {
				tool_name: args.toolName,
				success: args.success,
				result: args.result,
				error: args.error,
				duration_ms: 7,
			},
		};

		view.renderToolResult(message);

		const card = document.querySelector(`[data-message-id="${args.id}"]`);
		if (!card) {
			return {
				__err: "rendered card not found by data-message-id",
				found: false, summaryText: "", hasFull: false, fullText: "", isError: false, isSuccess: false,
			};
		}
		const full = card.querySelector(".notor-tool-result-full");
		const summary = card.querySelector(".notor-tool-result-summary");
		return {
			found: true,
			summaryText: summary?.textContent ?? "",
			hasFull: !!full,
			fullText: full?.textContent ?? "",
			isError: !!card.querySelector(".notor-tool-result-error"),
			isSuccess: !!card.querySelector(".notor-tool-result-success"),
		};
	}, opts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Scenario 1 — replace_in_note match failure auto-returns current content.
 * No prior read needed: the no-match path is independent of the stale tracker.
 */
async function testMatchFailureReturnsContent(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: replace_in_note match-failure returns current content");
	const { page } = ctx;
	const diskPath = path.join(VAULT_PATH, NOTE_REL);
	const before = fs.readFileSync(diskPath, "utf8");

	const res = await execToolInPage(page, {
		toolName: "replace_in_note",
		notePath: NOTE_REL,
		seed: "none",
		params: {
			path: NOTE_REL,
			changes: [{ search: "NONEXISTENT_SEARCH_ZZZ_QQQ", replace: "whatever" }],
		},
	});

	if (res.__err) {
		ctx.fail("match-failure — tool invoked", `Browser error: ${res.__err}`);
		return;
	}

	if (res.success === false) {
		ctx.pass("match-failure — tool reports failure", `success=false, error="${(res.error ?? "").slice(0, 80)}"`);
	} else {
		ctx.fail("match-failure — tool reports failure", `Expected success=false, got success=${res.success}`);
	}

	const errStr = res.error ?? "";
	if (errStr.includes("did not match")) {
		ctx.pass("match-failure — error explains no-match", `error includes "did not match"`);
	} else {
		ctx.fail("match-failure — error explains no-match", `error was: "${errStr.slice(0, 120)}"`);
	}

	const result = res.result ?? "";
	const hasHeader = result.includes("Current note content:");
	const hasCurrentBody = result.includes(BODY_MARKER) && result.includes(STABLE_MARKER);
	if (hasHeader && hasCurrentBody) {
		ctx.pass("match-failure — result carries current note content", `result includes "Current note content:" and current body markers (${result.length} chars)`);
	} else {
		ctx.fail("match-failure — result carries current note content", `hasHeader=${hasHeader}, hasCurrentBody=${hasCurrentBody}. result head: "${result.slice(0, 160)}"`);
	}

	const after = fs.readFileSync(diskPath, "utf8");
	if (after === before) {
		ctx.pass("match-failure — file unchanged", "No changes were applied to disk");
	} else {
		ctx.fail("match-failure — file unchanged", "File content changed despite a no-match failure");
	}
}

/**
 * Scenario 2 — replace_in_note stale content auto-returns current content.
 * Seed the tracker with a divergent body; the stale check fires before any
 * search matching, so the current on-disk content is returned.
 */
async function testReplaceStaleReturnsContent(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: replace_in_note stale content returns current content");
	const { page } = ctx;
	const diskPath = path.join(VAULT_PATH, NOTE_REL);
	const before = fs.readFileSync(diskPath, "utf8");

	const res = await execToolInPage(page, {
		toolName: "replace_in_note",
		notePath: NOTE_REL,
		seed: "stale",
		params: {
			// A search that WOULD match the current disk content — proving it was
			// the stale check (which runs first), not a no-match, that blocked it.
			path: NOTE_REL,
			changes: [{ search: `Original body marker ${BODY_MARKER}`, replace: "edited" }],
		},
	});

	if (res.__err) {
		ctx.fail("replace stale — tool invoked", `Browser error: ${res.__err}`);
		return;
	}

	if (res.success === false) {
		ctx.pass("replace stale — tool reports failure", `success=false`);
	} else {
		ctx.fail("replace stale — tool reports failure", `Expected success=false, got success=${res.success}`);
	}

	const errStr = res.error ?? "";
	if (errStr.toLowerCase().includes("changed since last read")) {
		ctx.pass("replace stale — error explains staleness", `error mentions "changed since last read"`);
	} else {
		ctx.fail("replace stale — error explains staleness", `error was: "${errStr.slice(0, 120)}"`);
	}

	const result = res.result ?? "";
	const hasStaleHeader = result.includes("Stale content detected");
	const hasCurrentBody = result.includes(BODY_MARKER);
	if (hasStaleHeader && hasCurrentBody) {
		ctx.pass("replace stale — result carries current note content", `result includes "Stale content detected" and current body marker`);
	} else {
		ctx.fail("replace stale — result carries current note content", `hasStaleHeader=${hasStaleHeader}, hasCurrentBody=${hasCurrentBody}. result head: "${result.slice(0, 160)}"`);
	}

	const after = fs.readFileSync(diskPath, "utf8");
	if (after === before) {
		ctx.pass("replace stale — file unchanged", "Stale write was blocked; disk intact");
	} else {
		ctx.fail("replace stale — file unchanged", "File changed despite stale detection");
	}
}

/**
 * Scenario 3 — write_note stale content auto-returns current content.
 */
async function testWriteStaleReturnsContent(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: write_note stale content returns current content");
	const { page } = ctx;
	const diskPath = path.join(VAULT_PATH, NOTE_REL);
	const before = fs.readFileSync(diskPath, "utf8");

	const res = await execToolInPage(page, {
		toolName: "write_note",
		notePath: NOTE_REL,
		seed: "stale",
		params: {
			path: NOTE_REL,
			content: "Completely new content DELTA-1 that should NOT be written while stale.",
		},
	});

	if (res.__err) {
		ctx.fail("write stale — tool invoked", `Browser error: ${res.__err}`);
		return;
	}

	if (res.success === false) {
		ctx.pass("write stale — tool reports failure", `success=false`);
	} else {
		ctx.fail("write stale — tool reports failure", `Expected success=false, got success=${res.success}`);
	}

	const result = res.result ?? "";
	const hasStaleHeader = result.includes("Stale content detected");
	const hasCurrentBody = result.includes(BODY_MARKER);
	if (hasStaleHeader && hasCurrentBody) {
		ctx.pass("write stale — result carries current note content", `result includes stale header + current body marker`);
	} else {
		ctx.fail("write stale — result carries current note content", `hasStaleHeader=${hasStaleHeader}, hasCurrentBody=${hasCurrentBody}. result head: "${result.slice(0, 160)}"`);
	}

	const after = fs.readFileSync(diskPath, "utf8");
	if (after === before) {
		ctx.pass("write stale — file unchanged", "Stale overwrite was blocked; disk intact");
	} else {
		ctx.fail("write stale — file unchanged", "File changed despite stale detection");
	}
}

/**
 * Scenario 4 — THE fix verification. A FAILED tool_result whose `result` field
 * carries the auto-returned note content must render that content in the card,
 * not just the short `✗ error` headline.
 */
async function testUiRendersFailedResultContent(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: chat UI renders returned content on a FAILED tool card");
	const { page } = ctx;

	const errorText = `Search block 1 did not match any text in ${NOTE_REL}. No changes were applied.`;
	const resultText =
		`Error: ${errorText}\n\n---\nCurrent note content:\n\n` +
		`# Auto Return Test Note\n\n## Target Section\n\n` +
		`This is the returned note body containing ${UI_CONTENT_MARKER} and more text ` +
		`to comfortably exceed the collapsible threshold so the full-result panel renders.`;

	const info = await renderAndInspect(page, {
		id: "e2e-failed-with-content",
		toolName: "replace_in_note",
		success: false,
		result: resultText,
		error: errorText,
	});

	const shot = await ctx.screenshot("04-failed-card-with-content");

	if (info.__err || !info.found) {
		ctx.fail("ui failed-card — card rendered", `Could not render/find card: ${info.__err ?? "not found"}`, shot);
		return;
	}

	if (info.isError) {
		ctx.pass("ui failed-card — marked as error", "Card has .notor-tool-result-error");
	} else {
		ctx.fail("ui failed-card — marked as error", "Failed result not marked with .notor-tool-result-error", shot);
	}

	// The crux: the returned note content must be present in the rendered card.
	if (info.hasFull && info.fullText.includes(UI_CONTENT_MARKER)) {
		ctx.pass("ui failed-card — returned content is shown", `.notor-tool-result-full contains the returned-content marker`, shot);
	} else {
		ctx.fail("ui failed-card — returned content is shown", `hasFull=${info.hasFull}; marker present=${info.fullText.includes(UI_CONTENT_MARKER)}. This is the bug: failed tool cards drop tool_result.result.`, shot);
	}
}

/**
 * Scenario 5 — regression guards.
 *   5a: a successful result with long content still renders the content panel.
 *   5b: a failed result with an EMPTY `result` shows only the error (no panel),
 *       so ordinary errors stay clean and uncluttered.
 */
async function testRegressionGuards(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: regression guards (success content + empty-result error)");
	const { page } = ctx;

	// 5a — success card with long result content
	const successResult =
		`Read note OK. Body follows with marker ${UI_SUCCESS_MARKER} and enough additional ` +
		`text to exceed the 100-character collapsible threshold for the full-result panel.`;
	const okInfo = await renderAndInspect(page, {
		id: "e2e-success-with-content",
		toolName: "read_note",
		success: true,
		result: successResult,
		error: null,
	});

	if (okInfo.__err || !okInfo.found) {
		ctx.fail("ui success-card — card rendered", `Could not render/find card: ${okInfo.__err ?? "not found"}`);
	} else if (okInfo.isSuccess && okInfo.hasFull && okInfo.fullText.includes(UI_SUCCESS_MARKER)) {
		ctx.pass("ui success-card — content still rendered", "Success card retains its .notor-tool-result-full content panel");
	} else {
		ctx.fail("ui success-card — content still rendered", `isSuccess=${okInfo.isSuccess}, hasFull=${okInfo.hasFull}, markerPresent=${okInfo.fullText.includes(UI_SUCCESS_MARKER)}`);
	}

	// 5b — failed card with empty result: only the error shows, no content panel
	const emptyErrInfo = await renderAndInspect(page, {
		id: "e2e-failed-empty-result",
		toolName: "replace_in_note",
		success: false,
		result: "",
		error: "Missing required parameter: path. This plain error has no returned content.",
	});

	const shot = await ctx.screenshot("05-regression-cards");

	if (emptyErrInfo.__err || !emptyErrInfo.found) {
		ctx.fail("ui empty-error-card — card rendered", `Could not render/find card: ${emptyErrInfo.__err ?? "not found"}`, shot);
	} else if (emptyErrInfo.isError && !emptyErrInfo.hasFull) {
		ctx.pass("ui empty-error-card — no spurious content panel", "Plain error renders only the ✗ summary, no .notor-tool-result-full", shot);
	} else {
		ctx.fail("ui empty-error-card — no spurious content panel", `isError=${emptyErrInfo.isError}, hasFull=${emptyErrInfo.hasFull} (expected error w/ no full panel)`, shot);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // Wait for plugin init

	// Verify chat panel + that built-in tools are registered (direct invocation needs them).
	const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chatContainer) {
		const shot = await ctx.screenshot("00-no-chat-panel");
		ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
		throw new Error("Chat panel not visible — cannot run tests");
	}

	const toolsReady = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const registry = plugin?.getToolRegistry?.();
		return {
			hasPlugin: !!plugin,
			hasRegistry: !!registry,
			hasReplace: !!registry?.get?.("replace_in_note"),
			hasWrite: !!registry?.get?.("write_note"),
		};
	});

	if (toolsReady.hasPlugin && toolsReady.hasRegistry && toolsReady.hasReplace && toolsReady.hasWrite) {
		ctx.pass("setup — plugin & built-in tools ready", "replace_in_note and write_note found in registry");
	} else {
		ctx.fail("setup — plugin & built-in tools ready", `state: ${JSON.stringify(toolsReady)}`);
		throw new Error("Built-in tools not registered — cannot run tool-layer tests");
	}

	// Tool-layer scenarios (correct before AND after the UI fix)
	await testMatchFailureReturnsContent(ctx);
	await testReplaceStaleReturnsContent(ctx);
	await testWriteStaleReturnsContent(ctx);

	// UI rendering scenarios (scenario 4 fails before the fix, passes after)
	await testUiRendersFailedResultContent(ctx);
	await testRegressionGuards(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	// Direct tool.execute() bypasses approval, but enable these for parity with
	// how the feature runs in practice.
	auto_approve: {
		read_note: true,
		write_note: true,
		replace_in_note: true,
	},
});

runTest(
	{
		name: "auto-return-content",
		settings,
		setupVault: (vaultPath: string) => {
			const notePath = path.join(vaultPath, NOTE_REL);
			fs.mkdirSync(path.dirname(notePath), { recursive: true });
			fs.writeFileSync(notePath, FIXTURE_CONTENT, "utf8");
			console.log(`    Created: ${NOTE_REL}`);
		},
		cleanupFiles: [NOTE_REL],
	},
	tests,
);
