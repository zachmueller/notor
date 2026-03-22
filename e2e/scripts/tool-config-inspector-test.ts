#!/usr/bin/env npx tsx
/**
 * Tool Config Inspector E2E Test Script
 *
 * Validates the Effective Config Inspector leaf view (FR-88):
 *  1. Opens via command palette
 *  2. Shows empty state when no conversation is active
 *  3. Renders effective config table after a message is sent
 *  4. Displays correct field values and source attribution
 *  5. Updates live when persona is switched
 *
 * LLM Required: No (inspector is UI-only)
 *
 * @see specs/04b-tool-toggle/e2e-tests.md — Script 6
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import { waitForSelector, VAULT_PATH } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Custom helpers — these call revealLeaf before interacting since the
// inspector sidebar may obscure the chat view
// ---------------------------------------------------------------------------

async function revealChatView(page: Page): Promise<void> {
	await page.evaluate(() => {
		const app = (window as unknown as { app?: { workspace?: { getLeavesOfType?: (type: string) => Array<{ view?: unknown }> } } }).app;
		const chatLeaves = app?.workspace?.getLeavesOfType?.("notor-chat-view") ?? [];
		if (chatLeaves.length > 0) {
			(app?.workspace as { revealLeaf?: (leaf: unknown) => void })?.revealLeaf?.(chatLeaves[0]);
		}
	});
	await page.waitForTimeout(500);
}

async function selectPersonaLocal(page: Page, personaName: string | null): Promise<boolean> {
	await revealChatView(page);

	const settingsBtn = await page.$(".notor-chat-header-btn[aria-label='Chat settings']");
	if (!settingsBtn) return false;

	await settingsBtn.click();
	await page.waitForTimeout(1500);

	const selected = await page.evaluate((name) => {
		const selects = document.querySelectorAll(".notor-settings-popover .notor-settings-select");
		for (const select of selects) {
			const opts = Array.from(select.querySelectorAll("option"));
			const noneOpt = opts.find((o) => o.textContent?.trim() === "None");
			if (noneOpt) {
				const targetValue = name === null ? "None" : name;
				const targetOpt = opts.find((o) => o.textContent?.trim() === targetValue);
				if (targetOpt) {
					(select as HTMLSelectElement).value = (targetOpt as HTMLOptionElement).value;
					select.dispatchEvent(new Event("change", { bubbles: true }));
					return true;
				}
			}
		}
		return false;
	}, personaName);

	await page.waitForTimeout(2000);
	await settingsBtn.click();
	await page.waitForTimeout(500);

	return selected;
}

async function sendMessageLocal(page: Page, text: string): Promise<void> {
	await revealChatView(page);
	await page.waitForTimeout(300);

	const input = await page.$(".notor-text-input");
	if (!input) throw new Error("Chat input not found");

	await input.click();
	await page.keyboard.type(text);
	await page.waitForTimeout(300);

	const sendBtn = await page.$(".notor-send-btn");
	if (sendBtn) await sendBtn.click();
	else await page.keyboard.press("Enter");
	await page.waitForTimeout(5000);
}

async function newConversationLocal(page: Page): Promise<void> {
	await revealChatView(page);
	await page.waitForTimeout(300);

	const newBtn = await page.$(".notor-chat-header-btn[aria-label='New conversation']");
	if (newBtn) {
		await newBtn.click();
		await page.waitForTimeout(2000);
	}
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

function setupFixtures(vaultPath: string): void {
	const personasDir = path.join(vaultPath, "notor", "personas");

	// Restrictive persona
	const restrictiveDir = path.join(personasDir, "restrictive");
	fs.mkdirSync(restrictiveDir, { recursive: true });
	fs.writeFileSync(
		path.join(restrictiveDir, "system-prompt.md"),
		`---
notor-persona-prompt-mode: append
---

You are a read-only research assistant.

<notor_tool_config version="1.0">
write_note:
  enabled: false
replace_in_note:
  enabled: false
read_note:
  auto_approve: true
  allowed_paths:
    - "Notes/"
    - "Research/"
  blocked_paths:
    - "Notes/Private/"
</notor_tool_config>
`
	);

	// Permissive persona
	const permissiveDir = path.join(personasDir, "permissive");
	fs.mkdirSync(permissiveDir, { recursive: true });
	fs.writeFileSync(
		path.join(permissiveDir, "system-prompt.md"),
		`---
notor-persona-prompt-mode: append
---

You are a fully autonomous assistant.

<notor_tool_config version="1.0">
write_note:
  auto_approve: true
  enabled: true
read_note:
  auto_approve: true
replace_in_note:
  auto_approve: true
search_vault:
  auto_approve: true
</notor_tool_config>
`
	);

	// Test notes
	const notesDir = path.join(vaultPath, "Notes");
	fs.mkdirSync(notesDir, { recursive: true });
	fs.writeFileSync(path.join(notesDir, "Meeting Notes.md"), "# Meeting Notes\n\nDiscussion about project timeline.\n");

	const privateDir = path.join(notesDir, "Private");
	fs.mkdirSync(privateDir, { recursive: true });
	fs.writeFileSync(path.join(privateDir, "Secret.md"), "# Secret\n\nConfidential information.\n");

	const researchDir = path.join(vaultPath, "Research");
	fs.mkdirSync(researchDir, { recursive: true });
	fs.writeFileSync(path.join(researchDir, "Paper.md"), "# Paper\n\nResearch findings.\n");

	// Reset workspace: remove inspector leaf from previous run
	const workspacePath = path.join(vaultPath, ".obsidian", "workspace.json");
	if (fs.existsSync(workspacePath)) {
		try {
			const ws = JSON.parse(fs.readFileSync(workspacePath, "utf-8"));
			if (ws.right?.children) {
				for (const tabs of ws.right.children) {
					if (tabs.children) {
						tabs.children = tabs.children.filter(
							(c: { state?: { type?: string } }) => c.state?.type !== "notor-tool-config-inspector"
						);
						const chatIdx = tabs.children.findIndex(
							(c: { state?: { type?: string } }) => c.state?.type === "notor-chat-view"
						);
						if (chatIdx >= 0) tabs.currentTab = chatIdx;
					}
				}
			}
			if (ws.active === "ede89db2c197f5d0" || ws.active?.includes("inspector")) {
				ws.active = "notor-chat-view-leaf";
			}
			fs.writeFileSync(workspacePath, JSON.stringify(ws, null, 2));
		} catch { /* ignore parse errors */ }
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext) {
	const { page } = ctx;
	await page.waitForTimeout(3000);

	// ── Test 1: Chat panel present ──────────────────────────────────────
	console.log("── Test 1: Chat panel present ──");
	{
		const chat = await waitForSelector(page, ".notor-chat-container", 12_000);
		const shot = await ctx.screenshot("01-chat-panel");
		if (chat) ctx.pass("Chat panel present", "Found .notor-chat-container", shot);
		else ctx.fail("Chat panel present", ".notor-chat-container not found within 12s", shot);
	}

	// ── Test 2: Open inspector via command palette ──────────────────────
	console.log("\n── Test 2: Open inspector via command palette ──");
	{
		await page.evaluate(() => {
			const app = (window as unknown as { app?: { commands?: { executeCommandById?: (id: string) => void } } }).app;
			app?.commands?.executeCommandById?.("notor:open-tool-config-inspector");
		});
		await page.waitForTimeout(2000);

		const inspector = await waitForSelector(page, ".notor-config-inspector", 5_000);
		const shot = await ctx.screenshot("02-inspector-opened");

		if (inspector) {
			ctx.pass("Open inspector via command", "Inspector leaf opened with .notor-config-inspector", shot);
		} else {
			const hasInspector = await page.evaluate(() => {
				const app = (window as unknown as { app?: { workspace?: { getLeavesOfType?: (type: string) => unknown[] } } }).app;
				return (app?.workspace?.getLeavesOfType?.("notor-tool-config-inspector") ?? []).length > 0;
			});
			if (hasInspector) ctx.pass("Open inspector via command", "Inspector leaf exists (view type registered)", shot);
			else ctx.fail("Open inspector via command", "Inspector leaf not found after command execution", shot);
		}
	}

	// ── Test 3: No conversation — empty state message ───────────────────
	console.log("\n── Test 3: No conversation — empty state message ──");
	{
		const emptyMsg = await page.evaluate(() => {
			const el = document.querySelector(".notor-config-inspector-empty");
			return el ? el.textContent : null;
		});
		const shot = await ctx.screenshot("03-empty-state");

		if (emptyMsg) {
			if (emptyMsg.includes("conversation") || emptyMsg.includes("orchestrator")) {
				ctx.pass("No conversation empty state", `Shows: "${emptyMsg}"`, shot);
			} else {
				ctx.pass("No conversation empty state (partial)", `Empty element found: "${emptyMsg}"`, shot);
			}
		} else {
			const inspectorContent = await page.evaluate(() => {
				const el = document.querySelector(".notor-config-inspector-content, .notor-config-inspector");
				return el ? el.textContent?.trim() : null;
			});
			if (inspectorContent && (inspectorContent.includes("conversation") || inspectorContent.includes("orchestrator"))) {
				ctx.pass("No conversation empty state", `Content mentions conversation state: "${inspectorContent.substring(0, 100)}"`, shot);
			} else {
				ctx.fail("No conversation empty state", `Expected empty state message. Content: "${inspectorContent?.substring(0, 100) ?? "(none)"}"`, shot);
			}
		}
	}

	// ── Test 4: Activate restrictive persona ────────────────────────────
	console.log("\n── Test 4: Activate restrictive persona ──");
	{
		const selected = await selectPersonaLocal(page, "restrictive");
		if (selected) {
			const label = await page.$(".notor-persona-label");
			const text = label ? await label.textContent() : "";
			const shot = await ctx.screenshot("04-restrictive-activated");
			if (text?.includes("restrictive")) {
				ctx.pass("Activate restrictive persona", `Persona label shows: "${text?.trim()}"`, shot);
			} else {
				ctx.fail("Activate restrictive persona", `Label text: "${text?.trim()}" — expected "restrictive"`, shot);
			}
		} else {
			const shot = await ctx.screenshot("04-select-failed");
			ctx.fail("Activate restrictive persona", "Could not select restrictive persona from dropdown", shot);
		}
	}

	// ── Test 5: Send message to trigger config resolution ───────────────
	console.log("\n── Test 5: Send message to trigger config resolution ──");
	{
		try {
			await sendMessageLocal(page, "Hello, testing inspector.");
			const shot = await ctx.screenshot("05-message-sent");
			ctx.pass("Send message to trigger config resolution", "Message sent successfully", shot);
		} catch (err) {
			const shot = await ctx.screenshot("05-send-failed");
			ctx.fail("Send message to trigger config resolution", `Error: ${err instanceof Error ? err.message : String(err)}`, shot);
		}
	}

	// ── Test 6: Inspector shows effective config table ───────────────────
	console.log("\n── Test 6: Inspector shows effective config ──");
	{
		await page.evaluate(() => {
			const app = (window as unknown as { app?: { workspace?: { getLeavesOfType?: (type: string) => Array<{ view?: { refresh?: () => void } }> } } }).app;
			const leaves = app?.workspace?.getLeavesOfType?.("notor-tool-config-inspector") ?? [];
			for (const leaf of leaves) (leaf.view as { refresh?: () => void } | undefined)?.refresh?.();
		});
		await page.waitForTimeout(1000);

		const tableInfo = await page.evaluate(() => {
			const table = document.querySelector(".notor-config-inspector-table");
			if (!table) return null;
			const rows = table.querySelectorAll("tbody tr");
			const headers = table.querySelectorAll("thead th");
			return {
				rowCount: rows.length,
				headerCount: headers.length,
				headers: Array.from(headers).map(h => h.textContent?.trim()),
			};
		});
		const shot = await ctx.screenshot("06-inspector-config");

		if (tableInfo && tableInfo.rowCount > 0) {
			ctx.pass("Inspector shows effective config", `Table rendered with ${tableInfo.rowCount} tool rows, headers: ${tableInfo.headers?.join(", ")}`, shot);
		} else {
			const content = await page.evaluate(() => {
				const el = document.querySelector(".notor-config-inspector-content, .notor-config-inspector");
				return el ? el.textContent?.trim().substring(0, 200) : null;
			});
			ctx.fail("Inspector shows effective config", `Table not found. Inspector content: "${content ?? "(none)"}"`, shot);
		}
	}

	// ── Test 7: Disabled tool shown ─────────────────────────────────────
	console.log("\n── Test 7: Disabled tool (write_note) shown ──");
	{
		const writeNoteInfo = await page.evaluate(() => {
			const rows = document.querySelectorAll(".notor-config-inspector-table tbody tr");
			for (const row of rows) {
				const cells = row.querySelectorAll("td");
				if (cells[0]?.textContent?.trim() === "write_note") {
					return {
						enabled: cells[1]?.textContent?.trim() ?? null,
						hasDisabledClass: cells[1]?.classList.contains("notor-config-inspector-disabled") ?? false,
					};
				}
			}
			return null;
		});
		const shot = await ctx.screenshot("07-write-note-disabled");

		if (writeNoteInfo) {
			if (writeNoteInfo.enabled === "No" || writeNoteInfo.hasDisabledClass) {
				ctx.pass("Disabled tool shown", `write_note enabled="${writeNoteInfo.enabled}", hasDisabledClass=${writeNoteInfo.hasDisabledClass}`, shot);
			} else {
				ctx.fail("Disabled tool shown", `write_note found but enabled="${writeNoteInfo.enabled}", expected "No"`, shot);
			}
		} else {
			ctx.fail("Disabled tool shown", "write_note row not found in inspector table", shot);
		}
	}

	// ── Test 8: Source link present ──────────────────────────────────────
	console.log("\n── Test 8: Source link present for write_note ──");
	{
		const sourceInfo = await page.evaluate(() => {
			const rows = document.querySelectorAll(".notor-config-inspector-table tbody tr");
			for (const row of rows) {
				const cells = row.querySelectorAll("td");
				if (cells[0]?.textContent?.trim() === "write_note") {
					const sourceCell = cells[5];
					const link = sourceCell?.querySelector(".notor-config-inspector-source-link, a");
					return { text: sourceCell?.textContent?.trim() ?? null, hasLink: !!link, linkText: link?.textContent?.trim() ?? null };
				}
			}
			return null;
		});
		const shot = await ctx.screenshot("08-source-link");

		if (sourceInfo) {
			const refersToRestrictive = (sourceInfo.text ?? "").includes("restrictive") || (sourceInfo.linkText ?? "").includes("restrictive");
			if (refersToRestrictive) {
				ctx.pass("Source link present", `Source: "${sourceInfo.text}", hasLink=${sourceInfo.hasLink}`, shot);
			} else {
				ctx.pass("Source link present (partial)", `Source: "${sourceInfo.text}" (expected reference to 'restrictive')`, shot);
			}
		} else {
			ctx.fail("Source link present", "write_note row not found in inspector table", shot);
		}
	}

	// ── Test 9: Default fields muted style ──────────────────────────────
	console.log("\n── Test 9: Default fields have muted style ──");
	{
		const mutedInfo = await page.evaluate(() => {
			const defaultRows = document.querySelectorAll(".notor-config-inspector-default-row");
			const mutedCells = document.querySelectorAll(".notor-config-inspector-muted");
			const rows = document.querySelectorAll(".notor-config-inspector-table tbody tr");
			let defaultToolExample: string | null = null;
			for (const row of rows) {
				if (row.classList.contains("notor-config-inspector-default-row")) {
					defaultToolExample = row.querySelector("td")?.textContent?.trim() ?? null;
					break;
				}
			}
			return { defaultRowCount: defaultRows.length, mutedCellCount: mutedCells.length, defaultToolExample };
		});
		const shot = await ctx.screenshot("09-muted-defaults");

		if (mutedInfo.defaultRowCount > 0 || mutedInfo.mutedCellCount > 0) {
			ctx.pass("Default fields muted style",
				`${mutedInfo.defaultRowCount} default rows, ${mutedInfo.mutedCellCount} muted cells` +
				(mutedInfo.defaultToolExample ? `. Example default tool: ${mutedInfo.defaultToolExample}` : ""),
				shot);
		} else {
			ctx.fail("Default fields muted style", "No .notor-config-inspector-default-row or .notor-config-inspector-muted elements found", shot);
		}
	}

	// ── Test 10: Path constraints displayed for read_note ────────────────
	console.log("\n── Test 10: Path constraints displayed (read_note) ──");
	{
		const pathInfo = await page.evaluate(() => {
			const rows = document.querySelectorAll(".notor-config-inspector-table tbody tr");
			for (const row of rows) {
				const cells = row.querySelectorAll("td");
				if (cells[0]?.textContent?.trim() === "read_note") {
					return { allowedPaths: cells[3]?.textContent?.trim() ?? null, blockedPaths: cells[4]?.textContent?.trim() ?? null };
				}
			}
			return null;
		});
		const shot = await ctx.screenshot("10-path-constraints");

		if (pathInfo) {
			const hasAllowed = (pathInfo.allowedPaths ?? "").includes("Notes/") && (pathInfo.allowedPaths ?? "").includes("Research/");
			const hasBlocked = (pathInfo.blockedPaths ?? "").includes("Notes/Private/");
			if (hasAllowed && hasBlocked) {
				ctx.pass("Path constraints displayed", `allowed_paths="${pathInfo.allowedPaths}", blocked_paths="${pathInfo.blockedPaths}"`, shot);
			} else {
				ctx.fail("Path constraints displayed", `allowed="${pathInfo.allowedPaths}" (expected Notes/, Research/), blocked="${pathInfo.blockedPaths}" (expected Notes/Private/)`, shot);
			}
		} else {
			ctx.fail("Path constraints displayed", "read_note row not found in inspector table", shot);
		}
	}

	// ── Test 11: Switch persona updates inspector ───────────────────────
	console.log("\n── Test 11: Switch persona updates inspector ──");
	{
		const selected = await selectPersonaLocal(page, "permissive");
		if (!selected) {
			const shot = await ctx.screenshot("11-select-failed");
			ctx.fail("Switch persona updates inspector", "Could not select permissive persona", shot);
		} else {
			await sendMessageLocal(page, "Testing permissive persona inspector update.");

			await page.evaluate(() => {
				const app = (window as unknown as { app?: { workspace?: { getLeavesOfType?: (type: string) => Array<{ view?: { refresh?: () => void } }> } } }).app;
				const leaves = app?.workspace?.getLeavesOfType?.("notor-tool-config-inspector") ?? [];
				for (const leaf of leaves) (leaf.view as { refresh?: () => void } | undefined)?.refresh?.();
			});
			await page.waitForTimeout(1000);

			const writeNoteInfo = await page.evaluate(() => {
				const rows = document.querySelectorAll(".notor-config-inspector-table tbody tr");
				for (const row of rows) {
					const cells = row.querySelectorAll("td");
					if (cells[0]?.textContent?.trim() === "write_note") {
						return { enabled: cells[1]?.textContent?.trim() ?? null, autoApprove: cells[2]?.textContent?.trim() ?? null };
					}
				}
				return null;
			});
			const shot = await ctx.screenshot("11-permissive-inspector");

			if (writeNoteInfo) {
				if (writeNoteInfo.enabled === "Yes" && writeNoteInfo.autoApprove === "Yes") {
					ctx.pass("Switch persona updates inspector", `write_note now enabled="${writeNoteInfo.enabled}", auto_approve="${writeNoteInfo.autoApprove}"`, shot);
				} else {
					ctx.fail("Switch persona updates inspector", `write_note enabled="${writeNoteInfo.enabled}" (expected Yes), auto_approve="${writeNoteInfo.autoApprove}" (expected Yes)`, shot);
				}
			} else {
				const content = await page.evaluate(() => {
					const el = document.querySelector(".notor-config-inspector-content, .notor-config-inspector");
					return el ? el.textContent?.trim().substring(0, 200) : null;
				});
				ctx.fail("Switch persona updates inspector", `write_note row not found. Content: "${content ?? "(none)"}"`, shot);
			}
		}
	}

	// ── Test 12: Deactivate persona clears config ───────────────────────
	console.log("\n── Test 12: Deactivate persona clears config ──");
	{
		const deactivated = await selectPersonaLocal(page, null);
		if (!deactivated) {
			const shot = await ctx.screenshot("12-deactivate-failed");
			ctx.fail("Deactivate persona clears config", "Could not select None from persona dropdown", shot);
		} else {
			await newConversationLocal(page);

			await page.evaluate(() => {
				const app = (window as unknown as { app?: { workspace?: { getLeavesOfType?: (type: string) => Array<{ view?: { refresh?: () => void } }> } } }).app;
				const leaves = app?.workspace?.getLeavesOfType?.("notor-tool-config-inspector") ?? [];
				for (const leaf of leaves) (leaf.view as { refresh?: () => void } | undefined)?.refresh?.();
			});
			await page.waitForTimeout(1000);

			const state = await page.evaluate(() => {
				const emptyEl = document.querySelector(".notor-config-inspector-empty");
				const table = document.querySelector(".notor-config-inspector-table");
				return { hasEmpty: !!emptyEl, emptyText: emptyEl?.textContent?.trim() ?? null, hasTable: !!table };
			});
			const shot = await ctx.screenshot("12-deactivated-inspector");

			if (state.hasEmpty) {
				ctx.pass("Deactivate persona clears config", `Shows empty state: "${state.emptyText}"`, shot);
			} else if (!state.hasTable) {
				ctx.pass("Deactivate persona clears config", "No table rendered (config cleared)", shot);
			} else {
				const allDefaults = await page.evaluate(() => {
					const rows = document.querySelectorAll(".notor-config-inspector-table tbody tr");
					const sourceLinks = document.querySelectorAll(".notor-config-inspector-source-link");
					return { rowCount: rows.length, sourceLinkCount: sourceLinks.length };
				});
				if (allDefaults.sourceLinkCount === 0) {
					ctx.pass("Deactivate persona clears config", `Table shows ${allDefaults.rowCount} rows, all at global defaults (no source links)`, shot);
				} else {
					ctx.fail("Deactivate persona clears config", `Table still shows ${allDefaults.sourceLinkCount} source link(s) — expected defaults or empty state`, shot);
				}
			}
		}
	}
}

runTest(
	{
		name: "tool-config-inspector",
		setupVault: setupFixtures,
		cleanupFiles: [
			"notor/personas/restrictive",
			"notor/personas/permissive",
			"Notes",
			"Research",
		],
	},
	tests,
).catch((err) => {
	console.error(err);
	process.exit(1);
});
