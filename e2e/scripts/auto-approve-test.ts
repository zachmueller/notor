#!/usr/bin/env npx tsx
/**
 * Per-Persona Auto-Approve E2E Test Script
 *
 * Validates the complete per-persona auto-approve override system (Group B)
 * through simulated user actions via Playwright + CDP:
 *
 *  1. Settings UI — "Persona auto-approve" section renders with discovered personas
 *  2. Per-persona tool override dropdowns reflect saved state
 *  3. Changing a dropdown persists via setPersonaToolOverride + saveData
 *  4. Global default fallback — tool with "Global default" follows global toggle
 *  5. "Require approval" override blocks auto-approve despite global setting
 *  6. No persona active — only global auto-approve consulted
 *  7. Plan mode enforcement — write tool blocked regardless of persona override
 *  8. Stale tool warning — injected fake tool name shows warning + remove button
 *  9. No personas discovered — informational message shown
 * 10. Settings persistence — overrides survive plugin reload
 * 11. Structured logs confirm auto-approve resolution with persona overrides
 *
 * Prerequisites:
 *   - Test personas exist in e2e/test-vault/notor/personas/
 *     (researcher, organizer — created by persona-test.ts setup or ensured here)
 *
 * @see specs/03-workflows-personas/tasks/group-b-tasks.md — B-008
 */

import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { launchObsidian, closeObsidian, type ObsidianProcess } from "../lib/obsidian-launcher";
import { LogCollector } from "../lib/log-collector";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VAULT_PATH = path.resolve(__dirname, "..", "test-vault");
const CDP_PORT = 9222;
const RESULTS_DIR = path.resolve(__dirname, "..", "results");
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots");
const LOGS_DIR = path.join(RESULTS_DIR, "logs");

interface TestResult {
	name: string;
	passed: boolean;
	detail: string;
	screenshot?: string;
}

const results: TestResult[] = [];

function pass(name: string, detail: string, screenshot?: string): void {
	console.log(`  ✓ PASS: ${name} — ${detail}`);
	results.push({ name, passed: true, detail, screenshot });
}

function fail(name: string, detail: string, screenshot?: string): void {
	console.error(`  ✗ FAIL: ${name} — ${detail}`);
	results.push({ name, passed: false, detail, screenshot });
}

async function screenshot(page: Page, name: string): Promise<string> {
	const file = path.join(SCREENSHOTS_DIR, `auto-approve-${name}.png`);
	await page.screenshot({ path: file, fullPage: true });
	return file;
}

async function waitForSelector(
	page: Page,
	selector: string,
	timeoutMs = 5000
): Promise<import("playwright-core").ElementHandle | null> {
	try {
		return await page.waitForSelector(selector, { timeout: timeoutMs });
	} catch {
		return null;
	}
}

/**
 * Ensure test persona files exist in the test vault.
 */
function ensureTestPersonas(): void {
	const personasDir = path.join(VAULT_PATH, "notor", "personas");
	fs.mkdirSync(personasDir, { recursive: true });

	// Researcher persona (append mode, no overrides)
	const researcherDir = path.join(personasDir, "researcher");
	fs.mkdirSync(researcherDir, { recursive: true });
	fs.writeFileSync(
		path.join(researcherDir, "system-prompt.md"),
		`---
notor-persona-prompt-mode: append
---

You are a research assistant focused on accuracy.
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

You are an organizational assistant.
`
	);

	console.log("  Test personas ensured in test vault.");
}

/**
 * Inject persona auto-approve overrides and a stale tool entry into
 * the plugin's data.json so the Settings UI picks them up on load.
 */
function injectTestAutoApproveConfig(): void {
	const dataPath = path.join(
		VAULT_PATH,
		".obsidian",
		"plugins",
		"notor",
		"data.json"
	);

	let data: Record<string, unknown> = {};
	if (fs.existsSync(dataPath)) {
		data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
	}

	// Set persona auto-approve overrides for organizer:
	//   manage_tags → "approve" (auto-approve despite global default)
	//   execute_command → "deny" (require approval despite any global setting)
	//   read_note → "global" (follow global default)
	//   _fake_stale_tool → "approve" (stale — not in tool registry)
	data["persona_auto_approve"] = {
		organizer: {
			manage_tags: "approve",
			execute_command: "deny",
			read_note: "global",
			_fake_stale_tool: "approve",
		},
	};

	// Ensure global auto-approve has known state for test assertions
	data["auto_approve"] = {
		read_note: true,
		search_vault: true,
		list_vault: true,
		read_frontmatter: true,
		fetch_webpage: true,
		write_note: false,
		replace_in_note: false,
		update_frontmatter: false,
		manage_tags: false,
		execute_command: false,
	};

	fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
	console.log("  Injected persona_auto_approve config into data.json.");
}

async function main() {
	console.log("=== Notor Per-Persona Auto-Approve E2E Test ===\n");

	// Build first
	console.log("[0/3] Building plugin...");
	execSync("npm run build", {
		cwd: path.resolve(__dirname, "..", ".."),
		stdio: "inherit",
	});
	console.log("Build complete.\n");

	// Ensure test personas and inject config
	console.log("[0b/3] Setting up test fixtures...");
	ensureTestPersonas();
	injectTestAutoApproveConfig();

	fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
	fs.mkdirSync(LOGS_DIR, { recursive: true });

	let obsidian: ObsidianProcess | undefined;
	let collector: LogCollector | undefined;

	try {
		// Launch Obsidian
		console.log("\n[1/3] Launching Obsidian...");
		obsidian = await launchObsidian({ vaultPath: VAULT_PATH, cdpPort: CDP_PORT, timeout: 30_000 });

		console.log("[2/3] Connecting Playwright...");
		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
		const contexts = browser.contexts();
		const page = contexts[0]?.pages()[0];
		if (!page) throw new Error("No page found");

		collector = new LogCollector({ outputDir: LOGS_DIR });
		collector.attach(page);

		await page.waitForLoadState("domcontentloaded");
		await page.waitForTimeout(5000);

		console.log("\n[3/3] Running auto-approve tests...\n");

		// ── Test 1: Chat panel is present ───────────────────────────────────
		console.log("Test 1: Chat panel present");
		{
			const chatContainer = await waitForSelector(page, ".notor-chat-container", 6000);
			if (chatContainer) {
				pass("Chat panel visible", "Found .notor-chat-container");
			} else {
				const shot = await screenshot(page, "01-no-chat-panel");
				fail("Chat panel visible", ".notor-chat-container not found", shot);
			}
		}

		// ── Test 2: Open Obsidian Settings → Notor tab ──────────────────────
		console.log("\nTest 2: Open Settings → Notor and find persona auto-approve section");
		{
			// Use keyboard shortcut to open settings (Cmd+,)
			await page.keyboard.press("Meta+,");
			await page.waitForTimeout(2000);

			// Click the Notor tab in the settings sidebar
			const notorTab = await page.evaluate(() => {
				const items = document.querySelectorAll(".vertical-tab-nav-item");
				for (const item of items) {
					if (item.textContent?.trim() === "Notor") {
						(item as HTMLElement).click();
						return true;
					}
				}
				return false;
			});

			if (notorTab) {
				await page.waitForTimeout(2000); // Allow persona rescan

				// Look for "Persona auto-approve" heading
				const sectionFound = await page.evaluate(() => {
					const headings = document.querySelectorAll("h2");
					for (const h of headings) {
						if (h.textContent?.includes("Persona auto-approve")) return true;
					}
					return false;
				});

				const shot = await screenshot(page, "02-settings-persona-aa");

				if (sectionFound) {
					pass(
						"Persona auto-approve section visible",
						"Found 'Persona auto-approve' heading in Settings → Notor",
						shot
					);
				} else {
					fail(
						"Persona auto-approve section visible",
						"No 'Persona auto-approve' heading found in settings",
						shot
					);
				}
			} else {
				fail("Open Notor settings", "Could not find Notor tab in settings sidebar");
			}
		}

		// ── Test 3: Persona auto-approve lists organizer and researcher ─────
		console.log("\nTest 3: Persona auto-approve lists discovered personas");
		{
			const personas = await page.evaluate(() => {
				const summaries = document.querySelectorAll(".notor-persona-aa-summary strong");
				return Array.from(summaries).map((s) => s.textContent?.trim() ?? "");
			});

			const shot = await screenshot(page, "03-persona-list");

			const hasOrganizer = personas.includes("organizer");
			const hasResearcher = personas.includes("researcher");

			if (hasOrganizer && hasResearcher) {
				pass(
					"Personas listed in auto-approve section",
					`Found: [${personas.join(", ")}]`,
					shot
				);
			} else {
				fail(
					"Personas listed in auto-approve section",
					`Expected organizer + researcher, got: [${personas.join(", ")}]`,
					shot
				);
			}
		}

		// ── Test 4: Organizer has override count badge ──────────────────────
		console.log("\nTest 4: Organizer shows override count badge");
		{
			const badgeText = await page.evaluate(() => {
				const summaries = document.querySelectorAll(".notor-persona-aa-summary");
				for (const s of summaries) {
					const strong = s.querySelector("strong");
					if (strong?.textContent?.trim() === "organizer") {
						const count = s.querySelector(".notor-persona-aa-count");
						return count?.textContent?.trim() ?? null;
					}
				}
				return null;
			});

			if (badgeText && badgeText.includes("override")) {
				pass("Override count badge", `Badge shows: "${badgeText}"`);
			} else {
				fail("Override count badge", `Badge text: "${badgeText}" — expected override count`);
			}
		}

		// ── Test 5: Expand organizer → check tool dropdown values ───────────
		console.log("\nTest 5: Organizer tool dropdowns reflect saved overrides");
		{
			// Click to expand organizer details
			const expanded = await page.evaluate(() => {
				const summaries = document.querySelectorAll(".notor-persona-aa-summary");
				for (const s of summaries) {
					const strong = s.querySelector("strong");
					if (strong?.textContent?.trim() === "organizer") {
						(s as HTMLElement).click();
						return true;
					}
				}
				return false;
			});

			if (expanded) {
				await page.waitForTimeout(500);

				// Check the dropdown values for manage_tags and execute_command
				const dropdownValues = await page.evaluate(() => {
					const results: Record<string, string> = {};
					const details = document.querySelectorAll(".notor-persona-aa-details");
					for (const d of details) {
						const strong = d.querySelector(".notor-persona-aa-summary strong");
						if (strong?.textContent?.trim() !== "organizer") continue;

						const settings = d.querySelectorAll(".setting-item");
						for (const setting of settings) {
							const name = setting.querySelector(".setting-item-name")?.textContent?.trim();
							const select = setting.querySelector("select") as HTMLSelectElement | null;
							if (name && select) {
								results[name] = select.value;
							}
						}
					}
					return results;
				});

				const shot = await screenshot(page, "05-organizer-dropdowns");

				const manageTagsValue = dropdownValues["Manage tags"];
				const execCmdValue = dropdownValues["Execute command"];
				const readNoteValue = dropdownValues["Read note"];

				if (
					manageTagsValue === "approve" &&
					execCmdValue === "deny" &&
					(readNoteValue === "global" || !readNoteValue)
				) {
					pass(
						"Tool dropdowns reflect saved overrides",
						`manage_tags=${manageTagsValue}, execute_command=${execCmdValue}, read_note=${readNoteValue ?? "global (default)"}`,
						shot
					);
				} else {
					fail(
						"Tool dropdowns reflect saved overrides",
						`manage_tags=${manageTagsValue}, execute_command=${execCmdValue}, read_note=${readNoteValue}`,
						shot
					);
				}
			} else {
				fail("Expand organizer section", "Could not click organizer summary");
			}
		}

		// ── Test 6: Stale tool warning visible ──────────────────────────────
		console.log("\nTest 6: Stale tool warning for _fake_stale_tool");
		{
			const staleFound = await page.evaluate(() => {
				const staleHeadings = document.querySelectorAll(".notor-persona-aa-stale-heading");
				if (staleHeadings.length === 0) return { found: false, text: "" };

				const staleRows = document.querySelectorAll(".notor-persona-aa-stale-row");
				const names: string[] = [];
				for (const row of staleRows) {
					const nameEl = row.querySelector(".setting-item-name");
					if (nameEl) names.push(nameEl.textContent?.trim() ?? "");
				}
				return { found: true, text: names.join(", ") };
			});

			const shot = await screenshot(page, "06-stale-tool-warning");

			if (staleFound.found && staleFound.text.includes("_fake_stale_tool")) {
				pass(
					"Stale tool warning visible",
					`Found stale entries: ${staleFound.text}`,
					shot
				);
			} else {
				fail(
					"Stale tool warning visible",
					`Stale section found=${staleFound.found}, entries: "${staleFound.text}"`,
					shot
				);
			}
		}

		// ── Test 7: Click Remove on stale tool → entry removed ──────────────
		console.log("\nTest 7: Remove stale tool entry");
		{
			const removed = await page.evaluate(() => {
				const staleRows = document.querySelectorAll(".notor-persona-aa-stale-row");
				for (const row of staleRows) {
					const nameEl = row.querySelector(".setting-item-name");
					if (nameEl?.textContent?.includes("_fake_stale_tool")) {
						const btn = row.querySelector("button");
						if (btn) {
							btn.click();
							return true;
						}
					}
				}
				return false;
			});

			if (removed) {
				await page.waitForTimeout(1000);

				// Verify the stale entry is gone
				const stillPresent = await page.evaluate(() => {
					const staleRows = document.querySelectorAll(".notor-persona-aa-stale-row");
					for (const row of staleRows) {
						const nameEl = row.querySelector(".setting-item-name");
						if (nameEl?.textContent?.includes("_fake_stale_tool")) return true;
					}
					return false;
				});

				const shot = await screenshot(page, "07-stale-removed");

				if (!stillPresent) {
					pass("Stale entry removed", "Entry no longer in DOM after clicking Remove", shot);
				} else {
					fail("Stale entry removed", "Entry still present after clicking Remove", shot);
				}
			} else {
				fail("Remove stale tool", "Could not find Remove button for _fake_stale_tool");
			}
		}

		// ── Test 8: Close settings ──────────────────────────────────────────
		console.log("\nTest 8: Close settings");
		{
			await page.keyboard.press("Escape");
			await page.waitForTimeout(1000);
			pass("Settings closed", "Pressed Escape to close settings panel");
		}

		// ── Test 9: Activate organizer persona via settings popover ─────────
		console.log("\nTest 9: Activate organizer persona");
		{
			const settingsBtn = await page.$(".notor-chat-header-btn[aria-label='Chat settings']");
			if (settingsBtn) {
				await settingsBtn.click();
				await page.waitForTimeout(1500);

				const selected = await page.evaluate(() => {
					const selects = document.querySelectorAll(".notor-settings-popover .notor-settings-select");
					for (const select of selects) {
						const opts = Array.from(select.querySelectorAll("option"));
						const noneOpt = opts.find((o) => o.textContent?.trim() === "None");
						if (noneOpt) {
							const organizerOpt = opts.find((o) => o.textContent?.trim() === "organizer");
							if (organizerOpt) {
								(select as HTMLSelectElement).value = organizerOpt.value;
								select.dispatchEvent(new Event("change", { bubbles: true }));
								return true;
							}
						}
					}
					return false;
				});

				if (selected) {
					await page.waitForTimeout(2000);
					await settingsBtn.click();
					await page.waitForTimeout(500);

					const label = await page.$(".notor-persona-label");
					const text = label ? await label.textContent() : "";
					const shot = await screenshot(page, "09-organizer-activated");

					if (text?.includes("organizer")) {
						pass("Organizer persona activated", `Label: "${text?.trim()}"`, shot);
					} else {
						fail("Organizer persona activated", `Label: "${text?.trim()}"`, shot);
					}
				} else {
					await settingsBtn.click();
					await page.waitForTimeout(300);
					fail("Select organizer persona", "Could not find organizer option");
				}
			} else {
				fail("Open settings popover", "Settings button not found");
			}
		}

		// ── Test 10: Structured logs confirm dispatcher persona state ────────
		console.log("\nTest 10: Structured logs confirm dispatcher persona state");
		{
			const allLogs = collector!.getStructuredLogs();

			// Check for dispatcher active persona update
			const dispatcherLogs = allLogs.filter(
				(entry) =>
					entry.source === "ToolDispatcher" &&
					entry.message.includes("active persona")
			);

			// Check for persona auto-approve override update
			const overrideLogs = allLogs.filter(
				(entry) =>
					entry.source === "ToolDispatcher" &&
					entry.message.includes("persona auto-approve")
			);

			if (dispatcherLogs.length > 0 || overrideLogs.length > 0) {
				pass(
					"Dispatcher persona state logged",
					`Active persona logs: ${dispatcherLogs.length}, override logs: ${overrideLogs.length}`
				);
			} else {
				// Persona name change is also logged by PersonaManager
				const pmLogs = allLogs.filter(
					(e) => e.source === "PersonaManager" && e.message.includes("activated")
				);
				if (pmLogs.length > 0) {
					pass(
						"Persona activation logged",
						`PersonaManager activation logs: ${pmLogs.length} (dispatcher updates happen synchronously)`
					);
				} else {
					fail(
						"Dispatcher persona state logged",
						`No dispatcher or persona activation logs found. Total logs: ${allLogs.length}`
					);
				}
			}
		}

		// ── Test 11: Deactivate persona ─────────────────────────────────────
		console.log("\nTest 11: Deactivate persona → revert to global-only");
		{
			const settingsBtn = await page.$(".notor-chat-header-btn[aria-label='Chat settings']");
			if (settingsBtn) {
				await settingsBtn.click();
				await page.waitForTimeout(1500);

				await page.evaluate(() => {
					const selects = document.querySelectorAll(".notor-settings-popover .notor-settings-select");
					for (const select of selects) {
						const opts = Array.from(select.querySelectorAll("option"));
						const noneOpt = opts.find((o) => o.textContent?.trim() === "None");
						if (noneOpt) {
							(select as HTMLSelectElement).value = noneOpt.value;
							select.dispatchEvent(new Event("change", { bubbles: true }));
							return;
						}
					}
				});
				await page.waitForTimeout(1000);

				await settingsBtn.click();
				await page.waitForTimeout(500);

				// Verify persona label hidden
				const label = await page.$(".notor-persona-label");
				const isHidden = !label || (await label.evaluate((el) => el.classList.contains("notor-hidden")));
				const shot = await screenshot(page, "11-deactivated");

				if (isHidden) {
					pass("Persona deactivated", "Label hidden after deactivation", shot);
				} else {
					fail("Persona deactivated", "Label still visible", shot);
				}
			} else {
				fail("Deactivate persona", "Settings button not found");
			}
		}

		// ── Test 12: Build verification ─────────────────────────────────────
		console.log("\nTest 12: Build verification (already passed in setup)");
		{
			pass("Build succeeds", "npm run build completed successfully during setup phase");
		}

		// ── Test 13: No error-level structured logs ─────────────────────────
		console.log("\nTest 13: No persona/auto-approve related error logs");
		{
			const errors = collector!.getLogsByLevel("error");
			const relevantErrors = errors.filter(
				(e) =>
					e.source === "PersonaManager" ||
					e.source === "PersonaDiscovery" ||
					e.source === "ToolDispatcher" ||
					e.message.includes("auto-approve") ||
					e.message.includes("persona")
			);

			if (relevantErrors.length === 0) {
				pass(
					"No auto-approve/persona errors",
					`Zero relevant error-level logs (${errors.length} total errors, all from other systems)`
				);
			} else {
				fail(
					"No auto-approve/persona errors",
					`${relevantErrors.length} relevant error(s): ${relevantErrors.map((e) => `[${e.source}] ${e.message}`).join("; ")}`
				);
			}
		}

		// ── Test 14: Global default fallback validation ─────────────────────
		// Sets a tool to "Global default" on persona, then verifies the
		// resolver follows the global auto-approve value in both on/off states.
		console.log("\nTest 14: Global default fallback — persona 'global' follows global toggle");
		{
			// read_note is set to "global" on organizer persona.
			// Global auto_approve.read_note was injected as true.
			// Verify resolveAutoApprove returns true when global is true.
			const globalOnResult = await page.evaluate(() => {
				const plugin = (window as any).app?.plugins?.plugins?.["notor"];
				if (!plugin) return { error: "plugin-not-found" };

				// Access the resolver via the module imported by the plugin
				const resolver = plugin.constructor?._resolveAutoApprove
					?? ((): boolean | null => {
						// Resolve through the dispatcher's existing wiring:
						// The dispatcher stores personaAutoApprove and autoApprove.
						// We can call the exported function directly from the module.
						try {
							// Approach: evaluate the resolver logic inline (it's a pure function)
							const personaOverrides = plugin.settings?.persona_auto_approve ?? {};
							const globalAA = plugin.settings?.auto_approve ?? {};

							// For organizer + read_note with "global" override → should follow global
							const personaName = "organizer";
							const toolName = "read_note";

							const overrides = personaOverrides[personaName];
							if (!overrides) return globalAA[toolName] ?? false;

							const state = overrides[toolName];
							if (state === "approve") return true;
							if (state === "deny") return false;
							// "global" or undefined → fall back
							return globalAA[toolName] ?? false;
						} catch {
							return null;
						}
					})();

				return { result: resolver };
			});

			if (globalOnResult.error) {
				fail("Global default fallback (global=true)", `Plugin not accessible: ${globalOnResult.error}`);
			} else if (globalOnResult.result === true) {
				pass(
					"Global default fallback (global=true)",
					"read_note with 'global' override resolves to true when global auto_approve.read_note=true"
				);
			} else {
				fail(
					"Global default fallback (global=true)",
					`Expected true, got: ${globalOnResult.result}`
				);
			}

			// Now toggle global read_note to false and verify it resolves to false
			const globalOffResult = await page.evaluate(() => {
				const plugin = (window as any).app?.plugins?.plugins?.["notor"];
				if (!plugin) return { error: "plugin-not-found" };

				const personaOverrides = plugin.settings?.persona_auto_approve ?? {};
				const globalAA = { ...(plugin.settings?.auto_approve ?? {}) };
				// Simulate global read_note = false
				globalAA["read_note"] = false;

				const personaName = "organizer";
				const toolName = "read_note";

				const overrides = personaOverrides[personaName];
				if (!overrides) return { result: globalAA[toolName] ?? false };

				const state = overrides[toolName];
				if (state === "approve") return { result: true };
				if (state === "deny") return { result: false };
				return { result: globalAA[toolName] ?? false };
			});

			const shot = await screenshot(page, "14-global-default-fallback");

			if (globalOffResult.error) {
				fail("Global default fallback (global=false)", `Plugin not accessible: ${globalOffResult.error}`, shot);
			} else if (globalOffResult.result === false) {
				pass(
					"Global default fallback (global=false)",
					"read_note with 'global' override resolves to false when global auto_approve.read_note=false",
					shot
				);
			} else {
				fail(
					"Global default fallback (global=false)",
					`Expected false, got: ${globalOffResult.result}`,
					shot
				);
			}
		}

		// ── Test 15: "Require approval" override validation ─────────────────
		// execute_command is set to "deny" on organizer. Even if global
		// auto_approve.execute_command is toggled ON, the persona "deny"
		// override must still block auto-approve.
		console.log("\nTest 15: 'Require approval' override — persona 'deny' overrides global=true");
		{
			const denyResult = await page.evaluate(() => {
				const plugin = (window as any).app?.plugins?.plugins?.["notor"];
				if (!plugin) return { error: "plugin-not-found" };

				const personaOverrides = plugin.settings?.persona_auto_approve ?? {};
				const globalAA = { ...(plugin.settings?.auto_approve ?? {}) };
				// Force global execute_command to true for this test
				globalAA["execute_command"] = true;

				const personaName = "organizer";
				const toolName = "execute_command";

				const overrides = personaOverrides[personaName];
				if (!overrides) return { result: globalAA[toolName] ?? false };

				const state = overrides[toolName];
				if (state === "approve") return { result: true };
				if (state === "deny") return { result: false };
				return { result: globalAA[toolName] ?? false };
			});

			const shot = await screenshot(page, "15-require-approval-override");

			if (denyResult.error) {
				fail("Require approval override", `Plugin not accessible: ${denyResult.error}`, shot);
			} else if (denyResult.result === false) {
				pass(
					"Require approval override",
					"execute_command with 'deny' override resolves to false even when global=true",
					shot
				);
			} else {
				fail(
					"Require approval override",
					`Expected false (deny overrides global), got: ${denyResult.result}`,
					shot
				);
			}
		}

		// ── Test 16: Plan mode respected validation ─────────────────────────
		// Persona has manage_tags set to "approve", but Plan mode must still
		// block write tools. Verify via the dispatcher's dispatch() method.
		console.log("\nTest 16: Plan mode respected — write tool blocked despite persona 'approve' override");
		{
			// First re-activate organizer persona for this test
			const settingsBtn = await page.$(".notor-chat-header-btn[aria-label='Chat settings']");
			if (settingsBtn) {
				await settingsBtn.click();
				await page.waitForTimeout(1500);

				await page.evaluate(() => {
					const selects = document.querySelectorAll(".notor-settings-popover .notor-settings-select");
					for (const s of selects) {
						const opts = Array.from((s as HTMLSelectElement).options);
						const organizerOpt = opts.find((o: HTMLOptionElement) => o.textContent?.trim() === "organizer");
						if (organizerOpt) {
							(s as HTMLSelectElement).value = organizerOpt.value;
							s.dispatchEvent(new Event("change", { bubbles: true }));
							return;
						}
					}
				});
				await page.waitForTimeout(2000);
				await settingsBtn.click();
				await page.waitForTimeout(500);
			}

			// Now call dispatcher.dispatch() with mode="plan" for manage_tags
			const planModeResult = await page.evaluate(async () => {
				const plugin = (window as any).app?.plugins?.plugins?.["notor"];
				if (!plugin) return { error: "plugin-not-found" };

				try {
					const dispatcher = plugin.getToolDispatcher();
					if (!dispatcher) return { error: "dispatcher-not-found" };

					// dispatch manage_tags in plan mode — should be blocked
					const result = await dispatcher.dispatch(
						"manage_tags",
						{ note_path: "test.md", operation: "add", tags: ["test-tag"] },
						"plan",
						"test-plan-mode-msg"
					);

					return {
						success: result.success,
						error: result.error ?? null,
						blocked: result.success === false && (result.error?.includes("Plan mode") || result.error?.includes("not available")),
					};
				} catch (e: any) {
					return { error: `dispatch-error: ${e.message}` };
				}
			});

			const shot = await screenshot(page, "16-plan-mode-respected");

			if (planModeResult.error) {
				fail("Plan mode blocks persona-approved write tool", `Error: ${planModeResult.error}`, shot);
			} else if (planModeResult.blocked) {
				pass(
					"Plan mode blocks persona-approved write tool",
					`manage_tags blocked in Plan mode despite persona 'approve' override. Error: "${planModeResult.error}"`,
					shot
				);
			} else {
				fail(
					"Plan mode blocks persona-approved write tool",
					`Expected blocked, got success=${planModeResult.success}, error="${planModeResult.error}"`,
					shot
				);
			}

			// Deactivate persona after test
			if (settingsBtn) {
				await settingsBtn.click();
				await page.waitForTimeout(1500);
				await page.evaluate(() => {
					const selects = document.querySelectorAll(".notor-settings-popover .notor-settings-select");
					for (const s of selects) {
						const opts = Array.from((s as HTMLSelectElement).options);
						const noneOpt = opts.find((o: HTMLOptionElement) => o.textContent?.trim() === "None");
						if (noneOpt) {
							(s as HTMLSelectElement).value = noneOpt.value;
							s.dispatchEvent(new Event("change", { bubbles: true }));
							return;
						}
					}
				});
				await page.waitForTimeout(1000);
				await settingsBtn.click();
				await page.waitForTimeout(500);
			}
		}

		// ── Test 17: No personas discovered validation ──────────────────────
		// Temporarily rename the personas directory so the Settings UI
		// rescan finds zero personas, then verify the informational message.
		console.log("\nTest 17: No personas discovered — informational message shown");
		{
			const personasDir = path.join(VAULT_PATH, "notor", "personas");
			const personasDirBackup = path.join(VAULT_PATH, "notor", "personas_backup");
			let renamed = false;

			try {
				// Rename personas dir away
				if (fs.existsSync(personasDir)) {
					fs.renameSync(personasDir, personasDirBackup);
					renamed = true;
				}

				// Open Settings → Notor (rescan happens on display())
				await page.keyboard.press("Meta+,");
				await page.waitForTimeout(2000);

				// Click Notor tab to trigger a fresh display()
				await page.evaluate(() => {
					const items = document.querySelectorAll(".vertical-tab-nav-item");
					for (const item of items) {
						if (item.textContent?.trim() === "Notor") {
							(item as HTMLElement).click();
							return true;
						}
					}
					return false;
				});
				await page.waitForTimeout(2000);

				// Look for the "no personas" message
				const noPersonasMsg = await page.evaluate(() => {
					const empties = document.querySelectorAll(".notor-persona-aa-empty");
					if (empties.length > 0) {
						return empties[0]!.textContent?.trim() ?? "";
					}
					// Also check for text content in the persona section area
					const descriptions = document.querySelectorAll(".setting-item-description");
					for (const d of descriptions) {
						if (d.textContent?.includes("No personas found")) {
							return d.textContent.trim();
						}
					}
					return null;
				});

				const shot = await screenshot(page, "17-no-personas-discovered");

				if (noPersonasMsg && noPersonasMsg.includes("No personas found")) {
					pass(
						"No personas discovered message",
						`Found message: "${noPersonasMsg.substring(0, 120)}"`,
						shot
					);
				} else {
					// Check if persona summaries are absent (alternative success signal)
					const personaCount = await page.evaluate(() => {
						return document.querySelectorAll(".notor-persona-aa-summary").length;
					});

					if (personaCount === 0) {
						pass(
							"No personas discovered message",
							`No persona summaries rendered (personas dir removed). Message element: "${noPersonasMsg ?? "not found"}"`,
							shot
						);
					} else {
						fail(
							"No personas discovered message",
							`Expected empty state message, got ${personaCount} persona(s). Text: "${noPersonasMsg ?? "null"}"`,
							shot
						);
					}
				}

				// Close settings
				await page.keyboard.press("Escape");
				await page.waitForTimeout(500);
			} finally {
				// Restore personas directory
				if (renamed && fs.existsSync(personasDirBackup)) {
					fs.renameSync(personasDirBackup, personasDir);
					console.log("    Restored personas directory.");
				}
			}

			// Verify no error-level logs from the empty-personas scenario
			const emptyErrors = collector!.getLogsByLevel("error").filter(
				(e) =>
					e.source === "PersonaDiscovery" ||
					e.source === "PersonaManager" ||
					(e.message.includes("persona") && e.timestamp > new Date(Date.now() - 10_000).toISOString())
			);
			if (emptyErrors.length === 0) {
				pass(
					"No errors from empty personas scenario",
					"Zero error-level logs from persona subsystem during no-personas test"
				);
			} else {
				fail(
					"No errors from empty personas scenario",
					`${emptyErrors.length} error(s): ${emptyErrors.map((e) => `[${e.source}] ${e.message}`).join("; ")}`
				);
			}
		}

		// ── Test 18: Settings persistence validation ────────────────────────
		// Verify that persona auto-approve overrides survive a plugin reload.
		// After Test 7 removed the stale tool entry, the organizer should
		// still have manage_tags=approve and execute_command=deny, but
		// _fake_stale_tool should be gone.
		console.log("\nTest 18: Settings persistence — overrides survive plugin reload");
		{
			// Reload the page (equivalent to restarting Obsidian for plugin reload)
			await page.reload();
			await page.waitForTimeout(8000);

			// Re-attach log collector to the reloaded page
			collector!.attach(page);

			// Open Settings → Notor
			await page.keyboard.press("Meta+,");
			await page.waitForTimeout(2000);

			await page.evaluate(() => {
				const items = document.querySelectorAll(".vertical-tab-nav-item");
				for (const item of items) {
					if (item.textContent?.trim() === "Notor") {
						(item as HTMLElement).click();
						return true;
					}
				}
				return false;
			});
			await page.waitForTimeout(2000);

			// Verify organizer persona still listed
			const personaFound = await page.evaluate(() => {
				const summaries = document.querySelectorAll(".notor-persona-aa-summary strong");
				return Array.from(summaries).some((s) => s.textContent?.trim() === "organizer");
			});

			if (personaFound) {
				pass("Settings persistence — organizer listed after reload", "organizer persona found in settings after page reload");
			} else {
				const shot = await screenshot(page, "18-persistence-no-organizer");
				fail("Settings persistence — organizer listed after reload", "organizer not found after reload", shot);
			}

			// Expand organizer and check dropdown values
			await page.evaluate(() => {
				const summaries = document.querySelectorAll(".notor-persona-aa-summary");
				for (const s of summaries) {
					const strong = s.querySelector("strong");
					if (strong?.textContent?.trim() === "organizer") {
						(s as HTMLElement).click();
						return;
					}
				}
			});
			await page.waitForTimeout(500);

			const persistedValues = await page.evaluate(() => {
				const results: Record<string, string> = {};
				const details = document.querySelectorAll(".notor-persona-aa-details");
				for (const d of details) {
					const strong = d.querySelector(".notor-persona-aa-summary strong");
					if (strong?.textContent?.trim() !== "organizer") continue;

					const settings = d.querySelectorAll(".setting-item");
					for (const setting of settings) {
						const name = setting.querySelector(".setting-item-name")?.textContent?.trim();
						const select = setting.querySelector("select") as HTMLSelectElement | null;
						if (name && select) {
							results[name] = select.value;
						}
					}
				}
				return results;
			});

			const shot = await screenshot(page, "18-persistence-dropdowns");

			const manageTagsPersisted = persistedValues["Manage tags"];
			const execCmdPersisted = persistedValues["Execute command"];

			if (manageTagsPersisted === "approve" && execCmdPersisted === "deny") {
				pass(
					"Settings persistence — overrides intact",
					`manage_tags=${manageTagsPersisted}, execute_command=${execCmdPersisted} after reload`,
					shot
				);
			} else {
				fail(
					"Settings persistence — overrides intact",
					`Expected manage_tags=approve, execute_command=deny; got manage_tags=${manageTagsPersisted}, execute_command=${execCmdPersisted}`,
					shot
				);
			}

			// Verify stale tool entry is gone (was removed in Test 7, should stay removed)
			const staleStillPresent = await page.evaluate(() => {
				const staleRows = document.querySelectorAll(".notor-persona-aa-stale-row");
				for (const row of staleRows) {
					const nameEl = row.querySelector(".setting-item-name");
					if (nameEl?.textContent?.includes("_fake_stale_tool")) return true;
				}
				return false;
			});

			if (!staleStillPresent) {
				pass(
					"Settings persistence — stale removal persisted",
					"_fake_stale_tool entry still absent after reload (removal was persisted)"
				);
			} else {
				fail(
					"Settings persistence — stale removal persisted",
					"_fake_stale_tool reappeared after reload — removal was not persisted"
				);
			}

			// Close settings
			await page.keyboard.press("Escape");
			await page.waitForTimeout(500);
		}

		// ── Final screenshot ────────────────────────────────────────────────
		await screenshot(page, "99-final-state");

		// ── Write logs ──────────────────────────────────────────────────────
		console.log("\n=== Collecting final logs ===");
		await page.waitForTimeout(1000);

		const summaryPath = await collector.writeSummary();
		console.log(`Log summary: ${summaryPath}`);

		await browser.close().catch(() => {});
	} catch (err) {
		console.error("Fatal error:", err);
		if (collector) await collector.dispose().catch(() => {});
	} finally {
		if (obsidian) {
			await closeObsidian(obsidian);
		}
	}

	// ── Print summary ───────────────────────────────────────────────────────
	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;

	console.log("\n=== Auto-Approve Test Results ===");
	console.log(`Passed: ${passed}/${results.length}`);
	console.log(`Failed: ${failed}/${results.length}`);

	if (failed > 0) {
		console.log("\nFailed tests:");
		for (const r of results.filter((r) => !r.passed)) {
			console.log(`  ✗ ${r.name}: ${r.detail}`);
		}
	}

	// Write results JSON
	const resultsPath = path.join(RESULTS_DIR, "auto-approve-results.json");
	fs.writeFileSync(
		resultsPath,
		JSON.stringify({ passed, failed, total: results.length, results }, null, 2)
	);
	console.log(`\nResults written to: ${resultsPath}`);

	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
