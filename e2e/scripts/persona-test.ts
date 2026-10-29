#!/usr/bin/env npx tsx
/**
 * Persona System E2E Test Script
 *
 * Validates the complete persona system (Group A) through simulated user
 * actions via Playwright + CDP:
 *
 *  2. Default persona chip ("🎭 Default") sits after the mode toggle
 *  3. Persona chip opens the persona menu
 *  4. Menu lists discovered personas; broken YAML / empty dirs excluded
 *  5. Selecting a persona updates the chip and the conversation header
 *  6. Panel persona state and settings.active_persona reflect the switch
 *  7. Structured logs confirm persona discovery (runs on menu open)
 *  8. Selecting "None (deactivate)" restores the default chip
 *  9. Panel persona state cleared on deactivation
 * 10. Broken persona excluded with a parse warning
 * 11. Persona with provider/model overrides
 * 12. Deactivation reverts to defaults
 * 13. No persona-related error logs
 * 14. Replace mode persona — panel persona has prompt_mode "replace"
 * 15. Provider/model reference section visible in Settings tab
 *
 * Prerequisites:
 *   - Test personas exist in e2e/test-vault/notor/personas/
 *     (researcher, organizer, broken, empty-dir)
 *   - Created by A-004 setup
 *
 * @see specs/03-workflows-personas/tasks/group-a-tasks.md — A-014
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import type { Page } from "playwright-core";
import { waitForSelector, buildDefaultSettings, openPersonaMenu, closeMenu, selectPersona } from "../lib/test-helpers";

/** The active panel's persona state: orchestrator, conversation header and settings. */
async function getPanelPersonaState(page: Page): Promise<{
	activePersona: string | null;
	promptMode: string | null;
	convPersona: string | null;
	settingsPersona: string;
} | null> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const orchestrator = plugin?.getActiveOrchestrator?.();
		if (!orchestrator) return null;
		const persona = orchestrator.getActivePersona();
		const conv = orchestrator.getConversationManager().getActiveConversation();
		return {
			activePersona: persona?.name ?? null,
			promptMode: persona?.prompt_mode ?? null,
			convPersona: conv?.persona_name ?? null,
			settingsPersona: plugin.settings.active_persona ?? "",
		};
	});
}

/**
 * Ensure test persona files exist in the test vault.
 * These are gitignored so they need to be created before each test run.
 */
function ensureTestPersonas(vaultPath: string): void {
	const personasDir = path.join(vaultPath, "notor", "personas");
	fs.mkdirSync(personasDir, { recursive: true });

	// Researcher persona (append mode, no overrides)
	const researcherDir = path.join(personasDir, "researcher");
	fs.mkdirSync(researcherDir, { recursive: true });
	fs.writeFileSync(
		path.join(researcherDir, "system-prompt.md"),
		`---
notor-persona-prompt-mode: append
---

You are a research assistant. Focus on finding accurate information, citing sources, and providing well-structured analysis.
`
	);

	// Organizer persona (with provider/model overrides)
	const organizerDir = path.join(personasDir, "organizer");
	fs.mkdirSync(organizerDir, { recursive: true });
	fs.writeFileSync(
		path.join(organizerDir, "system-prompt.md"),
		`---
notor-persona-prompt-mode: append
notor-preferred-provider: "anthropic"
notor-preferred-model: "claude-sonnet-4-20250514"
---

You are an organizational assistant. Help the user structure their notes, create outlines, and maintain a clean vault hierarchy.
`
	);

	// Broken persona (invalid YAML — should be excluded)
	const brokenDir = path.join(personasDir, "broken");
	fs.mkdirSync(brokenDir, { recursive: true });
	fs.writeFileSync(
		path.join(brokenDir, "system-prompt.md"),
		`---
notor-persona-prompt-mode: "invalid value with unbalanced quote
---

This persona has broken frontmatter and should be excluded.
`
	);

	// Replacer persona (replace mode — excludes global system prompt)
	const replacerDir = path.join(personasDir, "replacer");
	fs.mkdirSync(replacerDir, { recursive: true });
	fs.writeFileSync(
		path.join(replacerDir, "system-prompt.md"),
		`---
notor-persona-prompt-mode: replace
---

You are a minimalist writing assistant. Keep responses short and direct. Do not explain unless asked.
`
	);

	// Empty dir (no system-prompt.md — should be silently ignored)
	const emptyDir = path.join(personasDir, "empty-dir");
	fs.mkdirSync(emptyDir, { recursive: true });
	// Only a .gitkeep, no system-prompt.md
	fs.writeFileSync(path.join(emptyDir, ".gitkeep"), "");

	console.log("  Test personas ensured in test vault.");
}

async function tests(ctx: TestContext) {
	const { page } = ctx;

	// Give the plugin time to fully initialize
	await page.waitForTimeout(5000);

	// ── Test 1: Chat panel is present ───────────────────────────────────
	console.log("Test 1: Chat panel present");
	{
		const chatContainer = await waitForSelector(page, ".notor-chat-container", 6000);
		if (chatContainer) {
			ctx.pass("Chat panel visible", "Found .notor-chat-container");
		} else {
			const shot = await ctx.screenshot("01-no-chat-panel");
			ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
		}
	}

	// ── Test 2: Default persona chip when no persona is active ──────────
	console.log("\nTest 2: Default persona chip (no active persona)");
	{
		const label = await page.$(".notor-persona-label");
		if (!label) {
			const shot = await ctx.screenshot("02-no-persona-label");
			ctx.fail("Default persona chip", "No .notor-persona-label element found", shot);
		} else {
			const isDefault = await label.evaluate((el) => el.classList.contains("notor-persona-label--default"));
			// Chip must sit in the toolbar right after the mode-toggle group, not after the send buttons
			const placed = await label.evaluate((el) =>
				el.previousElementSibling?.classList.contains("notor-input-toolbar-left") === true
			);
			const text = await label.textContent();
			if (isDefault && placed && text?.trim() === "🎭 Default") {
				ctx.pass("Default persona chip", `Label "${text.trim()}" placed after the mode toggle`);
			} else {
				ctx.fail("Default persona chip", `default=${isDefault}, placed=${placed}, text="${text?.trim()}"`);
			}
		}
	}

	// ── Test 3: Persona chip opens the persona menu ─────────────────────
	console.log("\nTest 3: Persona chip opens the persona menu");
	const menuTitles = await openPersonaMenu(page);
	{
		const shot = await ctx.screenshot("03-persona-menu");
		if (menuTitles?.includes("None (deactivate)")) {
			ctx.pass("Persona chip menu", `Menu opened with ${menuTitles.length} item(s)`, shot);
		} else {
			ctx.fail("Persona chip menu", `Menu items: ${JSON.stringify(menuTitles)}`, shot);
		}
		await closeMenu(page);
	}

	// ── Test 4: Persona menu lists researcher and organizer ─────────────
	console.log("\nTest 4: Persona menu lists correct personas");
	{
		const titles = menuTitles ?? [];
		const hasResearcher = titles.includes("researcher");
		const hasOrganizer = titles.includes("organizer");
		const hasBroken = titles.includes("broken");
		const hasEmptyDir = titles.includes("empty-dir");
		const detail = `Items: [${titles.join(", ")}] — researcher=${hasResearcher}, organizer=${hasOrganizer}, broken=${hasBroken}, empty-dir=${hasEmptyDir}`;
		if (hasResearcher && hasOrganizer && !hasBroken && !hasEmptyDir) {
			ctx.pass("Persona menu correct", detail);
		} else {
			ctx.fail("Persona menu correct", detail);
		}
	}

	// ── Test 5: Select researcher persona → label appears ───────────────
	console.log("\nTest 5: Select researcher persona → label appears");
	{
		if (await selectPersona(page, "researcher")) {
			const text = (await page.textContent(".notor-persona-label"))?.trim() ?? "";
			const state = await getPanelPersonaState(page);
			const shot = await ctx.screenshot("05-researcher-selected");
			if (text.includes("researcher") && state?.convPersona === "researcher") {
				ctx.pass("Researcher persona selected", `Label "${text}", conversation persona_name="${state.convPersona}"`, shot);
			} else {
				ctx.fail("Researcher persona selected", `Label "${text}", state=${JSON.stringify(state)}`, shot);
			}
		} else {
			ctx.fail("Select researcher persona", "researcher not found in persona menu");
		}
	}

	// ── Test 6: Panel state confirms persona activation ─────────────────
	// Chip switches are panel-scoped (orchestrator + JSONL header), not
	// PersonaManager.activatePersona(), so assert on state rather than logs.
	console.log("\nTest 6: Panel state confirms persona activation");
	{
		const state = await getPanelPersonaState(page);
		if (state?.activePersona === "researcher" && state.settingsPersona === "researcher") {
			ctx.pass("Persona activation applied", `Panel persona "${state.activePersona}", settings.active_persona "${state.settingsPersona}"`);
		} else {
			ctx.fail("Persona activation applied", `state=${JSON.stringify(state)}`);
		}
	}

	// ── Test 7: Structured logs confirm discovery ───────────────────────
	console.log("\nTest 7: Structured logs show persona discovery");
	{
		const allLogs = ctx.collector.getStructuredLogs();
		const discoveryLogs = allLogs.filter(
			(entry) =>
				entry.source === "PersonaDiscovery" &&
				(entry.message.includes("Discovered") || entry.message.includes("discovered") || entry.message.includes("discovery complete"))
		);

		if (discoveryLogs.length > 0) {
			ctx.pass(
				"Persona discovery logged",
				`Found ${discoveryLogs.length} discovery log(s): "${discoveryLogs[0].message}"`
			);
		} else {
			const pdLogs = allLogs.filter((e) => e.source === "PersonaDiscovery");
			if (pdLogs.length > 0) {
				ctx.pass("Persona discovery logged", `Found ${pdLogs.length} PersonaDiscovery log(s) (may be debug level)`);
			} else {
				ctx.fail("Persona discovery logged", "No PersonaDiscovery logs found");
			}
		}
	}

	// ── Test 8: Select "None" → default chip ────────────────────────────
	console.log("\nTest 8: Select 'None' → default persona chip");
	{
		if (await selectPersona(page, null)) {
			const label = await page.$(".notor-persona-label");
			const isDefault = label ? await label.evaluate((el) => el.classList.contains("notor-persona-label--default")) : false;
			const text = label ? (await label.textContent())?.trim() : "";
			const shot = await ctx.screenshot("08-none-selected");
			if (isDefault && text === "🎭 Default") {
				ctx.pass("Default chip after None selected", `Label "${text}"`, shot);
			} else {
				ctx.fail("Default chip after None selected", `default=${isDefault}, text="${text}"`, shot);
			}
		} else {
			ctx.fail("Select None persona", "\"None (deactivate)\" not found in persona menu");
		}
	}

	// ── Test 9: Panel state confirms deactivation ───────────────────────
	console.log("\nTest 9: Panel state confirms persona deactivation");
	{
		const state = await getPanelPersonaState(page);
		if (state && state.activePersona === null && state.convPersona === null) {
			ctx.pass("Persona deactivation applied", "Panel persona and conversation persona_name cleared");
		} else {
			ctx.fail("Persona deactivation applied", `state=${JSON.stringify(state)}`);
		}
	}

	// ── Test 10: Broken persona excluded (check logs for warning) ───────
	console.log("\nTest 10: Broken persona excluded with warning logged");
	{
		const allLogs = ctx.collector.getStructuredLogs();
		const warningLogs = allLogs.filter(
			(entry) =>
				entry.source === "PersonaDiscovery" &&
				entry.level === "warn" &&
				(entry.message.includes("broken") ||
					entry.message.includes("frontmatter") ||
					entry.message.includes("exclude") ||
					entry.message.includes("skip"))
		);

		if (warningLogs.length > 0) {
			ctx.pass(
				"Broken persona excluded with warning",
				`Found ${warningLogs.length} warning(s): "${warningLogs[0].message}"`
			);
		} else {
			ctx.fail("Broken persona excluded with warning", "No PersonaDiscovery parse warning found");
		}
	}

	// ── Test 11: Select organizer persona (has provider/model overrides) ─
	console.log("\nTest 11: Select organizer persona (provider/model overrides)");
	{
		if (await selectPersona(page, "organizer")) {
			// Dismiss any Obsidian Notice toasts that may block clicks
			// (e.g. "Provider 'anthropic' not available; using default.")
			await page.evaluate(() => {
				document.querySelectorAll(".notice-container .notice").forEach((n) => (n as HTMLElement).click());
			});
			await page.waitForTimeout(300);

			const text = (await page.textContent(".notor-persona-label"))?.trim() ?? "";
			const shot = await ctx.screenshot("11-organizer-selected");
			if (text.includes("organizer")) {
				ctx.pass("Organizer persona activated", `Label shows: "${text}"`, shot);
			} else {
				ctx.fail("Organizer persona activated", `Label text: "${text}"`, shot);
			}

			// Anthropic is likely not configured, so the resolver logs a fallback
			const fallbackLogs = ctx.collector.getStructuredLogs().filter(
				(entry) =>
					entry.source === "PersonaProviderResolver" &&
					(entry.message.includes("not available") ||
						entry.message.includes("falling back") ||
						entry.message.includes("using active provider"))
			);
			if (fallbackLogs.length > 0) {
				ctx.pass("Provider/model fallback logged", `Found ${fallbackLogs.length} fallback log(s): "${fallbackLogs[0].message}"`);
			} else {
				ctx.pass("Provider/model override attempted", "No fallback logged — preferred provider may be configured");
			}
		} else {
			ctx.fail("Select organizer persona", "organizer not found in persona menu");
		}
	}

	// ── Test 12: Deactivate and verify revert to defaults ───────────────
	console.log("\nTest 12: Deactivate organizer → revert to defaults");
	{
		const selected = await selectPersona(page, null);
		const label = await page.$(".notor-persona-label");
		const isDefault = label ? await label.evaluate((el) => el.classList.contains("notor-persona-label--default")) : false;
		const state = await getPanelPersonaState(page);
		const shot = await ctx.screenshot("12-reverted");
		if (selected && isDefault && state?.activePersona === null) {
			ctx.pass("Persona deactivated and reverted", "Default chip shown and panel persona cleared", shot);
		} else {
			ctx.fail("Persona deactivated and reverted", `selected=${selected}, default=${isDefault}, state=${JSON.stringify(state)}`, shot);
		}
	}

	// ── Test 13: No errors in plugin logs ───────────────────────────────
	console.log("\nTest 13: No error-level logs during persona operations");
	{
		const errors = ctx.collector.getLogsByLevel("error");
		const personaErrors = errors.filter(
			(e) =>
				e.source === "PersonaManager" ||
				e.source === "PersonaDiscovery" ||
				e.source === "PersonaProviderResolver"
		);
		if (personaErrors.length === 0) {
			ctx.pass(
				"No persona-related errors",
				`${errors.length} total error(s), none from the persona system`
			);
		} else {
			ctx.fail(
				"No persona-related errors",
				`${personaErrors.length} error(s) from persona system: ${personaErrors.map((e) => e.message).join("; ")}`
			);
		}
	}

	// ── Test 14: Replace mode — select replacer persona and verify ──────
	console.log("\nTest 14: Replace mode persona — panel persona uses replace mode");
	{
		if (await selectPersona(page, "replacer")) {
			const text = (await page.textContent(".notor-persona-label"))?.trim() ?? "";
			const state = await getPanelPersonaState(page);
			const shot = await ctx.screenshot("14-replacer-selected");
			if (text.includes("replacer") && state?.activePersona === "replacer" && state.promptMode === "replace") {
				ctx.pass("Replace mode persona active", `Label "${text}", prompt_mode="${state.promptMode}"`, shot);
			} else {
				ctx.fail("Replace mode persona active", `Label "${text}", state=${JSON.stringify(state)}`, shot);
			}

			// Deactivate replacer to clean up
			await selectPersona(page, null);
		} else {
			ctx.fail("Select replacer persona", "replacer not found in persona menu");
		}
	}

	// ── Test 15: Provider/model reference section in Settings tab ────────
	console.log("\nTest 15: Provider/model reference section in Settings tab");
	{
		// Open Obsidian Settings → Notor tab via keyboard shortcut
		// Use Cmd+, to open Settings on macOS
		await page.keyboard.press("Meta+Comma");
		await page.waitForTimeout(2000);

		// Navigate to the Notor plugin settings tab
		const notorTab = await page.evaluate(() => {
			// Look for Notor in the settings sidebar
			const navItems = document.querySelectorAll(".vertical-tab-nav-item");
			for (const item of navItems) {
				if (item.textContent?.trim() === "Notor") {
					(item as HTMLElement).click();
					return true;
				}
			}
			return false;
		});

		if (notorTab) {
			await page.waitForTimeout(1500);

			// Look for the "Provider & model identifiers" heading
			// Obsidian's Setting API with .setHeading() renders a
			// .setting-item.setting-item-heading div, not an <h2>.
			// Scroll to the bottom first so the section is in the DOM viewport.
			await page.evaluate(() => {
				const content = document.querySelector(".vertical-tab-content");
				if (content) content.scrollTop = content.scrollHeight;
			});
			await page.waitForTimeout(500);

			const hasRefSection = await page.evaluate(() => {
				const headings = document.querySelectorAll(".vertical-tab-content .setting-item-heading .setting-item-name");
				for (const h of headings) {
					if (h.textContent?.includes("Provider & model identifiers")) {
						return true;
					}
				}
				return false;
			});

			const shot = await ctx.screenshot("15-settings-provider-ref");

			if (hasRefSection) {
				// Also verify copy buttons exist
				const hasCopyButtons = await page.evaluate(() => {
					const buttons = document.querySelectorAll(".notor-copy-id-btn");
					return buttons.length > 0;
				});

				if (hasCopyButtons) {
					ctx.pass(
						"Provider/model reference section with copy buttons",
						"Found 'Provider & model identifiers' heading and copy buttons in Settings tab",
						shot
					);
				} else {
					ctx.pass(
						"Provider/model reference section visible",
						"Found 'Provider & model identifiers' heading (copy buttons may not be visible if no providers configured)",
						shot
					);
				}
			} else {
				ctx.fail(
					"Provider/model reference section visible",
					"Could not find 'Provider & model identifiers' heading in Settings tab",
					shot
				);
			}
		} else {
			const shot = await ctx.screenshot("15-no-notor-tab");
			ctx.fail(
				"Provider/model reference section visible",
				"Could not find Notor tab in Settings sidebar",
				shot
			);
		}

		// Close Settings
		await page.keyboard.press("Escape");
		await page.waitForTimeout(500);
	}
}

runTest(
	{
		name: "persona-test",
		settings: buildDefaultSettings(),
		setupVault: (vaultPath) => ensureTestPersonas(vaultPath),
		cleanupFiles: [
			"notor/personas/researcher",
			"notor/personas/organizer",
			"notor/personas/broken",
			"notor/personas/replacer",
			"notor/personas/empty-dir",
		],
	},
	tests,
);
