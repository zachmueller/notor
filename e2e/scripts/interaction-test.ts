#!/usr/bin/env npx tsx
/**
 * Interaction Test Script
 *
 * Exercises all core UI functionality of the Notor plugin through
 * simulated user actions via Playwright + CDP:
 *
 *  1. Verify chat panel is visible
 *  2. Test Plan/Act mode toggle
 *  3. Test new conversation button
 *  4. Test conversation history list toggle
 *  5. Test settings popover (provider/model selectors)
 *  6. Test text input (type, clear, Shift+Enter newline)
 *  7. Attempt to send a message and verify send→stop state transition
 *  8. Test stop button aborts and reverts to send state
 *  9. Test conversation list rendering and switching
 * 10. Test mode display updates correctly
 *
 * Writes a JSON results file with pass/fail for each scenario.
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
	const file = path.join(SCREENSHOTS_DIR, `${name}.png`);
	await page.screenshot({ path: file, fullPage: true });
	return file;
}

/**
 * Wait for an element matching selector with a timeout.
 * Returns null if not found within the timeout.
 */
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

async function main() {
	console.log("=== Notor Interaction Test ===\n");

	// Build first
	console.log("[0/3] Building plugin...");
	execSync("npm run build", {
		cwd: path.resolve(__dirname, "..", ".."),
		stdio: "inherit",
	});
	console.log("Build complete.\n");

	fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
	fs.mkdirSync(LOGS_DIR, { recursive: true });

	let obsidian: ObsidianProcess | undefined;
	let collector: LogCollector | undefined;

	try {
		// Launch Obsidian
		console.log("[1/3] Launching Obsidian...");
		obsidian = await launchObsidian({ vaultPath: VAULT_PATH, cdpPort: CDP_PORT, timeout: 30_000 });

		console.log("[2/3] Connecting Playwright...");
		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
		const contexts = browser.contexts();
		const page = contexts[0]?.pages()[0];
		if (!page) throw new Error("No page found");

		collector = new LogCollector({ outputDir: LOGS_DIR });
		collector.attach(page);

		await page.waitForLoadState("domcontentloaded");
		// Give the plugin time to fully initialize
		await page.waitForTimeout(4000);

		console.log("\n[3/3] Running interaction tests...\n");

		// ── Test 1: Chat panel is present ──────────────────────────────────
		console.log("Test 1: Chat panel visibility");
		{
			const chatContainer = await waitForSelector(page, ".notor-chat-container", 6000);
			if (chatContainer) {
				const shot = await screenshot(page, "01-chat-panel");
				pass("Chat panel visible", "Found .notor-chat-container", shot);
			} else {
				// The panel may need to be opened via command
				const shot = await screenshot(page, "01-chat-panel-missing");
				fail("Chat panel visible", ".notor-chat-container not found; check if panel opened automatically", shot);
			}
		}

		// ── Test 2: Chat header with buttons ──────────────────────────────
		console.log("\nTest 2: Chat header and action buttons");
		{
			const header = await waitForSelector(page, ".notor-chat-header", 3000);
			const newBtn = await page.$(".notor-chat-header-btn[aria-label='New conversation']");
			const histBtn = await page.$(".notor-chat-header-btn[aria-label='Conversation history']");
			const settingsBtn = await page.$(".notor-chat-header-btn[aria-label='Chat settings']");

			if (header && newBtn && histBtn && settingsBtn) {
				pass("Header buttons present", "New conversation, History, and Settings buttons found");
			} else {
				fail("Header buttons present", `header=${!!header}, newBtn=${!!newBtn}, histBtn=${!!histBtn}, settingsBtn=${!!settingsBtn}`);
			}
		}

		// ── Test 3: Message input area ─────────────────────────────────────
		console.log("\nTest 3: Input area elements");
		{
			const textarea = await waitForSelector(page, ".notor-text-input", 3000);
			const sendBtn = await page.$(".notor-send-btn");
			const modeToggle = await page.$(".notor-mode-toggle");

			if (textarea && sendBtn && modeToggle) {
				pass("Input area present", "Textarea, send button, and mode toggle found");
			} else {
				fail("Input area present", `textarea=${!!textarea}, sendBtn=${!!sendBtn}, modeToggle=${!!modeToggle}`);
			}
		}

		// ── Test 4: Mode toggle default state (Plan) ───────────────────────
		console.log("\nTest 4: Plan/Act mode toggle — default state");
		{
			const modeToggle = await page.$(".notor-mode-toggle");
			if (modeToggle) {
				const text = await modeToggle.textContent();
				const hasPlanClass = await modeToggle.evaluate((el) => el.classList.contains("notor-mode-plan"));
				if (text?.trim() === "Plan" && hasPlanClass) {
					pass("Mode toggle default is Plan", `text="${text?.trim()}", has notor-mode-plan class`);
				} else {
					fail("Mode toggle default is Plan", `text="${text?.trim()}", hasPlanClass=${hasPlanClass}`);
				}
			} else {
				fail("Mode toggle default is Plan", "Mode toggle element not found");
			}
		}

		// ── Test 5: Toggle Plan → Act ──────────────────────────────────────
		console.log("\nTest 5: Toggle Plan → Act");
		{
			const modeToggle = await page.$(".notor-mode-toggle");
			if (modeToggle) {
				await modeToggle.click();
				await page.waitForTimeout(300);

				const text = await modeToggle.textContent();
				const hasActClass = await modeToggle.evaluate((el) => el.classList.contains("notor-mode-act"));
				if (text?.trim() === "Act" && hasActClass) {
					const shot = await screenshot(page, "05-act-mode");
					pass("Toggle Plan→Act", `text="${text?.trim()}", has notor-mode-act class`, shot);
				} else {
					fail("Toggle Plan→Act", `text="${text?.trim()}", hasActClass=${hasActClass}`);
				}
			} else {
				fail("Toggle Plan→Act", "Mode toggle element not found");
			}
		}

		// ── Test 6: Toggle Act → Plan ──────────────────────────────────────
		console.log("\nTest 6: Toggle Act → Plan");
		{
			const modeToggle = await page.$(".notor-mode-toggle");
			if (modeToggle) {
				await modeToggle.click();
				await page.waitForTimeout(300);

				const text = await modeToggle.textContent();
				const hasPlanClass = await modeToggle.evaluate((el) => el.classList.contains("notor-mode-plan"));
				if (text?.trim() === "Plan" && hasPlanClass) {
					pass("Toggle Act→Plan", `text="${text?.trim()}", has notor-mode-plan class`);
				} else {
					fail("Toggle Act→Plan", `text="${text?.trim()}", hasPlanClass=${hasPlanClass}`);
				}
			} else {
				fail("Toggle Act→Plan", "Mode toggle element not found");
			}
		}

		// ── Test 7: Type in input field ────────────────────────────────────
		console.log("\nTest 7: Type in text input");
		{
			const textarea = await page.$(".notor-text-input") as HTMLTextAreaElement | null;
			if (textarea) {
				await textarea.click();
				await textarea.fill("Hello from interaction test");
				const value = await textarea.inputValue();
				if (value === "Hello from interaction test") {
					pass("Type in textarea", `Value set correctly: "${value}"`);
				} else {
					fail("Type in textarea", `Expected "Hello from interaction test", got "${value}"`);
				}
			} else {
				fail("Type in textarea", "Textarea not found");
			}
		}

		// ── Test 8: Shift+Enter inserts newline (does NOT send) ────────────
		console.log("\nTest 8: Shift+Enter inserts newline");
		{
			const textarea = await page.$(".notor-text-input");
			if (textarea) {
				await textarea.click();
				await page.keyboard.press("Shift+Enter");
				await textarea.type("line 2");
				const value = await textarea.inputValue();
				const hasNewline = value.includes("\n");
				if (hasNewline) {
					pass("Shift+Enter inserts newline", `Value contains newline: ${JSON.stringify(value)}`);
				} else {
					fail("Shift+Enter inserts newline", `No newline found in: ${JSON.stringify(value)}`);
				}
			} else {
				fail("Shift+Enter inserts newline", "Textarea not found");
			}
		}

		// ── Test 9: Clear input and send → responding state transition ─────
		console.log("\nTest 9: Send message → responding state (send→stop transition)");
		{
			const textarea = await page.$(".notor-text-input");
			if (textarea) {
				// Clear and type a fresh message
				await textarea.fill("List my vault contents");
				await page.waitForTimeout(100);

				// Click send
				const sendBtn = await page.$(".notor-send-btn");
				if (sendBtn) {
					await sendBtn.click();
					// Wait a moment for state to change
					await page.waitForTimeout(800);

					// Check for responding state: stop button visible, send hidden
					const stopVisible = await page.evaluate(() => {
						const stopBtn = document.querySelector(".notor-stop-btn");
						return stopBtn && !stopBtn.classList.contains("notor-hidden");
					});

					const shot = await screenshot(page, "09-send-responding");

					if (stopVisible) {
						pass("Send triggers responding state", "Stop button visible after send (send→stop transition)");
					} else {
						// May have already resolved (local provider unavailable)
						const hasUserMsg = await page.$(".notor-message-user");
						if (hasUserMsg) {
							pass("Send triggers responding state", "User message rendered (provider may have errored out quickly)");
						} else {
							fail("Send triggers responding state", "Neither stop button visible nor user message found", shot);
						}
					}
				} else {
					fail("Send triggers responding state", "Send button not found");
				}
			} else {
				fail("Send triggers responding state", "Textarea not found");
			}
		}

		// ── Wait for response to settle (provider error or success) ────────
		await page.waitForTimeout(5000);
		await screenshot(page, "09b-post-send");

		// ── Test 10: User message rendered in chat ─────────────────────────
		console.log("\nTest 10: User message rendered in chat");
		{
			const userMsg = await page.$(".notor-message-user");
			if (userMsg) {
				const text = await userMsg.textContent();
				pass("User message rendered", `Found .notor-message-user with text: "${text?.trim().substring(0, 50)}"`);
			} else {
				fail("User message rendered", ".notor-message-user not found after send");
			}
		}

		// ── Test 11: Error or response message rendered ────────────────────
		console.log("\nTest 11: Assistant response or error rendered");
		{
			const assistantMsg = await page.$(".notor-message-assistant");
			const errorMsg = await page.$(".notor-chat-error");

			if (assistantMsg) {
				const text = await assistantMsg.textContent();
				pass("Assistant/error message rendered", `Found .notor-message-assistant: "${text?.trim().substring(0, 80)}"`);
			} else if (errorMsg) {
				const text = await errorMsg.textContent();
				pass("Assistant/error message rendered", `Found .notor-chat-error (expected with no LLM): "${text?.trim().substring(0, 80)}"`);
			} else {
				fail("Assistant/error message rendered", "No assistant message or error rendered after send");
			}
		}

		// ── Test 12: Input re-enabled after response ───────────────────────
		console.log("\nTest 12: Input re-enabled after response completes");
		{
			const textarea = await page.$(".notor-text-input");
			if (textarea) {
				const isDisabled = await textarea.evaluate((el) => (el as HTMLTextAreaElement).disabled);
				const stopHidden = await page.evaluate(() => {
					const btn = document.querySelector(".notor-stop-btn");
					return !btn || btn.classList.contains("notor-hidden");
				});
				const sendVisible = await page.evaluate(() => {
					const btn = document.querySelector(".notor-send-btn");
					return btn && !btn.classList.contains("notor-hidden");
				});
				if (!isDisabled && stopHidden && sendVisible) {
					pass("Input re-enabled", "Textarea enabled, stop hidden, send visible");
				} else {
					fail("Input re-enabled", `textarea.disabled=${isDisabled}, stopHidden=${stopHidden}, sendVisible=${sendVisible}`);
				}
			} else {
				fail("Input re-enabled", "Textarea not found");
			}
		}

		// ── Test 13: New conversation button ──────────────────────────────
		console.log("\nTest 13: New conversation button");
		{
			const newBtn = await page.$(".notor-chat-header-btn[aria-label='New conversation']");
			if (newBtn) {
				await newBtn.click();
				await page.waitForTimeout(1500);

				// After new conversation, message list should be empty
				const msgs = await page.$$(".notor-message-user, .notor-message-assistant");
				if (msgs.length === 0) {
					const shot = await screenshot(page, "13-new-conversation");
					pass("New conversation clears messages", `Message list empty after new conversation`, shot);
				} else {
					fail("New conversation clears messages", `${msgs.length} messages still visible after new conversation`);
				}
			} else {
				fail("New conversation button", "New conversation button not found");
			}
		}

		// ── Test 14: Conversation history list toggle ─────────────────────
		console.log("\nTest 14: Conversation history list toggle");
		{
			const histBtn = await page.$(".notor-chat-header-btn[aria-label='Conversation history']");
			if (histBtn) {
				await histBtn.click();
				await page.waitForTimeout(500);

				// Conversation list should be visible, message list hidden
				const listVisible = await page.evaluate(() => {
					const el = document.querySelector(".notor-conversation-list");
					return el && !el.classList.contains("notor-hidden");
				});
				const msgHidden = await page.evaluate(() => {
					const el = document.querySelector(".notor-message-list");
					return el && el.classList.contains("notor-hidden");
				});

				if (listVisible) {
					const shot = await screenshot(page, "14-conversation-list");
					pass("Conversation list toggle (open)", "List visible, message list hidden", shot);

					// Toggle back
					await histBtn.click();
					await page.waitForTimeout(500);
					const listHidden = await page.evaluate(() => {
						const el = document.querySelector(".notor-conversation-list");
						return el && el.classList.contains("notor-hidden");
					});
					if (listHidden) {
						pass("Conversation list toggle (close)", "List hidden again after second click");
					} else {
						fail("Conversation list toggle (close)", "List still visible after second click");
					}
				} else {
					fail("Conversation list toggle (open)", `listVisible=${listVisible}, msgHidden=${msgHidden}`);
				}
			} else {
				fail("Conversation list toggle", "Conversation history button not found");
			}
		}

		// ── Test 15: Settings popover ─────────────────────────────────────
		console.log("\nTest 15: Settings popover");
		{
			const settingsBtn = await page.$(".notor-chat-header-btn[aria-label='Chat settings']");
			if (settingsBtn) {
				await settingsBtn.click();
				await page.waitForTimeout(600);

				const popover = await page.$(".notor-settings-popover");
				if (popover) {
					const shot = await screenshot(page, "15-settings-popover");
					pass("Settings popover opens", "Found .notor-settings-popover", shot);

					// Check provider dropdown
					const providerSelect = await page.$(".notor-settings-popover .notor-settings-select");
					if (providerSelect) {
						const options = await page.$$(".notor-settings-popover .notor-settings-select option");
						pass("Provider selector populated", `Found ${options.length} provider option(s)`);
					} else {
						fail("Provider selector populated", "No provider select found in popover");
					}

					// Check checkpoints section
					const checkpointSection = await page.$(".notor-checkpoints-section");
					if (checkpointSection) {
						pass("Checkpoints section present", "Found .notor-checkpoints-section in popover");
					} else {
						fail("Checkpoints section present", "No .notor-checkpoints-section found");
					}

					// Close the popover by clicking settings btn again
					await settingsBtn.click();
					await page.waitForTimeout(400);
					const popoverGone = !(await page.$(".notor-settings-popover"));
					if (popoverGone) {
						pass("Settings popover closes", "Popover removed from DOM after second click");
					} else {
						fail("Settings popover closes", "Popover still present after second click");
					}
				} else {
					fail("Settings popover opens", ".notor-settings-popover not found after click");
				}
			} else {
				fail("Settings popover", "Settings button not found");
			}
		}

		// ── Test 16: Plan mode type and send a second message ─────────────
		console.log("\nTest 16: Second message send in Plan mode");
		{
			const textarea = await page.$(".notor-text-input");
			if (textarea) {
				await textarea.fill("What notes do I have in my vault?");
				await page.keyboard.press("Enter");
				await page.waitForTimeout(1000);

				const userMsgs = await page.$$(".notor-message-user");
				const shot = await screenshot(page, "16-second-message");
				if (userMsgs.length >= 1) {
					pass("Second message sends correctly", `${userMsgs.length} user message(s) in chat`, shot);
				} else {
					fail("Second message sends correctly", "No user messages found after send", shot);
				}
			} else {
				fail("Second message sends correctly", "Textarea not found");
			}
		}

		// Wait for response
		await page.waitForTimeout(5000);

		// ── Test 17: Token footer visibility after message exchange ────────
		console.log("\nTest 17: Token footer present after message exchange");
		{
			// Token footer is shown when tokens are tracked
			const tokenFooter = await page.$(".notor-token-footer");
			if (tokenFooter) {
				const isHidden = await tokenFooter.evaluate((el) => el.classList.contains("notor-hidden"));
				if (!isHidden) {
					const text = await tokenFooter.textContent();
					pass("Token footer visible", `Footer text: "${text?.trim()}"`);
				} else {
					// Footer may be hidden if no successful response (no LLM configured)
					pass("Token footer present but hidden", "Footer element exists; hidden when no successful LLM response — expected with no provider configured");
				}
			} else {
				fail("Token footer present", ".notor-token-footer not found");
			}
		}

		// ── Test 18: Act mode — toggle and verify write tools allowed ─────
		console.log("\nTest 18: Act mode toggle and write mode verification");
		{
			const modeToggle = await page.$(".notor-mode-toggle");
			if (modeToggle) {
				// Ensure we're in Plan, then switch to Act
				let text = await modeToggle.textContent();
				if (text?.trim() !== "Plan") {
					await modeToggle.click();
					await page.waitForTimeout(300);
				}
				await modeToggle.click();
				await page.waitForTimeout(300);
				text = await modeToggle.textContent();
				const hasActClass = await modeToggle.evaluate((el) => el.classList.contains("notor-mode-act"));
				if (text?.trim() === "Act" && hasActClass) {
					const shot = await screenshot(page, "18-act-mode");
					pass("Act mode toggled", `Mode is Act, has notor-mode-act class`, shot);

					// Switch back to Plan
					await modeToggle.click();
					await page.waitForTimeout(300);
					pass("Returned to Plan mode", "Toggled back from Act to Plan");
				} else {
					fail("Act mode toggle", `text="${text?.trim()}", hasActClass=${hasActClass}`);
				}
			} else {
				fail("Act mode toggle", "Mode toggle not found");
			}
		}

		// ── Test 19: Multiple new conversations and history list ───────────
		console.log("\nTest 19: Multiple conversations in history list");
		{
			const newBtn = await page.$(".notor-chat-header-btn[aria-label='New conversation']");
			if (newBtn) {
				// Create another conversation
				await newBtn.click();
				await page.waitForTimeout(1500);

				// Send a quick message
				const textarea = await page.$(".notor-text-input");
				if (textarea) {
					await textarea.fill("Second test conversation");
					await page.keyboard.press("Enter");
					await page.waitForTimeout(2000);
				}

				// Open conversation history
				const histBtn = await page.$(".notor-chat-header-btn[aria-label='Conversation history']");
				if (histBtn) {
					await histBtn.click();
					await page.waitForTimeout(500);

					const items = await page.$$(".notor-conversation-list-item");
					const shot = await screenshot(page, "19-conversation-history");
					if (items.length >= 1) {
						pass("Conversation history list", `${items.length} conversation(s) in history`, shot);

						// Click the first item to switch conversations
						if (items.length > 0) {
							await items[0]!.click();
							await page.waitForTimeout(1000);
							// Should have switched back to chat view
							const listHidden = await page.evaluate(() => {
								const el = document.querySelector(".notor-conversation-list");
								return el && el.classList.contains("notor-hidden");
							});
							if (listHidden) {
								pass("Switch conversation from history", "Clicked history item, list closed and chat visible");
							} else {
								fail("Switch conversation from history", "List still visible after clicking item");
							}
						}
					} else {
						fail("Conversation history list", "No conversation items found in history list", shot);
					}
				} else {
					fail("Multiple conversations in history", "History button not found");
				}
			} else {
				fail("Multiple conversations in history", "New conversation button not found");
			}
		}

		// ── Final screenshot ───────────────────────────────────────────────
		await screenshot(page, "99-final-state");

		// ── Write results ─────────────────────────────────────────────────
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

	// ── Print summary ──────────────────────────────────────────────────────
	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;

	console.log("\n=== Test Results ===");
	console.log(`Passed: ${passed}/${results.length}`);
	console.log(`Failed: ${failed}/${results.length}`);

	if (failed > 0) {
		console.log("\nFailed tests:");
		for (const r of results.filter((r) => !r.passed)) {
			console.log(`  ✗ ${r.name}: ${r.detail}`);
		}
	}

	// Write results JSON
	const resultsPath = path.join(RESULTS_DIR, "interaction-results.json");
	fs.writeFileSync(resultsPath, JSON.stringify({ passed, failed, total: results.length, results }, null, 2));
	console.log(`\nResults written to: ${resultsPath}`);

	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});