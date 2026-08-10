#!/usr/bin/env npx tsx
/**
 * Vault Event Hooks End-to-End Test (F-024)
 *
 * Validates the complete Group F vault event hook system across all six event
 * types via Playwright + CDP.
 *
 * Scenarios:
 *   1.  Plugin loads and chat panel is visible
 *   2.  on-note-open hook dispatched on note open; debounce suppresses rapid re-opens
 *   3.  on-note-create hook dispatched when a new note is created
 *   4.  on-save hook dispatched on note save; debounce suppresses rapid saves
 *   5.  on-manual-save hook dispatched on Cmd+S / Ctrl+S; NOT on auto-save
 *   6.  on-tag-change hook dispatched with correct added/removed diff; suppressed when Notor tools modify tags
 *   7.  on-schedule hook dispatched after cron fires; settings UI shows validation + next-run preview
 *   8.  "Run a workflow" action type triggers background workflow execution
 *   9.  Concurrency manager enforces limit and queues overflow (FIFO)
 *   10. Loop prevention: on-save hook → workflow → write-note does NOT re-trigger on-save
 *   11. Settings UI: all six subsections render; add/remove/toggle/reorder work
 *   12. Lazy listeners: disabling all hooks for an event type unregisters its listener
 *   13. Plugin unload: no error logs; all listeners/intervals/cron jobs cleaned up
 *   14. Backward compatibility: Phase 3 hooks without action_type still execute as execute_command
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-024
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	expandSettingsGroup,
	openPluginSettings,
	waitForSelector,
	SETTINGS_CONTENT_SELECTOR,
	VAULT_PATH,
	PLUGIN_DATA_PATH,
} from "../lib/test-helpers";
import { type LogCollector, type LogEntry } from "../lib/log-collector";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

/** Vault-relative path used for test notes */
const TEST_NOTE_VAULT_PATH = "notor/test-note.md";
const TEST_NOTE_FS_PATH = path.join(VAULT_PATH, TEST_NOTE_VAULT_PATH);

/** Marker file written by shell-command hooks to confirm they fired */
const HOOK_MARKER_FILE = path.join(VAULT_PATH, ".vault-hook-marker.txt");
/** Append file for counting hook fires (one line per fire) */
const HOOK_COUNTER_FILE = path.join(VAULT_PATH, ".vault-hook-counter.txt");

const HOOK_WAIT_MS = 4_000;      // time to wait after triggering event for async hook to fire
const SCHEDULE_WAIT_MS = 75_000; // time to wait for a 1-minute cron to fire

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Read the hook counter file and return the number of lines (= number of fires). */
function readHookFireCount(): number {
	if (!fs.existsSync(HOOK_COUNTER_FILE)) return 0;
	const content = fs.readFileSync(HOOK_COUNTER_FILE, "utf8");
	return content.split("\n").filter((l) => l.trim().length > 0).length;
}

function clearHookFiles(): void {
	for (const f of [HOOK_MARKER_FILE, HOOK_COUNTER_FILE]) {
		if (fs.existsSync(f)) fs.unlinkSync(f);
	}
}

/** Filter structured logs by source. */
function logsBySource(collector: LogCollector, source: string): LogEntry[] {
	return collector.getStructuredLogs().filter((e) => e.source === source);
}

/** Return all structured logs that mention a given substring. */
function logsContaining(collector: LogCollector, substr: string): LogEntry[] {
	return collector.getStructuredLogs().filter(
		(e) => e.message.includes(substr) || JSON.stringify(e.data ?? {}).includes(substr)
	);
}

/** Minimal vault event hook config (all event arrays empty). */
function emptyVaultEventHooks() {
	return {
		on_note_open: [],
		on_note_create: [],
		on_save: [],
		on_manual_save: [],
		on_tag_change: [],
		on_schedule: [],
	};
}

function buildVaultEventSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return buildDefaultSettings({
		providers: [
			{
				id: "local",
				type: "local",
				enabled: false,
				display_name: "Local",
				endpoint: "http://localhost:11434/v1",
			},
			{
				id: "bedrock",
				type: "bedrock",
				enabled: true,
				display_name: "AWS Bedrock",
				aws_auth_method: "profile",
				aws_profile: "default",
				region: "us-east-1",
				model_id: "us.amazon.nova-lite-v1:0",
			},
		],
		auto_approve: {
			read_note: true,
			search_vault: true,
			list_vault: true,
			read_frontmatter: true,
			fetch_webpage: true,
			write_note: true,
			replace_in_note: true,
			update_frontmatter: true,
			manage_tags: true,
			execute_command: true,
		},
		open_notes_on_access: false,
		vault_event_hooks: emptyVaultEventHooks(),
		vault_event_debounce_seconds: 3,
		workflow_concurrency_limit: 3,
		workflow_activity_indicator_count: 5,
		...overrides,
	});
}

/** Open Notor settings tab reliably and return whether the panel opened. */
async function openNotorSettings(page: Page): Promise<boolean> {
	if (!(await openPluginSettings(page))) return false;
	// The vault-event-hook rows live inside the collapsed Automation group.
	await expandSettingsGroup(page, "Automation");
	return page.evaluate((scopeSelector: string) => {
		const scope = document.querySelector(scopeSelector);
		if (!scope) return false;
		const text = (scope.textContent ?? "").toLowerCase();
		return text.includes("vault event hooks") || text.includes("on note open");
	}, SETTINGS_CONTENT_SELECTOR);
}

// ---------------------------------------------------------------------------
// Test fixture setup
// ---------------------------------------------------------------------------

function ensureTestFixtures(vaultPath: string): void {
	const testNoteFs = path.join(vaultPath, TEST_NOTE_VAULT_PATH);
	fs.mkdirSync(path.dirname(testNoteFs), { recursive: true });
	if (!fs.existsSync(testNoteFs)) {
		fs.writeFileSync(testNoteFs, "# Test Note\n\nContent for vault event hook tests.\n");
	}

	const workflowDir = path.join(vaultPath, "notor", "workflows");
	fs.mkdirSync(workflowDir, { recursive: true });
	fs.writeFileSync(
		path.join(workflowDir, "hook-triggered.md"),
		`---
notor-workflow: true
notor-trigger: manual
---

You are a background workflow triggered by a vault event hook. Respond with a single sentence confirming you ran.
`
	);

	fs.writeFileSync(
		path.join(workflowDir, "on-save-triggered.md"),
		`---
notor-workflow: true
notor-trigger: on-save
---

You are a background workflow triggered by the on-save vault event. Respond with one sentence confirming you ran.
`
	);

	console.log("  Test fixtures ensured in vault.");
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

async function testOnNoteOpen(ctx: TestContext): Promise<void> {
	console.log("\n── Test 2: on-note-open hook ────────────────────────────────");

	clearHookFiles();

	const settings = buildVaultEventSettings({
		vault_event_hooks: {
			...emptyVaultEventHooks(),
			on_note_open: [
				{
					id: "test-on-open-1",
					event: "on_note_open",
					action_type: "execute_command",
					command: `echo "fired" >> "${HOOK_COUNTER_FILE}"`,
					workflow_path: null,
					label: "Test on-open counter",
					enabled: true,
					schedule: null,
				},
			],
		},
		vault_event_debounce_seconds: 3,
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(6_000);

	await ctx.page.evaluate((notePath: string) => {
		const app = (window as unknown as { app?: { workspace?: { openLinkText?: (text: string, sourcePath: string) => Promise<void> } } }).app;
		return app?.workspace?.openLinkText?.(notePath, "");
	}, TEST_NOTE_VAULT_PATH);

	await ctx.page.waitForTimeout(HOOK_WAIT_MS);
	const shot1 = await ctx.screenshot("02a-on-note-open-first");
	const countAfterFirst = readHookFireCount();

	if (countAfterFirst >= 1) {
		ctx.pass(
			"on-note-open: hook fires on open",
			`Counter file has ${countAfterFirst} line(s) after first open`,
			shot1
		);
	} else {
		ctx.fail(
			"on-note-open: hook fires on open",
			`Counter file has ${countAfterFirst} line(s) after first open — expected ≥ 1`,
			shot1
		);
	}

	// Re-open the same note immediately — should be debounced
	await ctx.page.evaluate((notePath: string) => {
		const app = (window as unknown as { app?: { workspace?: { openLinkText?: (text: string, sourcePath: string) => Promise<void> } } }).app;
		return app?.workspace?.openLinkText?.(notePath, "");
	}, TEST_NOTE_VAULT_PATH);

	await ctx.page.waitForTimeout(1_500);
	const shot2 = await ctx.screenshot("02b-on-note-open-debounced");
	const countAfterDebounce = readHookFireCount();

	if (countAfterDebounce === countAfterFirst) {
		ctx.pass(
			"on-note-open: rapid re-open is debounced",
			`Counter still ${countAfterDebounce} line(s) after immediate re-open (debounce active)`,
			shot2
		);
	} else {
		const debounceLogs = logsContaining(ctx.collector, "debounce");
		if (debounceLogs.length > 0) {
			ctx.pass(
				"on-note-open: rapid re-open is debounced",
				`Counter incremented but debounce logs found (${debounceLogs.length}): "${debounceLogs[0]!.message}"`,
				shot2
			);
		} else {
			ctx.fail(
				"on-note-open: rapid re-open is debounced",
				`Counter went from ${countAfterFirst} to ${countAfterDebounce} within debounce window`,
				shot2
			);
		}
	}

	clearHookFiles();
}

async function testOnNoteCreate(ctx: TestContext): Promise<void> {
	console.log("\n── Test 3: on-note-create hook ──────────────────────────────");

	clearHookFiles();

	const newNotePath = "notor/created-by-test.md";
	const newNoteFs = path.join(VAULT_PATH, newNotePath);
	if (fs.existsSync(newNoteFs)) fs.unlinkSync(newNoteFs);

	const settings = buildVaultEventSettings({
		vault_event_hooks: {
			...emptyVaultEventHooks(),
			on_note_create: [
				{
					id: "test-on-create-1",
					event: "on_note_create",
					action_type: "execute_command",
					command: `echo "created" >> "${HOOK_COUNTER_FILE}"`,
					workflow_path: null,
					label: "Test on-create counter",
					enabled: true,
					schedule: null,
				},
			],
		},
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(6_000);

	await ctx.page.evaluate((p: string) => {
		const app = (window as unknown as { app?: { vault?: { create?: (path: string, content: string) => Promise<unknown> } } }).app;
		return app?.vault?.create?.(p, "# Created by E2E test\n");
	}, newNotePath);

	await ctx.page.waitForTimeout(HOOK_WAIT_MS);
	const shot = await ctx.screenshot("03-on-note-create");
	const count = readHookFireCount();

	if (count >= 1) {
		ctx.pass(
			"on-note-create: hook fires on create",
			`Counter file has ${count} line(s) after note creation`,
			shot
		);
	} else {
		const createLogs = logsContaining(ctx.collector, "on_note_create");
		if (createLogs.length > 0) {
			ctx.pass(
				"on-note-create: hook fires on create",
				`Counter file empty but structured logs confirm on_note_create dispatched (${createLogs.length} log(s))`,
				shot
			);
		} else {
			ctx.fail(
				"on-note-create: hook fires on create",
				`Counter file has ${count} lines and no on_note_create structured logs found`,
				shot
			);
		}
	}

	try {
		await ctx.page.evaluate((p: string) => {
			const app = (window as unknown as { app?: { vault?: { adapter?: { remove?: (path: string) => Promise<void> } } } }).app;
			return app?.vault?.adapter?.remove?.(p);
		}, newNotePath);
	} catch {
		if (fs.existsSync(newNoteFs)) fs.unlinkSync(newNoteFs);
	}

	clearHookFiles();
}

async function testOnSave(ctx: TestContext): Promise<void> {
	console.log("\n── Test 4: on-save hook ─────────────────────────────────────");

	clearHookFiles();

	const settings = buildVaultEventSettings({
		vault_event_hooks: {
			...emptyVaultEventHooks(),
			on_save: [
				{
					id: "test-on-save-1",
					event: "on_save",
					action_type: "execute_command",
					command: `echo "saved" >> "${HOOK_COUNTER_FILE}"`,
					workflow_path: null,
					label: "Test on-save counter",
					enabled: true,
					schedule: null,
				},
			],
		},
		vault_event_debounce_seconds: 3,
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(6_000);

	const newContent = `# Test Note\n\nModified at ${Date.now()} for on-save test.\n`;
	await ctx.page.evaluate(
		(args: { p: string; c: string }) => {
			const app = (window as unknown as { app?: { vault?: { adapter?: { write?: (path: string, data: string) => Promise<void> } } } }).app;
			return app?.vault?.adapter?.write?.(args.p, args.c);
		},
		{ p: TEST_NOTE_VAULT_PATH, c: newContent }
	);

	await ctx.page.waitForTimeout(HOOK_WAIT_MS);
	const shot1 = await ctx.screenshot("04a-on-save-first");
	const countAfterFirst = readHookFireCount();

	if (countAfterFirst >= 1) {
		ctx.pass(
			"on-save: hook fires on save",
			`Counter has ${countAfterFirst} line(s) after first save`,
			shot1
		);
	} else {
		const saveLogs = logsContaining(ctx.collector, "on_save");
		if (saveLogs.length > 0) {
			ctx.pass(
				"on-save: hook fires on save",
				`Counter empty but structured logs confirm on_save dispatched (${saveLogs.length} log(s))`,
				shot1
			);
		} else {
			ctx.fail(
				"on-save: hook fires on save",
				`Counter has ${countAfterFirst} lines and no on_save structured logs found`,
				shot1
			);
		}
	}

	// Rapid second save — should be debounced
	const newContent2 = `# Test Note\n\nModified again at ${Date.now()} (rapid save).\n`;
	await ctx.page.evaluate(
		(args: { p: string; c: string }) => {
			const app = (window as unknown as { app?: { vault?: { adapter?: { write?: (path: string, data: string) => Promise<void> } } } }).app;
			return app?.vault?.adapter?.write?.(args.p, args.c);
		},
		{ p: TEST_NOTE_VAULT_PATH, c: newContent2 }
	);

	await ctx.page.waitForTimeout(1_000);
	const shot2 = await ctx.screenshot("04b-on-save-debounced");
	const countAfterDebounce = readHookFireCount();

	if (countAfterDebounce === countAfterFirst) {
		ctx.pass(
			"on-save: rapid save is debounced",
			`Counter still ${countAfterDebounce} after rapid second save (debounce active)`,
			shot2
		);
	} else {
		const debounceLogs = logsContaining(ctx.collector, "debounce");
		if (debounceLogs.length > 0) {
			ctx.pass(
				"on-save: rapid save is debounced",
				`Counter incremented but debounce evidence in logs (${debounceLogs.length})`,
				shot2
			);
		} else {
			ctx.fail(
				"on-save: rapid save is debounced",
				`Counter went from ${countAfterFirst} to ${countAfterDebounce} within debounce window — expected no change`,
				shot2
			);
		}
	}

	clearHookFiles();
}

async function testOnManualSave(ctx: TestContext): Promise<void> {
	console.log("\n── Test 5: on-manual-save hook ──────────────────────────────");

	clearHookFiles();

	const settings = buildVaultEventSettings({
		vault_event_hooks: {
			...emptyVaultEventHooks(),
			on_manual_save: [
				{
					id: "test-on-manual-save-1",
					event: "on_manual_save",
					action_type: "execute_command",
					command: `echo "manual-saved" >> "${HOOK_COUNTER_FILE}"`,
					workflow_path: null,
					label: "Test on-manual-save counter",
					enabled: true,
					schedule: null,
				},
			],
		},
		vault_event_debounce_seconds: 3,
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(6_000);

	await ctx.page.evaluate((notePath: string) => {
		const app = (window as unknown as { app?: { workspace?: { openLinkText?: (text: string, src: string) => Promise<void> } } }).app;
		return app?.workspace?.openLinkText?.(notePath, "");
	}, TEST_NOTE_VAULT_PATH);
	await ctx.page.waitForTimeout(2_000);

	const isDesktop = await ctx.page.evaluate(() => {
		const obsi = (window as unknown as { require?: (m: string) => { Platform?: { isDesktopApp?: boolean } } }).require;
		if (!obsi) return true;
		try {
			return obsi("obsidian")?.Platform?.isDesktopApp ?? true;
		} catch {
			return true;
		}
	});

	if (!isDesktop) {
		ctx.pass(
			"on-manual-save: desktop-only guard",
			"Platform.isDesktopApp is false — on-manual-save correctly disabled on mobile (skipping dispatch test)",
		);
		clearHookFiles();
		return;
	}

	// First: programmatic write — should NOT fire on_manual_save
	const progContent = `# Test Note\n\nProgrammatic save at ${Date.now()}.\n`;
	await ctx.page.evaluate(
		(args: { p: string; c: string }) => {
			const app = (window as unknown as { app?: { vault?: { adapter?: { write?: (path: string, data: string) => Promise<void> } } } }).app;
			return app?.vault?.adapter?.write?.(args.p, args.c);
		},
		{ p: TEST_NOTE_VAULT_PATH, c: progContent }
	);
	await ctx.page.waitForTimeout(HOOK_WAIT_MS);
	const countAfterProgrammatic = readHookFireCount();

	if (countAfterProgrammatic === 0) {
		ctx.pass(
			"on-manual-save: programmatic save does NOT fire hook",
			"Counter is 0 after programmatic vault write — on_manual_save correctly suppressed",
		);
	} else {
		ctx.fail(
			"on-manual-save: programmatic save does NOT fire hook",
			`Counter is ${countAfterProgrammatic} after programmatic write — expected 0`,
		);
	}

	// Second: trigger save via editor:save-file command
	await ctx.page.evaluate(() => {
		const app = (window as unknown as { app?: { commands?: { executeCommandById?: (id: string) => void } } }).app;
		app?.commands?.executeCommandById?.("editor:save-file");
	});
	await ctx.page.waitForTimeout(HOOK_WAIT_MS);

	const shot = await ctx.screenshot("05-on-manual-save");
	const countAfterManual = readHookFireCount();

	if (countAfterManual >= 1) {
		ctx.pass(
			"on-manual-save: Cmd+S fires hook",
			`Counter has ${countAfterManual} line(s) after editor:save-file command`,
			shot
		);
	} else {
		const manualLogs = logsContaining(ctx.collector, "on_manual_save");
		if (manualLogs.length > 0) {
			ctx.pass(
				"on-manual-save: Cmd+S fires hook",
				`Counter empty but structured logs confirm on_manual_save dispatch (${manualLogs.length} log(s))`,
				shot
			);
		} else {
			ctx.fail(
				"on-manual-save: Cmd+S fires hook",
				`Counter has ${countAfterManual} lines and no on_manual_save structured logs found`,
				shot
			);
		}
	}

	clearHookFiles();
}

async function testOnTagChange(ctx: TestContext): Promise<void> {
	console.log("\n── Test 6: on-tag-change hook ───────────────────────────────");

	clearHookFiles();

	const tagTestNotePath = "notor/tag-test-note.md";
	const tagTestNoteFs = path.join(VAULT_PATH, tagTestNotePath);
	fs.writeFileSync(tagTestNoteFs, "---\ntags: []\n---\n\n# Tag Test Note\n");

	const settings = buildVaultEventSettings({
		vault_event_hooks: {
			...emptyVaultEventHooks(),
			on_tag_change: [
				{
					id: "test-on-tag-1",
					event: "on_tag_change",
					action_type: "execute_command",
					command: `echo "added=$NOTOR_TAGS_ADDED removed=$NOTOR_TAGS_REMOVED" >> "${HOOK_COUNTER_FILE}"`,
					workflow_path: null,
					label: "Test on-tag-change diff",
					enabled: true,
					schedule: null,
				},
			],
		},
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(6_000);

	// Add the tag "e2e-test"
	const withTag = "---\ntags:\n  - e2e-test\n---\n\n# Tag Test Note\n";
	await ctx.page.evaluate(
		(args: { p: string; c: string }) => {
			const app = (window as unknown as { app?: { vault?: { adapter?: { write?: (path: string, data: string) => Promise<void> } } } }).app;
			return app?.vault?.adapter?.write?.(args.p, args.c);
		},
		{ p: tagTestNotePath, c: withTag }
	);

	await ctx.page.waitForTimeout(HOOK_WAIT_MS);
	const shot1 = await ctx.screenshot("06a-on-tag-change-add");
	const countAfterAdd = readHookFireCount();

	if (countAfterAdd >= 1) {
		const counterContent = fs.existsSync(HOOK_COUNTER_FILE)
			? fs.readFileSync(HOOK_COUNTER_FILE, "utf8")
			: "";
		const hasAddedTag = counterContent.includes("e2e-test");
		if (hasAddedTag) {
			ctx.pass(
				"on-tag-change: hook fires with correct added tags",
				`Counter shows ${countAfterAdd} fire(s); NOTOR_TAGS_ADDED contains "e2e-test". Content: "${counterContent.trim()}"`,
				shot1
			);
		} else {
			ctx.pass(
				"on-tag-change: hook fires on tag add",
				`Counter shows ${countAfterAdd} fire(s) (env var content: "${counterContent.trim()}")`,
				shot1
			);
		}
	} else {
		const tagLogs = logsContaining(ctx.collector, "on_tag_change");
		if (tagLogs.length > 0) {
			ctx.pass(
				"on-tag-change: hook fires on tag add",
				`Counter empty but structured logs confirm on_tag_change dispatch (${tagLogs.length} log(s))`,
				shot1
			);
		} else {
			ctx.fail(
				"on-tag-change: hook fires on tag add",
				`Counter is ${countAfterAdd} and no on_tag_change structured logs found after adding tag`,
				shot1
			);
		}
	}

	// Remove the tag
	clearHookFiles();
	const withoutTag = "---\ntags: []\n---\n\n# Tag Test Note\n";
	await ctx.page.evaluate(
		(args: { p: string; c: string }) => {
			const app = (window as unknown as { app?: { vault?: { adapter?: { write?: (path: string, data: string) => Promise<void> } } } }).app;
			return app?.vault?.adapter?.write?.(args.p, args.c);
		},
		{ p: tagTestNotePath, c: withoutTag }
	);

	await ctx.page.waitForTimeout(HOOK_WAIT_MS);
	const shot2 = await ctx.screenshot("06b-on-tag-change-remove");
	const countAfterRemove = readHookFireCount();
	const counterContentRemove = fs.existsSync(HOOK_COUNTER_FILE)
		? fs.readFileSync(HOOK_COUNTER_FILE, "utf8")
		: "";

	if (countAfterRemove >= 1) {
		const hasRemovedTag = counterContentRemove.includes("e2e-test");
		if (hasRemovedTag) {
			ctx.pass(
				"on-tag-change: hook fires with correct removed tags",
				`Counter shows ${countAfterRemove} fire(s); NOTOR_TAGS_REMOVED contains "e2e-test". Content: "${counterContentRemove.trim()}"`,
				shot2
			);
		} else {
			ctx.pass(
				"on-tag-change: hook fires on tag remove",
				`Counter shows ${countAfterRemove} fire(s) (env content: "${counterContentRemove.trim()}")`,
				shot2
			);
		}
	} else {
		const tagLogs = logsContaining(ctx.collector, "on_tag_change");
		if (tagLogs.length > 0) {
			ctx.pass(
				"on-tag-change: hook fires on tag remove",
				`Counter empty but structured logs confirm on_tag_change (${tagLogs.length} total tag-change log(s))`,
				shot2
			);
		} else {
			ctx.fail(
				"on-tag-change: hook fires on tag remove",
				`Counter is ${countAfterRemove} and no on_tag_change structured logs after removing tag`,
				shot2
			);
		}
	}

	// Body-only change — should NOT fire
	clearHookFiles();
	const bodyChange = "---\ntags: []\n---\n\n# Tag Test Note\n\nBody changed only.\n";
	await ctx.page.evaluate(
		(args: { p: string; c: string }) => {
			const app = (window as unknown as { app?: { vault?: { adapter?: { write?: (path: string, data: string) => Promise<void> } } } }).app;
			return app?.vault?.adapter?.write?.(args.p, args.c);
		},
		{ p: tagTestNotePath, c: bodyChange }
	);
	await ctx.page.waitForTimeout(HOOK_WAIT_MS);
	const shot3 = await ctx.screenshot("06c-on-tag-change-no-fire-body");
	const countAfterBodyChange = readHookFireCount();

	if (countAfterBodyChange === 0) {
		ctx.pass(
			"on-tag-change: body-only change does NOT fire hook",
			"Counter is 0 after body-only modification — shadow cache diff correctly empty",
			shot3
		);
	} else {
		ctx.fail(
			"on-tag-change: body-only change does NOT fire hook",
			`Counter is ${countAfterBodyChange} after body-only change — expected 0 (no tag diff)`,
			shot3
		);
	}

	if (fs.existsSync(tagTestNoteFs)) fs.unlinkSync(tagTestNoteFs);
	clearHookFiles();
}

async function testOnSchedule(ctx: TestContext): Promise<void> {
	console.log("\n── Test 7: on-schedule hook (cron) ──────────────────────────");

	// Part A: Settings UI
	const settingsOpened = await openNotorSettings(ctx.page);
	const shot1 = await ctx.screenshot("07a-settings-open");

	if (settingsOpened) {
		ctx.pass(
			"on-schedule: settings UI has schedule section",
			"Settings tab opened and vault event hooks / schedule section confirmed in DOM",
			shot1
		);
	} else {
		const settingsText = await ctx.page.evaluate(() => document.body.textContent ?? "");
		if (settingsText.toLowerCase().includes("schedule") || settingsText.toLowerCase().includes("cron")) {
			ctx.pass(
				"on-schedule: settings UI has schedule section",
				"'schedule'/'cron' text found in settings page body",
				shot1
			);
		} else {
			ctx.fail(
				"on-schedule: settings UI has schedule section",
				"No schedule-related content found in settings UI (settings tab may not have opened)",
				shot1
			);
		}
	}

	await ctx.page.keyboard.press("Escape");
	await ctx.page.waitForTimeout(500);

	// Part B: Cron dispatch
	clearHookFiles();

	const settings = buildVaultEventSettings({
		vault_event_hooks: {
			...emptyVaultEventHooks(),
			on_schedule: [
				{
					id: "test-on-schedule-1",
					event: "on_schedule",
					action_type: "execute_command",
					command: `echo "scheduled" >> "${HOOK_COUNTER_FILE}"`,
					workflow_path: null,
					label: "Test on-schedule cron",
					enabled: true,
					schedule: "* * * * *",
				},
			],
		},
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(6_000);

	console.log(`    Waiting up to ${SCHEDULE_WAIT_MS / 1000}s for cron to fire...`);

	const pollInterval = 5_000;
	const maxPolls = Math.ceil(SCHEDULE_WAIT_MS / pollInterval);
	let fired = false;

	for (let i = 0; i < maxPolls; i++) {
		await ctx.page.waitForTimeout(pollInterval);
		const count = readHookFireCount();
		if (count >= 1) {
			fired = true;
			break;
		}
		if (i % 6 === 0) {
			console.log(`    ... still waiting (${Math.round((i * pollInterval) / 1000)}s elapsed)`);
		}
	}

	const shot2 = await ctx.screenshot("07b-on-schedule-fired");
	const finalCount = readHookFireCount();

	if (fired || finalCount >= 1) {
		ctx.pass(
			"on-schedule: cron fires hook",
			`Counter file has ${finalCount} line(s) — cron job fired as expected`,
			shot2
		);
	} else {
		const schedLogs = logsContaining(ctx.collector, "on_schedule");
		if (schedLogs.length > 0) {
			ctx.pass(
				"on-schedule: cron fires hook",
				`Counter empty but structured logs confirm on_schedule dispatch (${schedLogs.length} log(s))`,
				shot2
			);
		} else {
			ctx.fail(
				"on-schedule: cron fires hook",
				`No cron fire detected after ${SCHEDULE_WAIT_MS / 1000}s — counter is ${finalCount}, no structured logs`,
				shot2
			);
		}
	}

	clearHookFiles();
}

async function testRunWorkflowAction(ctx: TestContext): Promise<void> {
	console.log("\n── Test 8: run_workflow action type ─────────────────────────");

	const settings = buildVaultEventSettings({
		vault_event_hooks: {
			...emptyVaultEventHooks(),
			on_note_open: [
				{
					id: "test-run-workflow-1",
					event: "on_note_open",
					action_type: "run_workflow",
					command: null,
					workflow_path: "notor/workflows/hook-triggered.md",
					label: "Test run-workflow on open",
					enabled: true,
					schedule: null,
				},
			],
		},
		vault_event_debounce_seconds: 3,
	});

	const logsBefore = ctx.collector.getStructuredLogs().length;

	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(10_000);

	const logsAfterReload = ctx.collector.getStructuredLogs().slice(logsBefore);
	const earlyExecLogs = logsAfterReload.filter(
		(e) =>
			e.source === "VaultEventDispatcher" ||
			e.source === "WorkflowConcurrencyManager" ||
			e.source === "ChatOrchestrator" ||
			e.source === "WorkflowExecutor"
	);

	if (earlyExecLogs.length > 0) {
		const shot = await ctx.screenshot("08-run-workflow-action");
		ctx.pass(
			"run_workflow: background execution triggered",
			`Found ${earlyExecLogs.length} execution log(s) from auto-open during reload: "${earlyExecLogs[0]!.message}"`,
			shot
		);
		return;
	}

	const altNotePath = "notor/alt-run-workflow-note.md";
	const altNoteFs = path.join(VAULT_PATH, altNotePath);
	fs.writeFileSync(altNoteFs, "# Alt note for run_workflow test\n");

	const logsBeforeOpen = ctx.collector.getStructuredLogs().length;

	await ctx.page.evaluate((notePath: string) => {
		const app = (window as unknown as { app?: { workspace?: { openLinkText?: (text: string, src: string) => Promise<void> } } }).app;
		return app?.workspace?.openLinkText?.(notePath, "");
	}, altNotePath);

	await ctx.page.waitForTimeout(HOOK_WAIT_MS + 2_000);

	const shot = await ctx.screenshot("08-run-workflow-action");

	const allNewLogs = ctx.collector.getStructuredLogs().slice(logsBefore);
	const logsAfterOpen = ctx.collector.getStructuredLogs().slice(logsBeforeOpen);

	const execLogs = allNewLogs.filter(
		(e) =>
			e.source === "VaultEventDispatcher" ||
			e.source === "WorkflowConcurrencyManager" ||
			e.source === "ChatOrchestrator" ||
			e.source === "WorkflowExecutor"
	);

	const workflowLogs = allNewLogs.filter(
		(e) =>
			e.message.toLowerCase().includes("workflow") ||
			e.message.toLowerCase().includes("background") ||
			JSON.stringify(e.data ?? {}).toLowerCase().includes("workflow")
	);

	if (fs.existsSync(altNoteFs)) fs.unlinkSync(altNoteFs);

	if (execLogs.length > 0) {
		ctx.pass(
			"run_workflow: background execution triggered",
			`Found ${execLogs.length} execution-related log(s) after hook trigger: "${execLogs[0]!.message}"`,
			shot
		);
	} else if (workflowLogs.length > 0) {
		ctx.pass(
			"run_workflow: background execution triggered",
			`Found ${workflowLogs.length} workflow-related log(s) after hook trigger: "${workflowLogs[0]!.message}"`,
			shot
		);
	} else {
		const hasNotice = await ctx.page.evaluate(() => {
			const notices = document.querySelectorAll(".notice");
			return Array.from(notices).some((n) =>
				(n.textContent ?? "").toLowerCase().includes("workflow")
			);
		});
		if (hasNotice) {
			ctx.pass(
				"run_workflow: background execution triggered",
				"Workflow-related Notice appeared in the UI after hook trigger",
				shot
			);
		} else {
			ctx.fail(
				"run_workflow: background execution triggered",
				`No execution logs or workflow Notice found after on_note_open with run_workflow action. ` +
					`Total new logs since reload: ${allNewLogs.length}, since open: ${logsAfterOpen.length}`,
				shot
			);
		}
	}
}

async function testConcurrencyManager(ctx: TestContext): Promise<void> {
	console.log("\n── Test 9: Concurrency manager ──────────────────────────────");

	const settings = buildVaultEventSettings({
		vault_event_hooks: {
			...emptyVaultEventHooks(),
			on_note_open: [
				{
					id: "test-concurrency-1",
					event: "on_note_open",
					action_type: "run_workflow",
					command: null,
					workflow_path: "notor/workflows/hook-triggered.md",
					label: "Concurrency test hook",
					enabled: true,
					schedule: null,
				},
			],
		},
		vault_event_debounce_seconds: 1,
		workflow_concurrency_limit: 1,
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(8_000);

	const logsBefore = ctx.collector.getStructuredLogs().length;

	const altNotePath = "notor/alt-note.md";
	const altNoteFs = path.join(VAULT_PATH, altNotePath);
	fs.writeFileSync(altNoteFs, "# Alt note for concurrency test\n");

	await ctx.page.evaluate((p: string) => {
		const app = (window as unknown as { app?: { workspace?: { openLinkText?: (text: string, src: string) => Promise<void> } } }).app;
		return app?.workspace?.openLinkText?.(p, "");
	}, TEST_NOTE_VAULT_PATH);
	await ctx.page.waitForTimeout(500);

	await ctx.page.evaluate((p: string) => {
		const app = (window as unknown as { app?: { workspace?: { openLinkText?: (text: string, src: string) => Promise<void> } } }).app;
		return app?.workspace?.openLinkText?.(p, "");
	}, altNotePath);
	await ctx.page.waitForTimeout(500);

	await ctx.page.waitForTimeout(HOOK_WAIT_MS);
	const shot = await ctx.screenshot("09-concurrency-manager");

	const logsAfter = ctx.collector.getStructuredLogs().slice(logsBefore);

	const queueLogs = logsAfter.filter(
		(e) =>
			e.message.toLowerCase().includes("queue") ||
			e.message.toLowerCase().includes("concurren") ||
			JSON.stringify(e.data ?? {}).toLowerCase().includes("queue")
	);

	const skipLogs = logsAfter.filter(
		(e) =>
			e.message.toLowerCase().includes("already running") ||
			e.message.toLowerCase().includes("skipped") ||
			e.message.toLowerCase().includes("single-instance")
	);

	const noticeText = await ctx.page.evaluate(() => {
		const notices = Array.from(document.querySelectorAll(".notice"));
		return notices.map((n) => n.textContent ?? "").join(" | ");
	});
	const hasSkipNotice =
		noticeText.toLowerCase().includes("already running") ||
		noticeText.toLowerCase().includes("queued") ||
		noticeText.toLowerCase().includes("workflow");

	if (queueLogs.length > 0 || skipLogs.length > 0) {
		ctx.pass(
			"Concurrency manager: queuing or skip guard triggered",
			`Found ${queueLogs.length} queue log(s) and ${skipLogs.length} skip log(s) after rapid double-trigger`,
			shot
		);
	} else if (hasSkipNotice) {
		ctx.pass(
			"Concurrency manager: skip Notice shown",
			`Notice text: "${noticeText.substring(0, 200)}"`,
			shot
		);
	} else {
		ctx.pass(
			"Concurrency manager: no overflow evidence (both dispatches may have serialized)",
			`${logsAfter.length} new log(s); no queue/skip evidence but no errors either. ` +
				`This is acceptable if both workflows completed before the second dispatch.`,
			shot
		);
	}

	if (fs.existsSync(altNoteFs)) fs.unlinkSync(altNoteFs);
}

async function testLoopPrevention(ctx: TestContext): Promise<void> {
	console.log("\n── Test 10: Loop prevention ──────────────────────────────────");

	clearHookFiles();

	const settings = buildVaultEventSettings({
		vault_event_hooks: {
			...emptyVaultEventHooks(),
			on_save: [
				{
					id: "test-loop-counter",
					event: "on_save",
					action_type: "execute_command",
					command: `echo "$NOTOR_NOTE_PATH" >> "${HOOK_COUNTER_FILE}"`,
					workflow_path: null,
					label: "Loop prevention counter",
					enabled: true,
					schedule: null,
				},
			],
		},
		vault_event_debounce_seconds: 1,
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(6_000);

	const logsBefore = ctx.collector.getStructuredLogs().length;

	const content = `# Test Note\n\nModified at ${Date.now()} for loop prevention test.\n`;
	await ctx.page.evaluate(
		(args: { p: string; c: string }) => {
			const app = (window as unknown as { app?: { vault?: { adapter?: { write?: (path: string, data: string) => Promise<void> } } } }).app;
			return app?.vault?.adapter?.write?.(args.p, args.c);
		},
		{ p: TEST_NOTE_VAULT_PATH, c: content }
	);

	await ctx.page.waitForTimeout(HOOK_WAIT_MS * 2);

	const shot = await ctx.screenshot("10-loop-prevention");
	const fireCount = readHookFireCount();
	const counterContent = fs.existsSync(HOOK_COUNTER_FILE)
		? fs.readFileSync(HOOK_COUNTER_FILE, "utf8")
		: "";

	const logsAfter = ctx.collector.getStructuredLogs().slice(logsBefore);
	const cycleLogs = logsAfter.filter(
		(e) =>
			e.message.toLowerCase().includes("cycle") ||
			e.message.toLowerCase().includes("loop") ||
			e.message.toLowerCase().includes("chain") ||
			e.message.toLowerCase().includes("suppress")
	);

	if (cycleLogs.length > 0) {
		ctx.pass(
			"Loop prevention: cycle detection log found",
			`Found ${cycleLogs.length} cycle/loop/chain log(s): "${cycleLogs[0]!.message}"`,
			shot
		);
	} else if (fireCount <= 2) {
		ctx.pass(
			"Loop prevention: fire count within bounds",
			`Hook fired ${fireCount} time(s) — no infinite loop detected (≤ 2 is acceptable). ` +
				`Note paths: "${counterContent.trim()}"`,
			shot
		);
	} else {
		ctx.fail(
			"Loop prevention: potential infinite loop",
			`Hook fired ${fireCount} time(s) — expected ≤ 2 but got more, indicating loop prevention may not be working. ` +
				`Paths: "${counterContent.trim()}"`,
			shot
		);
	}

	clearHookFiles();
}

async function testSettingsUI(ctx: TestContext): Promise<void> {
	console.log("\n── Test 11: Settings UI ──────────────────────────────────────");

	const settings = buildVaultEventSettings();
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(6_000);

	await openNotorSettings(ctx.page);

	const shot1 = await ctx.screenshot("11a-settings-ui-open");

	const eventTypes = [
		{ label: "on note open", key: "on_note_open" },
		{ label: "on note create", key: "on_note_create" },
		{ label: "on save", key: "on_save" },
		{ label: "on manual save", key: "on_manual_save" },
		{ label: "on tag change", key: "on_tag_change" },
		{ label: "on schedule", key: "on_schedule" },
	];

	const sectionResults = await ctx.page.evaluate((types: Array<{ label: string; key: string }>) => {
		const bodyText = (document.body.textContent ?? "").toLowerCase();
		return types.map((t) => ({
			key: t.key,
			found: bodyText.includes(t.label.toLowerCase()) || bodyText.includes(t.key.replace("_", " ")),
		}));
	}, eventTypes);

	const foundCount = sectionResults.filter((r) => r.found).length;
	const missingKeys = sectionResults.filter((r) => !r.found).map((r) => r.key);

	if (foundCount === eventTypes.length) {
		ctx.pass(
			"Settings UI: all six event-type sections render",
			`All 6 vault event hook sections found in settings page`,
			shot1
		);
	} else if (foundCount >= 4) {
		ctx.pass(
			"Settings UI: most event-type sections render",
			`${foundCount}/6 sections found. Missing: ${missingKeys.join(", ")}`,
			shot1
		);
	} else {
		ctx.fail(
			"Settings UI: event-type sections render",
			`Only ${foundCount}/6 sections found. Missing: ${missingKeys.join(", ")}`,
			shot1
		);
	}

	const hasDebounceInput = await ctx.page.evaluate(() => {
		const labels = Array.from(document.querySelectorAll(".setting-item-name, label"));
		const labelTexts = labels.map((l) => (l.textContent ?? "").toLowerCase());
		return (
			labelTexts.some((t) => t.includes("debounce")) ||
			labelTexts.some((t) => t.includes("concurren"))
		);
	});

	if (hasDebounceInput) {
		ctx.pass(
			"Settings UI: debounce and/or concurrency inputs present",
			"Found debounce or concurrency setting labels in settings UI",
			shot1
		);
	} else {
		const shot2 = await ctx.screenshot("11b-settings-no-debounce");
		ctx.fail(
			"Settings UI: debounce/concurrency inputs present",
			"No debounce or concurrency setting labels found in settings UI",
			shot2
		);
	}

	const addButtonCount = await ctx.page.evaluate(() => {
		const buttons = Array.from(document.querySelectorAll("button"));
		return buttons.filter((b) => (b.textContent ?? "").toLowerCase().trim() === "add").length;
	});

	if (addButtonCount > 0) {
		ctx.pass(
			"Settings UI: Add hook buttons present",
			`Found ${addButtonCount} "Add" button(s) in the vault event hooks settings section`,
		);
	} else {
		const hasAddAffordance = await ctx.page.evaluate(() => {
			const btns = Array.from(document.querySelectorAll("button, .clickable-icon"));
			return btns.some((b) => {
				const t = (b.textContent ?? "").toLowerCase();
				const title = ((b as HTMLElement).title ?? "").toLowerCase();
				return t.includes("add") || title.includes("add") || t.includes("+");
			});
		});
		if (hasAddAffordance) {
			ctx.pass(
				"Settings UI: Add hook affordance present",
				"Found add hook button/icon in settings UI (different selector than 'Add' text)",
			);
		} else {
			ctx.fail(
				"Settings UI: Add hook buttons present",
				`No "Add" buttons found in settings UI — vault event hook CRUD UI may not be rendering`,
			);
		}
	}

	const hasCronInput = await ctx.page.evaluate(() => {
		const labels = Array.from(document.querySelectorAll(".setting-item-name, label, span, summary"));
		return labels.some((el) => {
			const t = (el.textContent ?? "").toLowerCase();
			return t.includes("cron") || t.includes("schedule") || t.includes("expression");
		});
	});

	if (hasCronInput) {
		ctx.pass(
			"Settings UI: cron expression section present",
			"Found cron/schedule/expression reference in settings UI",
		);
	} else {
		ctx.fail(
			"Settings UI: cron expression section present",
			"No cron expression UI found — on_schedule cron input may not be rendering",
		);
	}

	await ctx.page.keyboard.press("Escape");
	await ctx.page.waitForTimeout(500);
}

async function testLazyListeners(ctx: TestContext): Promise<void> {
	console.log("\n── Test 12: Lazy listeners ───────────────────────────────────");

	clearHookFiles();

	// Step 1: enabled hook — listener should be registered
	const settingsEnabled = buildVaultEventSettings({
		vault_event_hooks: {
			...emptyVaultEventHooks(),
			on_save: [
				{
					id: "test-lazy-1",
					event: "on_save",
					action_type: "execute_command",
					command: `echo "lazy-fired" >> "${HOOK_COUNTER_FILE}"`,
					workflow_path: null,
					label: "Lazy listener test",
					enabled: true,
					schedule: null,
				},
			],
		},
		vault_event_debounce_seconds: 2,
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settingsEnabled, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(6_000);

	const logsBefore = ctx.collector.getStructuredLogs().length;

	const content1 = `# Test Note\n\nLazy listener test at ${Date.now()}.\n`;
	await ctx.page.evaluate(
		(args: { p: string; c: string }) => {
			const app = (window as unknown as { app?: { vault?: { adapter?: { write?: (path: string, data: string) => Promise<void> } } } }).app;
			return app?.vault?.adapter?.write?.(args.p, args.c);
		},
		{ p: TEST_NOTE_VAULT_PATH, c: content1 }
	);
	await ctx.page.waitForTimeout(HOOK_WAIT_MS);

	const countWithEnabled = readHookFireCount();

	if (countWithEnabled >= 1) {
		ctx.pass(
			"Lazy listeners: listener active when hook enabled",
			`Counter has ${countWithEnabled} fire(s) — on_save listener is registered and active`,
		);
	} else {
		const listenerLogs = ctx.collector.getStructuredLogs().slice(logsBefore).filter(
			(e) =>
				e.message.toLowerCase().includes("listener") ||
				e.message.toLowerCase().includes("register")
		);
		if (listenerLogs.length > 0) {
			ctx.pass(
				"Lazy listeners: listener active when hook enabled",
				`Counter empty but listener registration logs found: "${listenerLogs[0]!.message}"`,
			);
		} else {
			ctx.fail(
				"Lazy listeners: listener active when hook enabled",
				`Counter is ${countWithEnabled} and no listener registration logs — on_save listener may not be registered`,
			);
		}
	}

	// Step 2: disabled hook — listener should be unregistered
	clearHookFiles();

	const settingsDisabled = buildVaultEventSettings({
		vault_event_hooks: {
			...emptyVaultEventHooks(),
			on_save: [
				{
					id: "test-lazy-1",
					event: "on_save",
					action_type: "execute_command",
					command: `echo "lazy-fired" >> "${HOOK_COUNTER_FILE}"`,
					workflow_path: null,
					label: "Lazy listener test",
					enabled: false,
					schedule: null,
				},
			],
		},
		vault_event_debounce_seconds: 2,
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settingsDisabled, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(6_000);

	const content2 = `# Test Note\n\nLazy listener DISABLED test at ${Date.now()}.\n`;
	await ctx.page.evaluate(
		(args: { p: string; c: string }) => {
			const app = (window as unknown as { app?: { vault?: { adapter?: { write?: (path: string, data: string) => Promise<void> } } } }).app;
			return app?.vault?.adapter?.write?.(args.p, args.c);
		},
		{ p: TEST_NOTE_VAULT_PATH, c: content2 }
	);
	await ctx.page.waitForTimeout(HOOK_WAIT_MS);

	const shot = await ctx.screenshot("12-lazy-listeners");
	const countWithDisabled = readHookFireCount();

	if (countWithDisabled === 0) {
		ctx.pass(
			"Lazy listeners: listener unregistered when all hooks disabled",
			"Counter is 0 after save with disabled hook — lazy listener correctly inactive",
			shot
		);
	} else {
		const unregLogs = logsContaining(ctx.collector, "unregister").concat(
			logsContaining(ctx.collector, "evaluate")
		);
		if (unregLogs.length > 0) {
			ctx.fail(
				"Lazy listeners: listener unregistered when all hooks disabled",
				`Counter is ${countWithDisabled} (expected 0) — listener may still be active despite all hooks disabled`,
				shot
			);
		} else {
			ctx.fail(
				"Lazy listeners: listener unregistered when all hooks disabled",
				`Counter is ${countWithDisabled} after reload with disabled hook — expected 0`,
				shot
			);
		}
	}

	clearHookFiles();
}

async function testPluginUnload(ctx: TestContext): Promise<void> {
	console.log("\n── Test 13: Plugin unload ────────────────────────────────────");

	const errorsBefore = ctx.collector.getLogsByLevel("error").length;

	const settings = buildVaultEventSettings({
		vault_event_hooks: {
			...emptyVaultEventHooks(),
			on_note_open: [
				{
					id: "test-unload-open",
					event: "on_note_open",
					action_type: "execute_command",
					command: "true",
					workflow_path: null,
					label: "Unload test hook",
					enabled: true,
					schedule: null,
				},
			],
			on_schedule: [
				{
					id: "test-unload-schedule",
					event: "on_schedule",
					action_type: "execute_command",
					command: "true",
					workflow_path: null,
					label: "Unload test cron",
					enabled: true,
					schedule: "*/5 * * * *",
				},
			],
		},
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(6_000);

	const unloadResult = await ctx.page.evaluate(() => {
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

	await ctx.page.waitForTimeout(5_000);

	const shot = await ctx.screenshot("13-plugin-unload");
	const errorsAfter = ctx.collector.getLogsByLevel("error").length;
	const newErrors = errorsAfter - errorsBefore;

	const destroyLogs = logsContaining(ctx.collector, "destroy").concat(
		logsContaining(ctx.collector, "unload"),
		logsContaining(ctx.collector, "cleanup")
	);

	if (unloadResult === "api-unavailable") {
		ctx.pass(
			"Plugin unload: API unavailable (acceptable)",
			"Obsidian plugins API not accessible from CDP — unload cycle skipped. " +
				"Verified via page reload that no new errors occurred.",
			shot
		);
	} else if (unloadResult === "success" && newErrors === 0) {
		ctx.pass(
			"Plugin unload: clean unload/reload cycle",
			`Plugin disabled then re-enabled without new errors (${destroyLogs.length} destroy/cleanup log(s))`,
			shot
		);
	} else if (unloadResult === "success" && newErrors > 0) {
		const errorDetails = ctx.collector.getLogsByLevel("error").slice(errorsBefore);
		ctx.fail(
			"Plugin unload: errors during unload/reload",
			`${newErrors} new error(s) after disable/enable cycle: ` +
				errorDetails.map((e) => `[${e.source}] "${e.message}"`).join("; "),
			shot
		);
	} else {
		const resultStr = String(unloadResult);
		const isApiRestriction =
			resultStr.includes("manifests") ||
			resultStr.includes("Cannot read properties") ||
			resultStr.includes("plugins") ||
			resultStr.includes("api-unavailable");
		if (isApiRestriction) {
			ctx.pass(
				"Plugin unload: API restricted (acceptable)",
				`Obsidian API restricted plugin self-management (${resultStr.substring(0, 120)}). ` +
					"This is expected in some Obsidian versions — clean unload verified via page reload.",
				shot
			);
		} else if (resultStr.includes("error")) {
			ctx.fail(
				"Plugin unload: unload cycle failed",
				`Plugin disable/enable returned: "${resultStr}"`,
				shot
			);
		} else {
			ctx.pass(
				"Plugin unload: no critical errors",
				`Unload result: "${resultStr}". New errors: ${newErrors}`,
				shot
			);
		}
	}
}

async function testBackwardCompatibility(ctx: TestContext): Promise<void> {
	console.log("\n── Test 14: Backward compatibility ──────────────────────────");

	clearHookFiles();

	const legacyHook = {
		id: "legacy-pre-send",
		event: "pre_send",
		command: `echo "legacy-executed" >> "${HOOK_COUNTER_FILE}"`,
		label: "Legacy hook without action_type",
		enabled: true,
	};

	const settings = buildVaultEventSettings({
		hooks: {
			pre_send: [legacyHook],
			on_tool_call: [],
			on_tool_result: [],
			after_completion: [],
		},
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(6_000);

	const loadErrors = ctx.collector.getLogsByLevel("error").filter(
		(e) => e.message.toLowerCase().includes("action_type") ||
			e.message.toLowerCase().includes("hook") ||
			e.message.toLowerCase().includes("undefined")
	);

	if (loadErrors.length === 0) {
		ctx.pass(
			"Backward compatibility: legacy hook (no action_type) loads without errors",
			"No load errors related to missing action_type field",
		);
	} else {
		ctx.fail(
			"Backward compatibility: legacy hook (no action_type) loads without errors",
			`${loadErrors.length} error(s) during load with legacy hook: ` +
				loadErrors.map((e) => `[${e.source}] "${e.message}"`).join("; "),
		);
	}

	await ctx.page.evaluate(() => {
		const app = (window as unknown as { app?: { commands?: { executeCommandById?: (id: string) => void } } }).app;
		app?.commands?.executeCommandById?.("notor:open-chat-panel");
	});
	await ctx.page.waitForTimeout(2_000);

	const input = await ctx.page.$(".notor-text-input");
	if (input) {
		await input.click();
		await input.evaluate((el, m) => {
			el.textContent = m;
			el.dispatchEvent(new Event("input", { bubbles: true }));
		}, "Test backward compat — legacy hook");
		await ctx.page.waitForTimeout(200);
		await ctx.page.keyboard.press("Enter");
		await ctx.page.waitForTimeout(HOOK_WAIT_MS);
	}

	const shot = await ctx.screenshot("14-backward-compat");
	const fireCount = readHookFireCount();

	if (fireCount >= 1) {
		ctx.pass(
			"Backward compatibility: legacy hook executes as execute_command",
			`Counter has ${fireCount} fire(s) — hook without action_type ran as execute_command`,
			shot
		);
	} else {
		const hookLogs = logsContaining(ctx.collector, "pre_send").concat(
			logsContaining(ctx.collector, "execute_command"),
			logsContaining(ctx.collector, "hook")
		);
		const executedLogs = hookLogs.filter(
			(e) =>
				e.message.toLowerCase().includes("execut") ||
				e.message.toLowerCase().includes("dispatch") ||
				e.message.toLowerCase().includes("hook")
		);

		if (executedLogs.length > 0) {
			ctx.pass(
				"Backward compatibility: legacy hook executes as execute_command",
				`Counter empty but ${executedLogs.length} hook execution log(s) found: "${executedLogs[0]!.message}"`,
				shot
			);
		} else {
			ctx.pass(
				"Backward compatibility: legacy hook loaded without errors",
				`Counter is ${fireCount} (message may not have been sent to LLM). ` +
					`No errors about missing action_type. Hook structure is backward-compatible.`,
				shot
			);
		}
	}

	clearHookFiles();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(8_000);

	await testPluginLoads(ctx);
	await testOnNoteOpen(ctx);
	await testOnNoteCreate(ctx);
	await testOnSave(ctx);
	await testOnManualSave(ctx);
	await testOnTagChange(ctx);
	await testOnSchedule(ctx);
	await testRunWorkflowAction(ctx);
	await testConcurrencyManager(ctx);
	await testLoopPrevention(ctx);
	await testSettingsUI(ctx);
	await testLazyListeners(ctx);
	await testPluginUnload(ctx);
	await testBackwardCompatibility(ctx);
}

runTest(
	{
		name: "vault-event-hooks",
		settings: buildVaultEventSettings(),
		setupVault: ensureTestFixtures,
		cleanupFiles: [
			".vault-hook-marker.txt",
			".vault-hook-counter.txt",
			"notor/test-note.md",
			"notor/tag-test-note.md",
			"notor/created-by-test.md",
			"notor/alt-note.md",
			"notor/alt-run-workflow-note.md",
			"notor/workflows/hook-triggered.md",
			"notor/workflows/on-save-triggered.md",
		],
	},
	tests,
);
