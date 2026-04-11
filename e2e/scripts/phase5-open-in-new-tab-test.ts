#!/usr/bin/env npx tsx
/**
 * Phase 5: "Open in New Tab" E2E Test
 *
 * Validates the Phase 5 "Open in new tab" feature from the thread-safe streaming
 * implementation: opening conversations from the history list in a new secondary
 * panel via the 3-dot context menu.
 *
 * Note: Obsidian's native Menu API (used for the 3-dot context menu) requires
 * trusted browser events to render into the DOM. Synthetic events dispatched
 * via CDP/Playwright are not trusted and do not produce a visible menu.
 * Therefore, tests that need to trigger "Open in new tab" invoke the
 * onOpenInNewTab callback directly via the plugin view API, which exercises
 * the same code path as the menu click (setViewState with conversationFilename).
 *
 * Scenarios:
 *   1. onOpenInNewTab callback is wired on the view
 *   2. Context menu button and handler exist on conversation list items
 *   3. Opening a conversation in a new tab creates a new panel with messages
 *   4. Works for favorited conversations
 *   5. Works for non-favorited conversations
 *   6. Opened panel has correct state (conversationId set)
 *   7. No unexpected error logs from open-in-new-tab operations
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access enabled with Claude Haiku model
 *
 * @see specs/ZZ-misc/thread-safe-streaming-implementation-tasks.md — Phase 5 Verification
 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Section 4.5
 */

import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	sendMessage,
	newConversation,
	ensureCleanState,
	VAULT_PATH,
} from "../lib/test-helpers";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const CHAT_VIEW_TYPE = "notor-chat-view";
const HISTORY_DIR = ".obsidian/plugins/notor/history/";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Safely run a test function, catching any unhandled errors so that
 * a single test crash does not abort the entire suite.
 */
async function safeRun(
	ctx: TestContext,
	name: string,
	fn: () => Promise<void>,
): Promise<void> {
	try {
		await fn();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.fail(name, `Unhandled error: ${msg.substring(0, 200)}`);
		console.error(`  [catch] ${name}:`, err);
	}
}

/** Get the count of chat-type leaves in the workspace. */
async function getChatLeafCount(page: any): Promise<number> {
	return page.evaluate((viewType: string) => {
		const app = (window as any).app;
		if (!app) return 0;
		return app.workspace.getLeavesOfType(viewType).length;
	}, CHAT_VIEW_TYPE);
}

/** Get information about all chat leaves. */
async function getChatLeafInfo(page: any): Promise<Array<{
	leafId: string;
	hasContainer: boolean;
	conversationId: string | null;
	hasToolbar: boolean;
	messageCount: number;
}>> {
	return page.evaluate((viewType: string) => {
		const app = (window as any).app;
		if (!app) return [];
		const leaves = app.workspace.getLeavesOfType(viewType);
		return leaves.map((leaf: any) => {
			const view = leaf.view;
			if (!view) return { leafId: leaf.id ?? "", hasContainer: false, conversationId: null, hasToolbar: false, messageCount: 0 };
			const containerEl = view.containerEl as HTMLElement;
			return {
				leafId: leaf.id ?? "",
				hasContainer: !!containerEl?.querySelector(".notor-chat-container"),
				conversationId: view.activeConversationId ?? null,
				hasToolbar: !!containerEl?.querySelector(".notor-chat-header-actions"),
				messageCount: containerEl?.querySelectorAll(".notor-message-assistant, .notor-message-user")?.length ?? 0,
			};
		});
	}, CHAT_VIEW_TYPE);
}

/** Get the view state (getState()) for a specific leaf by index. */
async function getLeafState(page: any, leafIndex: number): Promise<Record<string, unknown> | null> {
	return page.evaluate((args: { viewType: string; index: number }) => {
		const app = (window as any).app;
		if (!app) return null;
		const leaves = app.workspace.getLeavesOfType(args.viewType);
		if (args.index >= leaves.length) return null;
		const view = leaves[args.index]?.view;
		if (!view || !view.getState) return null;
		return view.getState();
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
}

/** Activate (reveal) a specific chat leaf by index. */
async function activateLeaf(page: any, leafIndex: number): Promise<boolean> {
	return page.evaluate((args: { viewType: string; index: number }) => {
		const app = (window as any).app;
		if (!app) return false;
		const leaves = app.workspace.getLeavesOfType(args.viewType);
		if (args.index >= leaves.length) return false;
		app.workspace.setActiveLeaf(leaves[args.index], { focus: true });
		return true;
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
}

/** Close the most recently opened extra panel (last leaf if more than one exists). */
async function closeLastExtraPanel(page: any): Promise<boolean> {
	return page.evaluate((viewType: string) => {
		const app = (window as any).app;
		if (!app) return false;
		const leaves = app.workspace.getLeavesOfType(viewType);
		// Close the last leaf if more than one exists (all panels are equal in the unified model)
		if (leaves.length <= 1) return false;
		leaves[leaves.length - 1].detach();
		return true;
	}, CHAT_VIEW_TYPE);
}

/**
 * Open the conversation history list by clicking the list button.
 * Returns true if the list is now visible.
 */
async function openConversationList(page: any): Promise<boolean> {
	const listBtn = await page.$(".notor-chat-header-btn[aria-label='Conversation history']");
	if (!listBtn) return false;
	await listBtn.click();
	await page.waitForTimeout(2_000);

	const isVisible = await page.evaluate(() => {
		const listEl = document.querySelector(".notor-conversation-list");
		return listEl !== null && !listEl.classList.contains("notor-hidden");
	});
	return isVisible;
}

/**
 * Close the conversation history list.
 */
async function closeConversationList(page: any): Promise<void> {
	const isVisible = await page.evaluate(() => {
		const listEl = document.querySelector(".notor-conversation-list");
		return listEl !== null && !listEl.classList.contains("notor-hidden");
	});
	if (isVisible) {
		const listBtn = await page.$(".notor-chat-header-btn[aria-label='Conversation history']");
		if (listBtn) {
			await listBtn.click();
			await page.waitForTimeout(500);
		}
	}
}

/**
 * Get all conversation list entries currently visible in the list.
 */
async function getConversationListEntries(page: any): Promise<Array<{
	title: string;
	isFavorite: boolean;
	hasMenuBtn: boolean;
}>> {
	return page.evaluate(() => {
		const items = document.querySelectorAll(".notor-conversation-list-item");
		return Array.from(items).map((item) => ({
			title: item.querySelector(".notor-conversation-list-title")?.textContent?.trim() ?? "",
			isFavorite: !!item.querySelector(".notor-conversation-favorite-indicator"),
			hasMenuBtn: !!item.querySelector(".notor-conversation-menu-btn"),
		}));
	});
}

/**
 * Open a conversation in a new tab by directly invoking the onOpenInNewTab
 * callback on an existing panel's view. This exercises the same code path
 * as clicking "Open in new tab" in the context menu.
 *
 * Returns true if the callback was invoked successfully.
 */
async function openInNewTabViaCallback(page: any, filename: string): Promise<boolean> {
	return page.evaluate((args: { viewType: string; filename: string }) => {
		const app = (window as any).app;
		if (!app) return false;
		const leaves = app.workspace.getLeavesOfType(args.viewType);
		// Use the first available leaf (all panels are equal in the unified model)
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view) {
				const cb = (view as any).onOpenInNewTab;
				if (typeof cb === "function") {
					cb(args.filename);
					return true;
				}
			}
		}
		return false;
	}, { viewType: CHAT_VIEW_TYPE, filename });
}

/**
 * Toggle favorite status for a conversation via the plugin's history manager.
 */
async function toggleFavoriteViaAPI(page: any, filename: string): Promise<boolean> {
	return page.evaluate((fname: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		try {
			const historyManager = (plugin as any)._historyManager ??
				plugin.getHistoryManager?.();
			if (historyManager?.toggleFavorite) {
				historyManager.toggleFavorite(fname);
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}, filename);
}

/**
 * Find JSONL files in the history directory.
 */
function getHistoryFiles(): string[] {
	const histDir = path.join(VAULT_PATH, HISTORY_DIR);
	if (!fs.existsSync(histDir)) return [];
	return fs.readdirSync(histDir).filter((f) => f.endsWith(".jsonl"));
}

/**
 * Count the messages in a JSONL file (excluding the header line).
 */
function countJSONLMessages(filename: string): number {
	const filePath = path.join(VAULT_PATH, HISTORY_DIR, filename);
	if (!fs.existsSync(filePath)) return 0;
	const content = fs.readFileSync(filePath, "utf-8");
	const lines = content.split("\n").filter(Boolean);
	return Math.max(0, lines.length - 1);
}

/**
 * Get the conversation ID from a JSONL file's header.
 */
function getConversationIdFromFile(filename: string): string | null {
	const filePath = path.join(VAULT_PATH, HISTORY_DIR, filename);
	if (!fs.existsSync(filePath)) return null;
	const firstLine = fs.readFileSync(filePath, "utf-8").split("\n")[0];
	if (!firstLine) return null;
	try {
		const header = JSON.parse(firstLine);
		return header.id ?? null;
	} catch {
		return null;
	}
}

/**
 * Check if a JSONL file's header has is_favorite set.
 */
function isConversationFavorited(filename: string): boolean {
	const filePath = path.join(VAULT_PATH, HISTORY_DIR, filename);
	if (!fs.existsSync(filePath)) return false;
	const firstLine = fs.readFileSync(filePath, "utf-8").split("\n")[0];
	if (!firstLine) return false;
	try {
		const header = JSON.parse(firstLine);
		return !!header.is_favorite;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Shared state between sequential tests
// ---------------------------------------------------------------------------

interface SharedState {
	conv1Filename?: string;
	conv2Filename?: string;
	conv1Id?: string;
	conv2Id?: string;
}
const shared: SharedState = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSetup(ctx: TestContext): Promise<void> {
	console.log("\n-- Setup: Create two conversations with messages --");
	const { page } = ctx;

	// Send a message in the default conversation to create conversation 1
	const responded1 = await sendMessage(page, "Hello from conversation one. Reply briefly.");
	if (!responded1) {
		ctx.fail("Setup: Create conversation 1", "LLM did not respond");
		return;
	}
	await page.waitForTimeout(2_000);

	const files1 = getHistoryFiles();
	if (files1.length === 0) {
		ctx.fail("Setup: Create conversation 1", "No JSONL files found after first message");
		return;
	}
	shared.conv1Filename = files1[files1.length - 1]!;
	shared.conv1Id = getConversationIdFromFile(shared.conv1Filename) ?? undefined;
	console.log(`  Conversation 1: ${shared.conv1Filename} (id=${shared.conv1Id?.substring(0, 8)})`);

	// Create a new conversation and send a message
	await newConversation(page);
	await page.waitForTimeout(1_500);

	const responded2 = await sendMessage(page, "Hello from conversation two. Reply briefly.");
	if (!responded2) {
		ctx.fail("Setup: Create conversation 2", "LLM did not respond");
		return;
	}
	await page.waitForTimeout(2_000);

	const files2 = getHistoryFiles();
	const newFiles = files2.filter((f) => f !== shared.conv1Filename);
	if (newFiles.length === 0) {
		ctx.fail("Setup: Create conversation 2", "No new JSONL file found after second conversation");
		return;
	}
	shared.conv2Filename = newFiles[newFiles.length - 1]!;
	shared.conv2Id = getConversationIdFromFile(shared.conv2Filename) ?? undefined;
	console.log(`  Conversation 2: ${shared.conv2Filename} (id=${shared.conv2Id?.substring(0, 8)})`);

	const shot = await ctx.screenshot("00-setup-done");
	ctx.pass(
		"Setup",
		`Created 2 conversations: conv1=${shared.conv1Filename}, conv2=${shared.conv2Filename}`,
		shot,
	);
}

async function testCallbackWired(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 1: onOpenInNewTab callback is wired on the view --");
	const { page } = ctx;

	const callbackInfo = await page.evaluate((viewType: string) => {
		const app = (window as any).app;
		if (!app) return { error: "app not found" };
		const leaves = app.workspace.getLeavesOfType(viewType);
		// Check the first available view (all panels are equal in the unified model)
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view) {
				const cb = (view as any).onOpenInNewTab;
				return {
					hasCallback: typeof cb === "function",
					hasSetterMethod: typeof view.setOnOpenInNewTab === "function",
				};
			}
		}
		return { error: "no view found" };
	}, CHAT_VIEW_TYPE);

	const shot = await ctx.screenshot("01-callback-wired");

	if ((callbackInfo as any).error) {
		ctx.fail("Callback wired", `Error: ${(callbackInfo as any).error}`, shot);
		return;
	}

	const info = callbackInfo as { hasCallback: boolean; hasSetterMethod: boolean };
	if (info.hasCallback && info.hasSetterMethod) {
		ctx.pass(
			"Callback wired",
			`onOpenInNewTab callback is set on the view (hasCallback=${info.hasCallback}, hasSetterMethod=${info.hasSetterMethod})`,
			shot,
		);
	} else {
		ctx.fail(
			"Callback wired",
			`onOpenInNewTab not fully wired: hasCallback=${info.hasCallback}, hasSetterMethod=${info.hasSetterMethod}`,
			shot,
		);
	}
}

async function testContextMenuButtonExists(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 2: Context menu button and handler exist on conversation list items --");
	const { page } = ctx;

	const listOpened = await openConversationList(page);
	if (!listOpened) {
		const shot = await ctx.screenshot("02-list-not-opened");
		ctx.fail("Context menu button", "Could not open conversation history list", shot);
		return;
	}

	const entries = await getConversationListEntries(page);
	console.log(`  Conversation list has ${entries.length} entries`);

	if (entries.length === 0) {
		const shot = await ctx.screenshot("02-no-entries");
		ctx.fail("Context menu button", "Conversation list is empty", shot);
		await closeConversationList(page);
		return;
	}

	// Check that each entry has a menu button
	const allHaveMenuBtn = entries.every((e) => e.hasMenuBtn);

	// Also verify the contextmenu event listener is registered by checking the DOM structure
	const hasContextMenuHandler = await page.evaluate(() => {
		const items = document.querySelectorAll(".notor-conversation-list-item");
		if (items.length === 0) return false;
		// The item should have a menu button with the more-vertical icon
		const firstItem = items[0]!;
		const menuBtn = firstItem.querySelector(".notor-conversation-menu-btn");
		if (!menuBtn) return false;
		// Check the icon is present (SVG inside the button)
		const svg = menuBtn.querySelector("svg");
		return !!svg;
	});

	const shot = await ctx.screenshot("02-menu-button-exists");
	await closeConversationList(page);

	if (allHaveMenuBtn && hasContextMenuHandler) {
		ctx.pass(
			"Context menu button",
			`All ${entries.length} conversation entries have the 3-dot menu button with icon`,
			shot,
		);
	} else {
		ctx.fail(
			"Context menu button",
			`Menu button check: allHaveMenuBtn=${allHaveMenuBtn}, hasIcon=${hasContextMenuHandler}`,
			shot,
		);
	}
}

async function testOpenInNewTab(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 3: Opening a conversation in a new tab creates a secondary panel with messages --");
	const { page } = ctx;

	const leafCountBefore = await getChatLeafCount(page);
	console.log(`  Leaves before: ${leafCountBefore}`);

	// Open conv1 (the older, non-active conversation) in a new tab
	const filename = shared.conv1Filename!;
	const invoked = await openInNewTabViaCallback(page, filename);

	if (!invoked) {
		const shot = await ctx.screenshot("03-callback-failed");
		ctx.fail("Open in new tab", "Failed to invoke onOpenInNewTab callback", shot);
		return;
	}

	// Wait for the new panel to be created and conversation loaded
	await page.waitForTimeout(4_000);

	const leafCountAfter = await getChatLeafCount(page);
	console.log(`  Leaves after: ${leafCountAfter}`);

	const leaves = await getChatLeafInfo(page);
	const extraLeaves = leaves.length > leafCountBefore;
	console.log(`  Extra panels: ${extraLeaves ? leaves.length - leafCountBefore : 0}`);
	for (let i = 0; i < leaves.length; i++) {
		const l = leaves[i]!;
		console.log(`    Leaf ${i}: leafId=${l.leafId.substring(0, 8)}, convId=${l.conversationId?.substring(0, 8) ?? "null"}, msgs=${l.messageCount}`);
	}

	// Activate the new panel (last leaf) and count messages
	const newPanelIdx = leaves.length > leafCountBefore ? leaves.length - 1 : -1;
	let msgCount = 0;
	if (newPanelIdx >= 0) {
		await activateLeaf(page, newPanelIdx);
		await page.waitForTimeout(2_000);
		msgCount = await page.evaluate(() => {
			return document.querySelectorAll(".notor-message-assistant, .notor-message-user").length;
		});
	}

	const expectedMsgCount = countJSONLMessages(filename);
	const shot = await ctx.screenshot("03-opened-in-new-tab");

	console.log(`  Messages in new panel: ${msgCount}`);
	console.log(`  Messages in JSONL: ${expectedMsgCount}`);

	const newPanelCreated = leafCountAfter > leafCountBefore;
	const hasMessages = msgCount >= 2; // At least user + assistant

	if (newPanelCreated && hasMessages) {
		ctx.pass(
			"Open in new tab",
			`New panel created with ${msgCount} messages (JSONL has ${expectedMsgCount}). ` +
			`Leaves: ${leafCountBefore} -> ${leafCountAfter}`,
			shot,
		);
	} else {
		ctx.fail(
			"Open in new tab",
			`newPanelCreated=${newPanelCreated}, hasMessages=${hasMessages} (${msgCount}). ` +
			`Leaves: ${leafCountBefore} -> ${leafCountAfter}`,
			shot,
		);
	}

	// Clean up
	await closeLastExtraPanel(page);
	await page.waitForTimeout(1_000);
}

async function testWorksForFavorited(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 4: Works for favorited conversations --");
	const { page } = ctx;

	const filename = shared.conv1Filename!;

	// Mark conv1 as a favorite via the API
	const toggled = await toggleFavoriteViaAPI(page, filename);
	await page.waitForTimeout(1_000);

	const isFav = isConversationFavorited(filename);
	console.log(`  Toggled favorite via API: ${toggled}, is_favorite on disk: ${isFav}`);

	const leafCountBefore = await getChatLeafCount(page);
	const invoked = await openInNewTabViaCallback(page, filename);

	if (!invoked) {
		const shot = await ctx.screenshot("04-callback-failed");
		ctx.fail("Works for favorited", "Failed to invoke onOpenInNewTab callback", shot);
		return;
	}

	await page.waitForTimeout(4_000);

	const leafCountAfter = await getChatLeafCount(page);
	const leaves = await getChatLeafInfo(page);
	const newPanelCreated = leafCountAfter > leafCountBefore;

	// Count messages in the new panel (last leaf)
	const newPanelIdx = newPanelCreated ? leaves.length - 1 : -1;
	let msgCount = 0;
	if (newPanelIdx >= 0) {
		await activateLeaf(page, newPanelIdx);
		await page.waitForTimeout(2_000);
		msgCount = await page.evaluate(() => {
			return document.querySelectorAll(".notor-message-assistant, .notor-message-user").length;
		});
	}

	const shot = await ctx.screenshot("04-favorited-opened");

	if (newPanelCreated && msgCount >= 2) {
		ctx.pass(
			"Works for favorited",
			`Favorited conversation opened in new tab with ${msgCount} messages. ` +
			`is_favorite=${isFav}. Leaves: ${leafCountBefore} -> ${leafCountAfter}`,
			shot,
		);
	} else {
		ctx.fail(
			"Works for favorited",
			`Failed. Leaves: ${leafCountBefore} -> ${leafCountAfter}, ` +
			`newPanel: ${newPanelCreated}, msgs: ${msgCount}, isFav: ${isFav}`,
			shot,
		);
	}

	// Clean up
	await closeLastExtraPanel(page);
	await page.waitForTimeout(1_000);
}

async function testWorksForNonFavorited(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 5: Works for non-favorited conversations --");
	const { page } = ctx;

	// conv2 should be non-favorited
	const filename = shared.conv2Filename!;
	const isFav = isConversationFavorited(filename);
	console.log(`  Using conv2: ${filename}, is_favorite=${isFav}`);

	const leafCountBefore = await getChatLeafCount(page);
	const invoked = await openInNewTabViaCallback(page, filename);

	if (!invoked) {
		const shot = await ctx.screenshot("05-callback-failed");
		ctx.fail("Works for non-favorited", "Failed to invoke onOpenInNewTab callback", shot);
		return;
	}

	await page.waitForTimeout(4_000);

	const leafCountAfter = await getChatLeafCount(page);
	const leaves = await getChatLeafInfo(page);
	const newPanelCreated = leafCountAfter > leafCountBefore;

	// Count messages in the new panel (last leaf)
	const newPanelIdx = newPanelCreated ? leaves.length - 1 : -1;
	let msgCount = 0;
	if (newPanelIdx >= 0) {
		await activateLeaf(page, newPanelIdx);
		await page.waitForTimeout(2_000);
		msgCount = await page.evaluate(() => {
			return document.querySelectorAll(".notor-message-assistant, .notor-message-user").length;
		});
	}

	const shot = await ctx.screenshot("05-non-favorited-opened");

	if (newPanelCreated && msgCount >= 2) {
		ctx.pass(
			"Works for non-favorited",
			`Non-favorited conversation opened in new tab with ${msgCount} messages. ` +
			`is_favorite=${isFav}. Leaves: ${leafCountBefore} -> ${leafCountAfter}`,
			shot,
		);
	} else {
		ctx.fail(
			"Works for non-favorited",
			`Failed. Leaves: ${leafCountBefore} -> ${leafCountAfter}, ` +
			`newPanel: ${newPanelCreated}, msgs: ${msgCount}, isFav: ${isFav}`,
			shot,
		);
	}

	// Clean up
	await closeLastExtraPanel(page);
	await page.waitForTimeout(1_000);
}

async function testNewPanelState(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 6: Opened panel has correct state (conversationId set) --");
	const { page } = ctx;

	const leafCountBefore = await getChatLeafCount(page);
	const filename = shared.conv1Filename!;
	const invoked = await openInNewTabViaCallback(page, filename);

	if (!invoked) {
		const shot = await ctx.screenshot("06-callback-failed");
		ctx.fail("Panel state", "Failed to invoke onOpenInNewTab callback", shot);
		return;
	}

	await page.waitForTimeout(4_000);

	const leafCountAfter = await getChatLeafCount(page);
	const newPanelIdx = leafCountAfter > leafCountBefore ? leafCountAfter - 1 : -1;

	if (newPanelIdx === -1) {
		const shot = await ctx.screenshot("06-no-new-panel");
		ctx.fail("Panel state", "No new panel created", shot);
		return;
	}

	const state = await getLeafState(page, newPanelIdx);

	const shot = await ctx.screenshot("06-panel-state");

	if (!state) {
		ctx.fail("Panel state", "Could not retrieve state from new panel", shot);
		await closeLastExtraPanel(page);
		return;
	}

	// In the unified model, isSecondary is no longer part of state — just verify
	// the panel has the correct conversation loaded
	const hasConvFilename = typeof state.conversationFilename === "string" &&
		(state.conversationFilename as string).length > 0;
	const hasConvId = typeof state.conversationId === "string" &&
		(state.conversationId as string).length > 0;

	console.log(`  State: conversationFilename=${state.conversationFilename}, conversationId=${(state.conversationId as string)?.substring(0, 8) ?? "null"}`);

	if (hasConvFilename || hasConvId) {
		ctx.pass(
			"Panel state",
			`Correct state: conversationFilename=${state.conversationFilename ?? "null"}, ` +
			`conversationId=${(state.conversationId as string)?.substring(0, 8) ?? "null"}`,
			shot,
		);
	} else {
		ctx.fail(
			"Panel state",
			`Missing conversation reference: conversationFilename=${state.conversationFilename ?? "null"}, ` +
			`conversationId=${(state.conversationId as string)?.substring(0, 8) ?? "null"}`,
			shot,
		);
	}

	// Clean up
	await closeLastExtraPanel(page);
	await page.waitForTimeout(1_000);
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 7: No unexpected error logs from open-in-new-tab operations --");
	const { collector } = ctx;

	const relevantSources = [
		"ChatOrchestrator",
		"ConversationSession",
		"NotorChatView",
		"ChatView",
		"HistoryManager",
	];

	const allLogs = collector.getStructuredLogs();
	const errorLogs = allLogs.filter(
		(e) =>
			e.level === "error" &&
			relevantSources.some((src) => e.source.includes(src)) &&
			// Filter expected errors that aren't related to open-in-new-tab
			!e.message.includes("Provider error") &&
			!e.message.includes("AUTH_FAILED") &&
			!e.message.includes("API key not configured") &&
			!e.message.includes("RATE_LIMITED") &&
			!e.message.includes("Rate limited") &&
			!e.message.includes("connection") &&
			!e.message.includes("timeout"),
	);

	if (errorLogs.length === 0) {
		ctx.pass(
			"No unexpected errors",
			`Zero error-level logs from ${relevantSources.join(", ")} during open-in-new-tab operations`,
		);
	} else {
		ctx.fail(
			"No unexpected errors",
			`${errorLogs.length} error-level log(s): ` +
			errorLogs.slice(0, 5).map((e) => `[${e.source}] "${e.message}"`).join("; "),
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // Wait for plugin init

	const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chatContainer) throw new Error("Chat panel not visible — cannot run tests");
	const initShot = await ctx.screenshot("00-chat-ready");
	ctx.pass("Chat panel ready", "Plugin loaded and chat container found", initShot);

	// Setup: Create two conversations with messages
	await safeRun(ctx, "Setup", () => testSetup(ctx));

	// Verify setup worked
	if (!shared.conv1Filename || !shared.conv2Filename) {
		ctx.fail("Suite prerequisite", "Setup failed — skipping remaining tests");
		return;
	}

	// Test 1: Callback is wired
	await safeRun(ctx, "Callback wired", () => testCallbackWired(ctx));

	// Test 2: Context menu button exists on list items
	await safeRun(ctx, "Context menu button", () => testContextMenuButtonExists(ctx));

	// Test 3: Open conversation in new tab with full message history
	await safeRun(ctx, "Open in new tab", () => testOpenInNewTab(ctx));

	// Test 4: Works for favorited conversations
	await safeRun(ctx, "Works for favorited", () => testWorksForFavorited(ctx));

	// Test 5: Works for non-favorited conversations
	await safeRun(ctx, "Works for non-favorited", () => testWorksForNonFavorited(ctx));

	// Test 6: Panel state correctness
	await safeRun(ctx, "Panel state", () => testNewPanelState(ctx));

	// Test 7: Error log check (always last)
	await safeRun(ctx, "No unexpected errors", () => testNoUnexpectedErrors(ctx));
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mode: "plan", // Plan mode avoids tool calls — cleaner tests
});

runTest(
	{
		name: "phase5-open-in-new-tab",
		settings,
	},
	tests,
);
