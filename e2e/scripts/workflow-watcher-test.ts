#!/usr/bin/env npx tsx
/**
 * Workflow Vault Watcher End-to-End Test
 *
 * Proves that the vault-event listeners registered by `registerWorkflowVaultWatcher()`
 * keep the workflow cache fresh without requiring a plugin reload.
 *
 * Tests:
 *  1. Initial workflow count matches known fixtures
 *  2. CREATE — new workflow note added to vault appears in cache automatically
 *  3. DELETE — removing a workflow note removes it from the cache
 *  4. RENAME-IN — renaming a non-workflow .md file into the workflows folder adds it
 *  5. RENAME-WITHIN — renaming an existing workflow updates its display_name
 *  6. RENAME-OUT — renaming a workflow out of the workflows folder removes it
 *  7. METADATA-EDIT — editing frontmatter of an existing workflow updates the cache
 *
 * Each test uses `app.vault.create()` / `rename()` / `delete()` / `modify()` (Obsidian
 * API) so that vault events fire exactly as they do during normal user interaction.
 * `adapter.write()` is deliberately NOT used here — that bypasses vault events.
 *
 * Prerequisites:
 *   - Test workflow fixtures present in e2e/test-vault/notor/workflows/
 *     (same fixtures as workflow-discovery-test.ts, set up by the same helper)
 *   - Plugin built via `npm run build`
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	VAULT_PATH,
} from "../lib/test-helpers";

/** How long to wait after a vault operation before checking the cache.
 *  300 ms debounce + 400 ms buffer for metadata cache to settle = 700 ms. */
const RESCAN_WAIT_MS = 700;

// ---------------------------------------------------------------------------
// Plugin access helpers
// ---------------------------------------------------------------------------

/**
 * Return the current workflow display_names from the plugin's live cache.
 * Returns null if the plugin is not accessible.
 */
async function getWorkflowNames(page: Page): Promise<string[] | null> {
	return page.evaluate(() => {
		type App = {
			plugins?: {
				plugins?: {
					notor?: {
						getDiscoveredWorkflows?: () => Array<{ display_name: string }>;
					};
				};
			};
		};
		const plugin = (window as unknown as { app?: App }).app?.plugins?.plugins?.notor;
		if (!plugin?.getDiscoveredWorkflows) return null;
		return plugin.getDiscoveredWorkflows().map((w) => w.display_name);
	});
}

/**
 * Create a file via Obsidian's vault API so vault events fire.
 * Returns true on success, false if the API was not reachable.
 */
async function vaultCreate(
	page: Page,
	vaultPath: string,
	content: string
): Promise<boolean> {
	return page.evaluate(
		async (args: { p: string; c: string }) => {
			type App = {
				vault?: { create?: (path: string, data: string) => Promise<unknown> };
			};
			try {
				await (window as unknown as { app?: App }).app?.vault?.create?.(args.p, args.c);
				return true;
			} catch {
				return false;
			}
		},
		{ p: vaultPath, c: content }
	);
}

/**
 * Delete a file via Obsidian's vault API so vault events fire.
 */
async function vaultDelete(page: Page, vaultPath: string): Promise<boolean> {
	return page.evaluate(async (p: string) => {
		type App = {
			vault?: {
				getAbstractFileByPath?: (path: string) => unknown;
				delete?: (file: unknown) => Promise<void>;
			};
		};
		const vault = (window as unknown as { app?: App }).app?.vault;
		if (!vault) return false;
		const file = vault.getAbstractFileByPath?.(p);
		if (!file) return false;
		await vault.delete?.(file);
		return true;
	}, vaultPath);
}

/**
 * Rename/move a file via Obsidian's vault API so vault events fire.
 */
async function vaultRename(
	page: Page,
	oldVaultPath: string,
	newVaultPath: string
): Promise<boolean> {
	return page.evaluate(
		async (args: { old: string; new: string }) => {
			type App = {
				vault?: {
					getAbstractFileByPath?: (path: string) => unknown;
					rename?: (file: unknown, newPath: string) => Promise<void>;
				};
			};
			const vault = (window as unknown as { app?: App }).app?.vault;
			if (!vault) return false;
			const file = vault.getAbstractFileByPath?.(args.old);
			if (!file) return false;
			await vault.rename?.(file, args.new);
			return true;
		},
		{ old: oldVaultPath, new: newVaultPath }
	);
}

/**
 * Modify a file's content via Obsidian's vault API so metadataCache events fire.
 */
async function vaultModify(
	page: Page,
	vaultPath: string,
	content: string
): Promise<boolean> {
	return page.evaluate(
		async (args: { p: string; c: string }) => {
			type App = {
				vault?: {
					getAbstractFileByPath?: (path: string) => unknown;
					modify?: (file: unknown, data: string) => Promise<void>;
				};
			};
			const vault = (window as unknown as { app?: App }).app?.vault;
			if (!vault) return false;
			const file = vault.getAbstractFileByPath?.(args.p);
			if (!file) return false;
			await vault.modify?.(file, args.c);
			return true;
		},
		{ p: vaultPath, c: content }
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testPluginLoads(ctx: TestContext): Promise<void> {
	console.log("Test 1: Plugin loads and chat panel visible");
	const el = await waitForSelector(ctx.page, ".notor-chat-container", 10_000);
	if (el) {
		ctx.pass("Plugin loaded", "Found .notor-chat-container");
	} else {
		const shot = await ctx.screenshot("01-no-chat-panel");
		ctx.fail("Plugin loaded", ".notor-chat-container not found after 10 s", shot);
	}
}

async function testInitialCount(ctx: TestContext): Promise<number> {
	console.log("\nTest 2: Initial workflow count is known");
	const names = await getWorkflowNames(ctx.page);
	if (names === null) {
		ctx.fail("Initial workflow count", "getDiscoveredWorkflows() not accessible via plugin API");
		return -1;
	}
	// We expect at least the two fixtures we just wrote (daily/review, auto-tag)
	if (names.length >= 2) {
		ctx.pass(
			"Initial workflow count",
			`${names.length} workflow(s) discovered: ${names.join(", ")}`
		);
	} else {
		ctx.fail(
			"Initial workflow count",
			`Expected ≥ 2 workflows from fixtures, got ${names.length}: ${names.join(", ")}`
		);
	}
	return names.length;
}

async function testCreateAddsWorkflow(ctx: TestContext, beforeCount: number): Promise<void> {
	console.log("\nTest 3: CREATE — new workflow appears in cache");

	const newPath = "notor/workflows/watcher-test-new.md";
	const content = `---
notor-workflow: true
notor-trigger: manual
---

# Watcher test workflow
`;

	const ok = await vaultCreate(ctx.page, newPath, content);
	if (!ok) {
		ctx.fail("CREATE adds workflow", "vault.create() returned false — API not reachable");
		return;
	}

	await ctx.page.waitForTimeout(RESCAN_WAIT_MS);

	const names = await getWorkflowNames(ctx.page);
	if (names === null) {
		ctx.fail("CREATE adds workflow", "getDiscoveredWorkflows() not accessible after create");
		return;
	}

	const shot = await ctx.screenshot("03-after-create");

	if (names.length === beforeCount + 1 && names.includes("watcher-test-new")) {
		ctx.pass(
			"CREATE adds workflow",
			`Count went ${beforeCount} → ${names.length}; "watcher-test-new" present`,
			shot
		);
	} else {
		ctx.fail(
			"CREATE adds workflow",
			`Expected ${beforeCount + 1} workflows including "watcher-test-new", got ${names.length}: [${names.join(", ")}]`,
			shot
		);
	}
}

async function testDeleteRemovesWorkflow(ctx: TestContext, beforeCount: number): Promise<void> {
	console.log("\nTest 4: DELETE — removed workflow disappears from cache");

	const targetPath = "notor/workflows/watcher-test-new.md";
	const ok = await vaultDelete(ctx.page, targetPath);
	if (!ok) {
		ctx.fail("DELETE removes workflow", `vault.delete("${targetPath}") returned false`);
		return;
	}

	await ctx.page.waitForTimeout(RESCAN_WAIT_MS);

	const names = await getWorkflowNames(ctx.page);
	if (names === null) {
		ctx.fail("DELETE removes workflow", "getDiscoveredWorkflows() not accessible after delete");
		return;
	}

	const shot = await ctx.screenshot("04-after-delete");

	if (names.length === beforeCount && !names.includes("watcher-test-new")) {
		ctx.pass(
			"DELETE removes workflow",
			`Count back to ${beforeCount}; "watcher-test-new" absent`,
			shot
		);
	} else {
		ctx.fail(
			"DELETE removes workflow",
			`Expected ${beforeCount} workflows without "watcher-test-new", got ${names.length}: [${names.join(", ")}]`,
			shot
		);
	}
}

async function testRenameInAddsWorkflow(ctx: TestContext, beforeCount: number): Promise<void> {
	console.log("\nTest 5: RENAME-IN — moving a .md file into workflows folder adds it");

	// Create an .md file OUTSIDE the workflows directory first
	const outsidePath = "watcher-test-outside.md";
	const insidePath = "notor/workflows/watcher-test-moved-in.md";
	const content = `---
notor-workflow: true
notor-trigger: manual
---

# Moved-in workflow
`;

	const created = await vaultCreate(ctx.page, outsidePath, content);
	if (!created) {
		ctx.fail("RENAME-IN adds workflow", "vault.create() for outside file returned false");
		return;
	}
	// Brief pause so the create event doesn't interfere with the rename test timing
	await ctx.page.waitForTimeout(RESCAN_WAIT_MS);

	const namesBeforeMove = await getWorkflowNames(ctx.page);
	const countBeforeMove = namesBeforeMove?.length ?? beforeCount;

	const ok = await vaultRename(ctx.page, outsidePath, insidePath);
	if (!ok) {
		ctx.fail("RENAME-IN adds workflow", `vault.rename() to inside path returned false`);
		await vaultDelete(ctx.page, outsidePath).catch(() => {});
		return;
	}

	await ctx.page.waitForTimeout(RESCAN_WAIT_MS);

	const names = await getWorkflowNames(ctx.page);
	const shot = await ctx.screenshot("05-after-rename-in");

	if (names !== null && names.length === countBeforeMove + 1 && names.includes("watcher-test-moved-in")) {
		ctx.pass(
			"RENAME-IN adds workflow",
			`Count went ${countBeforeMove} → ${names.length}; "watcher-test-moved-in" present`,
			shot
		);
	} else {
		ctx.fail(
			"RENAME-IN adds workflow",
			`Expected ${countBeforeMove + 1} workflows including "watcher-test-moved-in", got ${names?.length}: [${names?.join(", ")}]`,
			shot
		);
	}
}

async function testRenameWithinUpdatesWorkflow(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: RENAME-WITHIN — renaming a workflow updates its display_name");

	const oldPath = "notor/workflows/watcher-test-moved-in.md";
	const newPath = "notor/workflows/watcher-test-renamed.md";

	const namesBefore = await getWorkflowNames(ctx.page);
	if (!namesBefore?.includes("watcher-test-moved-in")) {
		ctx.fail("RENAME-WITHIN updates workflow", `Precondition failed: "watcher-test-moved-in" not in cache: [${namesBefore?.join(", ")}]`);
		return;
	}

	const ok = await vaultRename(ctx.page, oldPath, newPath);
	if (!ok) {
		ctx.fail("RENAME-WITHIN updates workflow", "vault.rename() returned false");
		return;
	}

	await ctx.page.waitForTimeout(RESCAN_WAIT_MS);

	const names = await getWorkflowNames(ctx.page);
	const shot = await ctx.screenshot("06-after-rename-within");

	const hasNew = names?.includes("watcher-test-renamed");
	const hasOld = names?.includes("watcher-test-moved-in");

	if (hasNew && !hasOld) {
		ctx.pass(
			"RENAME-WITHIN updates workflow",
			`"watcher-test-moved-in" → "watcher-test-renamed" reflected in cache`,
			shot
		);
	} else {
		ctx.fail(
			"RENAME-WITHIN updates workflow",
			`Expected "watcher-test-renamed" present and "watcher-test-moved-in" absent. ` +
				`hasNew=${hasNew} hasOld=${hasOld} names=[${names?.join(", ")}]`,
			shot
		);
	}
}

async function testRenameOutRemovesWorkflow(ctx: TestContext, beforeCount: number): Promise<void> {
	console.log("\nTest 7: RENAME-OUT — moving a workflow out of workflows folder removes it");

	const insidePath = "notor/workflows/watcher-test-renamed.md";
	const outsidePath = "watcher-test-outside-moved.md";

	const namesBefore = await getWorkflowNames(ctx.page);
	if (!namesBefore?.includes("watcher-test-renamed")) {
		ctx.fail("RENAME-OUT removes workflow", `Precondition failed: "watcher-test-renamed" not in cache: [${namesBefore?.join(", ")}]`);
		return;
	}

	const ok = await vaultRename(ctx.page, insidePath, outsidePath);
	if (!ok) {
		ctx.fail("RENAME-OUT removes workflow", "vault.rename() returned false");
		return;
	}

	await ctx.page.waitForTimeout(RESCAN_WAIT_MS);

	const names = await getWorkflowNames(ctx.page);
	const shot = await ctx.screenshot("07-after-rename-out");

	// Clean up the moved file
	await vaultDelete(ctx.page, outsidePath).catch(() => {});

	if (names !== null && !names.includes("watcher-test-renamed")) {
		ctx.pass(
			"RENAME-OUT removes workflow",
			`"watcher-test-renamed" absent after moving out of workflows folder. Count: ${names.length}`,
			shot
		);
	} else {
		ctx.fail(
			"RENAME-OUT removes workflow",
			`Expected "watcher-test-renamed" to be removed. names=[${names?.join(", ")}]`,
			shot
		);
	}
}

async function testMetadataEditUpdatesCache(ctx: TestContext): Promise<void> {
	console.log("\nTest 8: METADATA-EDIT — editing frontmatter of existing workflow reflects in cache");

	// Create a workflow, wait for it to appear, then modify its trigger via vault.modify()
	const wfPath = "notor/workflows/watcher-test-meta.md";
	const initialContent = `---
notor-workflow: true
notor-trigger: manual
---

# Meta edit test
`;
	const updatedContent = `---
notor-workflow: true
notor-trigger: on-note-open
---

# Meta edit test (updated trigger)
`;

	const created = await vaultCreate(ctx.page, wfPath, initialContent);
	if (!created) {
		ctx.fail("METADATA-EDIT updates cache", "vault.create() returned false");
		return;
	}
	await ctx.page.waitForTimeout(RESCAN_WAIT_MS);

	const namesAfterCreate = await getWorkflowNames(ctx.page);
	if (!namesAfterCreate?.includes("watcher-test-meta")) {
		ctx.fail(
			"METADATA-EDIT updates cache",
			`Precondition: "watcher-test-meta" not found after create. names=[${namesAfterCreate?.join(", ")}]`
		);
		await vaultDelete(ctx.page, wfPath).catch(() => {});
		return;
	}

	// Now modify the file to change the trigger
	const modified = await vaultModify(ctx.page, wfPath, updatedContent);
	if (!modified) {
		ctx.fail("METADATA-EDIT updates cache", "vault.modify() returned false");
		await vaultDelete(ctx.page, wfPath).catch(() => {});
		return;
	}

	await ctx.page.waitForTimeout(RESCAN_WAIT_MS);

	// Query discovered workflows and verify the trigger changed
	const triggerAfter = await ctx.page.evaluate((p: string) => {
		type App = {
			plugins?: {
				plugins?: {
					notor?: {
						getDiscoveredWorkflows?: () => Array<{ file_path: string; trigger: string }>;
					};
				};
			};
		};
		const plugin = (window as unknown as { app?: App }).app?.plugins?.plugins?.notor;
		if (!plugin?.getDiscoveredWorkflows) return null;
		const wf = plugin.getDiscoveredWorkflows().find((w) => w.file_path.includes("watcher-test-meta"));
		return wf?.trigger ?? null;
	}, wfPath);

	const shot = await ctx.screenshot("08-after-metadata-edit");

	// Clean up
	await vaultDelete(ctx.page, wfPath).catch(() => {});

	if (triggerAfter === "on-note-open") {
		ctx.pass(
			"METADATA-EDIT updates cache",
			`Trigger correctly updated to "on-note-open" after frontmatter edit`,
			shot
		);
	} else {
		ctx.fail(
			"METADATA-EDIT updates cache",
			`Expected trigger "on-note-open", got "${triggerAfter}"`,
			shot
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext) {
	const { page } = ctx;
	await page.waitForTimeout(8000);

	// ── Test 1: Plugin loaded ───────────────────────────────────────────
	await testPluginLoads(ctx);
	await ctx.screenshot("01-initial-state");

	// ── Test 2: Baseline count ──────────────────────────────────────────
	const initialCount = await testInitialCount(ctx);
	if (initialCount < 0) {
		console.error("\nCannot continue — plugin API not accessible.");
		process.exit(1);
	}

	// ── Test 3: CREATE adds workflow ────────────────────────────────────
	await testCreateAddsWorkflow(ctx, initialCount);

	// ── Test 4: DELETE removes workflow ─────────────────────────────────
	await testDeleteRemovesWorkflow(ctx, initialCount);

	// ── Test 5: RENAME-IN adds workflow ─────────────────────────────────
	await testRenameInAddsWorkflow(ctx, initialCount);

	// ── Test 6: RENAME-WITHIN updates display_name ──────────────────────
	await testRenameWithinUpdatesWorkflow(ctx);

	// ── Test 7: RENAME-OUT removes workflow ─────────────────────────────
	await testRenameOutRemovesWorkflow(ctx, initialCount);

	// ── Test 8: METADATA-EDIT updates cache ─────────────────────────────
	await testMetadataEditUpdatesCache(ctx);
}

runTest(
	{
		name: "workflow-watcher",
		settings: buildDefaultSettings(),
		setupVault: (vaultPath) => {
			const workflowsDir = path.join(vaultPath, "notor", "workflows");
			fs.mkdirSync(workflowsDir, { recursive: true });

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
`
			);

			fs.writeFileSync(
				path.join(workflowsDir, "auto-tag.md"),
				`---
notor-workflow: true
notor-trigger: on-save
---

# Auto-tag workflow
`
			);

			// Remove any leftover temp files from a previous test run
			for (const name of [
				"watcher-test-new.md",
				"watcher-test-renamed.md",
				"watcher-test-moved-in.md",
			]) {
				const fp = path.join(workflowsDir, name);
				if (fs.existsSync(fp)) fs.unlinkSync(fp);
			}
			const nonWorkflowFp = path.join(vaultPath, "watcher-test-outside.md");
			if (fs.existsSync(nonWorkflowFp)) fs.unlinkSync(nonWorkflowFp);

			console.log("  Test workflow fixtures ensured in test vault.");
		},
		cleanupFiles: [
			"notor/workflows/watcher-test-new.md",
			"notor/workflows/watcher-test-renamed.md",
			"notor/workflows/watcher-test-moved-in.md",
			"notor/workflows/watcher-test-meta.md",
			"watcher-test-outside.md",
			"watcher-test-outside-moved.md",
		],
	},
	tests,
);
