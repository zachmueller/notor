#!/usr/bin/env npx tsx
/**
 * Tab-completion highlight E2E test / debug harness.
 *
 * Bug under investigation: pressing Tab to accept an autocomplete suggestion in
 * the chat input always inserts the FIRST item, ignoring ArrowUp/ArrowDown
 * navigation. Affects both suggesters:
 *   - VaultNoteSuggest      (triggered by `[[`)  → inserts `.notor-wikilink-token`
 *   - WorkflowSlashSuggest  (triggered by `/`)   → inserts `.notor-workflow-token`
 *
 * Root-cause hypothesis (validated by this script): the plugin keeps its own
 * shadow `selectedIndex`, while Obsidian's `AbstractInputSuggest` owns the real,
 * visible highlight (`.suggestion-item.is-selected`) and moves it on arrow keys
 * via its own `scope`. The Tab handler reads the shadow index, which drifts out
 * of sync with what the user sees — so Tab inserts the wrong (usually first) item.
 * Enter works because it flows through Obsidian's own handler (`useSelectedItem`).
 *
 * This script is DIAGNOSTIC FIRST: it reproduces the bug, captures the
 * shadow-vs-real index desync, and probes which programmatic selection mechanism
 * the installed Obsidian actually supports:
 *   - Mechanism C (preferred): `(suggest as any).suggestions.useSelectedItem(evt)`
 *     — the exact call Obsidian's Enter handler makes.
 *   - Mechanism B (fallback):  read `.suggestion-item.is-selected` DOM index and
 *     map it into `currentSuggestions`.
 *
 * After the fix lands (chat-input Tab branch → `selectHighlighted`), the Tab
 * assertions in Test 1 and Test 3 flip from FAIL to PASS, and this script becomes
 * the permanent regression test.
 *
 * @see ideas/Tab completion in suggester always selects first item ignoring keyboard navigation.md
 * @see src/ui/chat-input.ts — keydown Tab/Arrow branches
 * @see src/ui/attachment-picker.ts — VaultNoteSuggest
 * @see src/ui/workflow-suggest.ts — WorkflowSlashSuggest
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	writeCleanWorkspace,
	waitForSelector,
	ensureCleanState,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Fixtures — several notes and workflows so arrow navigation is meaningful.
// ---------------------------------------------------------------------------

/** Vault-root notes (distinguishable basenames). */
const NOTE_NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
/** Workflow display names (files live under notor/workflows/<name>.md). */
const WORKFLOW_NAMES = ["wf-alpha", "wf-bravo", "wf-charlie", "wf-delta"];

// ---------------------------------------------------------------------------
// In-page probes (serializable snapshots — never return live objects).
// The whole e2e/ dir is lint-ignored, so `any` is fine here.
// ---------------------------------------------------------------------------

interface InstanceProbe {
	reachable: boolean;
	active?: boolean;
	shadowSelectedIndex?: number;
	currentLen?: number;
	hasController?: boolean;
	hasUseSelectedItem?: boolean;
	controllerSelectedItem?: number;
	controllerValuesLen?: number;
}

interface DomProbe {
	hasContainer: boolean;
	itemCount: number;
	selectedDomIndex: number;
	selectedText: string | null;
	allTexts: string[];
}

/** Reach the live suggest instance ("vault" | "workflow") and snapshot it. */
async function probeInstance(page: Page, which: "vault" | "workflow"): Promise<InstanceProbe> {
	return page.evaluate((kind) => {
		const w = window as any;
		const plugin = w.app?.plugins?.plugins?.["notor"];
		const leaves = w.app?.workspace?.getLeavesOfType?.("notor-chat-view") ?? [];
		const view = leaves[0]?.view ?? plugin?.getActiveOrchestrator?.()?.getView?.();
		const ci = view?.chatInput;
		const s = kind === "vault" ? ci?.vaultNoteSuggest : ci?.workflowSuggest;
		if (!s) return { reachable: false };
		const ctrl = s.suggestions; // Obsidian-internal SuggestionContainer (untyped)
		return {
			reachable: true,
			active: !!s.active,
			shadowSelectedIndex: s.selectedIndex,
			currentLen: s.currentSuggestions?.length ?? -1,
			hasController: !!ctrl,
			hasUseSelectedItem: typeof ctrl?.useSelectedItem === "function",
			controllerSelectedItem: ctrl?.selectedItem,
			controllerValuesLen: Array.isArray(ctrl?.values) ? ctrl.values.length : -1,
		};
	}, which);
}

/**
 * Identity of the item Obsidian currently has highlighted, read from the
 * suggest's `currentSuggestions[controllerSelectedItem]`. This is the reliable
 * comparison target: the rendered DOM text carries folder-path prefixes (vault)
 * and a 📋 icon (workflow), so string-matching the display text against the
 * inserted token is fragile. The underlying file name / workflow display_name
 * is exactly what the inserted token is built from.
 */
async function highlightedIdentity(
	page: Page,
	which: "vault" | "workflow",
): Promise<{ idx: number; expectedToken: string | null }> {
	return page.evaluate((kind) => {
		const w = window as any;
		const plugin = w.app?.plugins?.plugins?.["notor"];
		const leaves = w.app?.workspace?.getLeavesOfType?.("notor-chat-view") ?? [];
		const view = leaves[0]?.view ?? plugin?.getActiveOrchestrator?.()?.getView?.();
		const ci = view?.chatInput;
		const s = kind === "vault" ? ci?.vaultNoteSuggest : ci?.workflowSuggest;
		const idx = s?.suggestions?.selectedItem ?? -1;
		const item = (s?.currentSuggestions ?? [])[idx];
		if (!item) return { idx, expectedToken: null };
		// vault token: `[[${file.name}]]`  (file.name includes extension)
		// workflow token: `/${workflow.display_name}`
		const expectedToken =
			kind === "vault"
				? item.file?.name != null ? `[[${item.file.name}]]` : null
				: item.workflow?.display_name != null ? `/${item.workflow.display_name}` : null;
		return { idx, expectedToken };
	}, which);
}

/** Snapshot the currently-rendered suggestion popover DOM. */
async function probeDom(page: Page): Promise<DomProbe> {
	return page.evaluate(() => {
		const c = document.querySelector(".suggestion-container");
		const items = c ? Array.from(c.querySelectorAll(".suggestion-item")) : [];
		const sel = items.findIndex((el) => el.classList.contains("is-selected"));
		return {
			hasContainer: !!c,
			itemCount: items.length,
			selectedDomIndex: sel,
			selectedText: sel >= 0 ? (items[sel].textContent?.trim() ?? null) : null,
			allTexts: items.map((el) => el.textContent?.trim() ?? ""),
		};
	});
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

/** Clear the chat input and any open popover. */
async function resetInput(page: Page): Promise<void> {
	await page.keyboard.press("Escape").catch(() => {});
	await page.evaluate(() => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		if (el) {
			el.textContent = "";
			el.dispatchEvent(new Event("input", { bubbles: true }));
		}
	});
	await page.waitForTimeout(200);
}

/** Type a trigger into the focused chat input and wait for the popover. */
async function openSuggest(page: Page, trigger: string): Promise<boolean> {
	await page.focus(".notor-text-input");
	await page.keyboard.type(trigger);
	const found = await waitForSelector(page, ".suggestion-container .suggestion-item", 4_000);
	await page.waitForTimeout(200);
	return !!found;
}

/** Read the text of an inserted inline token (wikilink or workflow). */
async function readToken(page: Page, selector: string): Promise<string | null> {
	return page.evaluate((sel) => {
		const el = document.querySelector(sel);
		return el ? (el.textContent?.trim() ?? null) : null;
	}, selector);
}

/**
 * Drive: open the suggest, ArrowDown `steps` times capturing the desync table,
 * record the visibly-highlighted row text, then press `finalKey` (Tab or Enter).
 * Returns the highlighted text (pre-select) and the index table for logging.
 */
async function navigateAndCapture(
	page: Page,
	which: "vault" | "workflow",
	trigger: string,
	steps: number,
): Promise<{ opened: boolean; initialDom: DomProbe; initialInst: InstanceProbe; table: string[]; highlightedText: string | null }> {
	const opened = await openSuggest(page, trigger);
	const initialDom = await probeDom(page);
	const initialInst = await probeInstance(page, which);
	const table: string[] = [];
	table.push(
		`  start: domSel=${initialDom.selectedDomIndex} ctrlSel=${initialInst.controllerSelectedItem} shadow=${initialInst.shadowSelectedIndex} len=${initialDom.itemCount}`,
	);
	for (let i = 0; i < steps; i++) {
		await page.keyboard.press("ArrowDown");
		await page.waitForTimeout(120);
		const d = await probeDom(page);
		const inst = await probeInstance(page, which);
		table.push(
			`  after ArrowDown #${i + 1}: domSel=${d.selectedDomIndex} ctrlSel=${inst.controllerSelectedItem} shadow=${inst.shadowSelectedIndex}`,
		);
	}
	const finalDom = await probeDom(page);
	return { opened, initialDom, initialInst, table, highlightedText: finalDom.selectedText };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Test 1: reproduce the `[[` Tab bug and capture the shadow/real index desync. */
async function testVaultTabRepro(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: `[[` Tab selects the highlighted item (repro + desync capture)");
	const { page } = ctx;
	await resetInput(page);

	const nav = await navigateAndCapture(page, "vault", "[[", 3);
	if (!nav.opened) {
		ctx.fail("`[[` popover opens", "No .suggestion-container after typing [[");
		return;
	}
	console.log("  Index desync table (`[[`):");
	nav.table.forEach((l) => console.log(l));
	// Read the highlighted item's true identity BEFORE Tab (selecting clears the list).
	const hi = await highlightedIdentity(page, "vault");
	console.log(`  Highlighted before Tab: display="${nav.highlightedText}" expectedToken=${hi.expectedToken} (idx ${hi.idx})`);

	await page.keyboard.press("Tab");
	await page.waitForTimeout(400);
	const inserted = await readToken(page, ".notor-wikilink-token");
	const shot = await ctx.screenshot("01-vault-tab");
	console.log(`  Inserted token after Tab: "${inserted}"`);

	const matches = !!inserted && !!hi.expectedToken && inserted === hi.expectedToken;
	if (matches) {
		ctx.pass(
			"`[[` Tab inserts the highlighted item",
			`Highlighted item idx ${hi.idx} (${hi.expectedToken}) → inserted "${inserted}"`,
			shot,
		);
	} else {
		ctx.fail(
			"`[[` Tab inserts the highlighted item",
			`BUG: highlighted idx ${hi.idx} (${hi.expectedToken}) but Tab inserted "${inserted}". Desync table above. ` +
				`shadow=${nav.initialInst.shadowSelectedIndex} vs domSel=${nav.initialDom.selectedDomIndex} at start.`,
			shot,
		);
	}
}

/** Test 2: Enter selects the highlighted item for `[[` (author's claim / native path). */
async function testVaultEnterSelects(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: `[[` Enter selects the highlighted item (native path)");
	const { page } = ctx;
	await resetInput(page);

	const nav = await navigateAndCapture(page, "vault", "[[", 3);
	if (!nav.opened) {
		ctx.fail("`[[` popover opens (Enter)", "No .suggestion-container after typing [[");
		return;
	}
	const hi = await highlightedIdentity(page, "vault");
	console.log(`  Highlighted before Enter: expectedToken=${hi.expectedToken} (idx ${hi.idx})`);

	await page.keyboard.press("Enter");
	await page.waitForTimeout(400);
	const inserted = await readToken(page, ".notor-wikilink-token");
	const shot = await ctx.screenshot("02-vault-enter");
	console.log(`  Inserted token after Enter: "${inserted}"`);

	const matches = !!inserted && !!hi.expectedToken && inserted === hi.expectedToken;
	if (matches) {
		ctx.pass("`[[` Enter inserts the highlighted item", `Highlighted idx ${hi.idx} (${hi.expectedToken}) → inserted "${inserted}"`, shot);
	} else {
		ctx.fail(
			"`[[` Enter inserts the highlighted item",
			`Enter did NOT match highlight: expected ${hi.expectedToken} (idx ${hi.idx}), inserted "${inserted}". ` +
				`If this fails, the author's premise (Enter works) does not hold in this Obsidian build.`,
			shot,
		);
	}
}

/** Test 3 + 4: mechanism-availability matrix (drives the implementation choice). */
async function testMechanismMatrix(ctx: TestContext): Promise<void> {
	console.log("\nTest 3/4: probe selection mechanisms (C = useSelectedItem, B = DOM is-selected)");
	const { page } = ctx;
	await resetInput(page);

	// Open `[[` and step down so the controller/DOM highlight is non-zero.
	const opened = await openSuggest(page, "[[");
	if (!opened) {
		ctx.fail("Mechanism probe: `[[` popover", "Popover did not open");
		return;
	}
	await page.keyboard.press("ArrowDown");
	await page.waitForTimeout(120);
	await page.keyboard.press("ArrowDown");
	await page.waitForTimeout(120);

	const inst = await probeInstance(page, "vault");
	const dom = await probeDom(page);
	console.log(`  instance probe: ${JSON.stringify(inst)}`);
	console.log(`  dom probe: selectedDomIndex=${dom.selectedDomIndex} itemCount=${dom.itemCount}`);

	// Mechanism C
	if (inst.reachable && inst.hasUseSelectedItem) {
		ctx.pass(
			"Mechanism C available (useSelectedItem)",
			`suggestions.useSelectedItem is a function; controllerSelectedItem=${inst.controllerSelectedItem} tracked arrows (domSel=${dom.selectedDomIndex})`,
		);
	} else {
		ctx.fail(
			"Mechanism C available (useSelectedItem)",
			`Not present: reachable=${inst.reachable}, hasController=${inst.hasController}, hasUseSelectedItem=${inst.hasUseSelectedItem}. Will need Mechanism B.`,
		);
	}

	// Mechanism B: DOM highlight advanced and count matches currentSuggestions
	const bViable = dom.hasContainer && dom.selectedDomIndex >= 0 && dom.itemCount === inst.currentLen;
	if (bViable) {
		ctx.pass(
			"Mechanism B available (DOM is-selected)",
			`.is-selected at index ${dom.selectedDomIndex}; itemCount ${dom.itemCount} === currentSuggestions ${inst.currentLen}`,
		);
	} else {
		ctx.fail(
			"Mechanism B available (DOM is-selected)",
			`DOM fallback shaky: hasContainer=${dom.hasContainer}, selectedDomIndex=${dom.selectedDomIndex}, itemCount=${dom.itemCount}, currentLen=${inst.currentLen}`,
		);
	}
	await resetInput(page);
}

/** Test 5: `/` workflow suggester — Tab repro + Enter confirmation. */
async function testWorkflowSuggest(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: `/` workflow suggester — Tab repro + Enter confirmation");
	const { page } = ctx;
	await resetInput(page);

	// Open `/` and wait for workflow discovery to populate (>=2 results).
	await page.focus(".notor-text-input");
	await page.keyboard.type("/");
	let ready = false;
	for (let i = 0; i < 20; i++) {
		await page.waitForTimeout(500);
		const inst = await probeInstance(page, "workflow");
		if (inst.reachable && (inst.currentLen ?? 0) >= 2) { ready = true; break; }
	}
	if (!ready) {
		const shot = await ctx.screenshot("05-workflow-not-ready");
		ctx.fail("`/` workflow popover populated", "Fewer than 2 workflows discovered after typing /", shot);
		await resetInput(page);
		return;
	}
	await waitForSelector(page, ".suggestion-container .suggestion-item", 3_000);

	// Tab path
	await page.keyboard.press("ArrowDown");
	await page.waitForTimeout(120);
	await page.keyboard.press("ArrowDown");
	await page.waitForTimeout(120);
	const hiTab = await highlightedIdentity(page, "workflow");
	console.log(`  Highlighted before Tab (slash): expectedToken=${hiTab.expectedToken} (idx ${hiTab.idx})`);
	await page.keyboard.press("Tab");
	await page.waitForTimeout(400);
	const insertedTab = await readToken(page, ".notor-workflow-token");
	const shotTab = await ctx.screenshot("05-workflow-tab");
	console.log(`  Inserted token after Tab (slash): "${insertedTab}"`);

	const tabMatches = !!insertedTab && !!hiTab.expectedToken && insertedTab === hiTab.expectedToken;
	if (tabMatches) {
		ctx.pass("`/` Tab inserts the highlighted workflow", `Highlighted idx ${hiTab.idx} (${hiTab.expectedToken}) → inserted "${insertedTab}"`, shotTab);
	} else {
		ctx.fail(
			"`/` Tab inserts the highlighted workflow",
			`BUG: highlighted idx ${hiTab.idx} (${hiTab.expectedToken}) but Tab inserted "${insertedTab}".`,
			shotTab,
		);
	}

	// Enter path (fresh)
	await resetInput(page);
	await page.focus(".notor-text-input");
	await page.keyboard.type("/");
	await waitForSelector(page, ".suggestion-container .suggestion-item", 3_000);
	await page.keyboard.press("ArrowDown");
	await page.waitForTimeout(120);
	await page.keyboard.press("ArrowDown");
	await page.waitForTimeout(120);
	const hiEnter = await highlightedIdentity(page, "workflow");
	console.log(`  Highlighted before Enter (slash): expectedToken=${hiEnter.expectedToken} (idx ${hiEnter.idx})`);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(400);
	const insertedEnter = await readToken(page, ".notor-workflow-token");
	const shotEnter = await ctx.screenshot("05-workflow-enter");
	console.log(`  Inserted token after Enter (slash): "${insertedEnter}"`);

	const enterMatches = !!insertedEnter && !!hiEnter.expectedToken && insertedEnter === hiEnter.expectedToken;
	if (enterMatches) {
		ctx.pass("`/` Enter inserts the highlighted workflow", `Highlighted idx ${hiEnter.idx} (${hiEnter.expectedToken}) → inserted "${insertedEnter}"`, shotEnter);
	} else {
		ctx.fail("`/` Enter inserts the highlighted workflow", `Enter mismatch: expected ${hiEnter.expectedToken} (idx ${hiEnter.idx}), inserted "${insertedEnter}".`, shotEnter);
	}
	await resetInput(page);
}

/** Test 6: send-safety — Tab with a popover open must NOT send a message. */
async function testTabDoesNotSend(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: Tab with popover open does not trigger message send");
	const { page } = ctx;
	await resetInput(page);

	const beforeCount = await page.evaluate(() => document.querySelectorAll(".notor-message-user").length);

	const opened = await openSuggest(page, "[[");
	if (!opened) {
		ctx.fail("Send-safety: `[[` popover", "Popover did not open");
		return;
	}
	await page.keyboard.press("ArrowDown");
	await page.waitForTimeout(120);
	await page.keyboard.press("Tab");
	await page.waitForTimeout(600);

	const afterCount = await page.evaluate(() => document.querySelectorAll(".notor-message-user").length);
	const responding = await page.evaluate(() => {
		const stop = document.querySelector(".notor-stop-btn");
		return !!stop && !stop.classList.contains("notor-hidden");
	});
	const shot = await ctx.screenshot("06-send-safety");

	if (afterCount === beforeCount && !responding) {
		ctx.pass("Tab does not send a message", `User message count unchanged (${beforeCount}); not in responding state`, shot);
	} else {
		ctx.fail(
			"Tab does not send a message",
			`REGRESSION RISK: user messages ${beforeCount}→${afterCount}, responding=${responding}. Tab fell through to send.`,
			shot,
		);
	}
	await resetInput(page);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(6_000); // plugin init

	const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chat) {
		ctx.fail("Plugin loaded", ".notor-chat-container not found");
		return;
	}
	await ensureCleanState(page);

	await testVaultTabRepro(ctx);
	await testVaultEnterSelects(ctx);
	await testMechanismMatrix(ctx);
	await testWorkflowSuggest(ctx);
	await testTabDoesNotSend(ctx);
}

// ---------------------------------------------------------------------------
// Config & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({ mode: "plan" });

runTest(
	{
		name: "tab-completion-highlight-test",
		settings,
		setupVault: (vaultPath) => {
			// Single clean chat panel or the container won't mount (deferred views).
			writeCleanWorkspace(vaultPath);

			// Vault-root notes so `[[` yields multiple ranked results.
			for (const name of NOTE_NAMES) {
				fs.writeFileSync(path.join(vaultPath, `${name}.md`), `# ${name}\n\nBody of ${name}.\n`);
			}

			// Workflows so `/` yields multiple results.
			const workflowsDir = path.join(vaultPath, "notor", "workflows");
			fs.mkdirSync(workflowsDir, { recursive: true });
			for (const name of WORKFLOW_NAMES) {
				fs.writeFileSync(
					path.join(workflowsDir, `${name}.md`),
					`---\nnotor-workflow: true\nnotor-trigger: manual\n---\n\nYou are the ${name} workflow. Reply with one short sentence.\n`,
				);
			}
			console.log(`  Created ${NOTE_NAMES.length} notes and ${WORKFLOW_NAMES.length} workflows.`);
		},
		cleanupFiles: [
			...NOTE_NAMES.map((n) => `${n}.md`),
			...WORKFLOW_NAMES.map((n) => `notor/workflows/${n}.md`),
		],
	},
	tests,
);
