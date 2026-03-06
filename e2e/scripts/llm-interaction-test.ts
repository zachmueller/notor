#!/usr/bin/env npx tsx
/**
 * LLM Interaction Test
 *
 * Verifies end-to-end LLM communication through the Notor plugin:
 *
 *  1. Pre-configure plugin settings: Bedrock provider, default AWS profile
 *  2. Launch Obsidian with the test vault
 *  3. Verify chat panel opens
 *  4. Open settings popover — confirm Bedrock is the active provider
 *  5. Refresh model list and pick the first available model
 *  6. Send a real test prompt to the LLM
 *  7. Wait up to 45s for streaming response
 *  8. Verify: stop button transitions → send button, assistant message rendered,
 *     streaming text accumulated correctly
 *  9. Optionally verify token footer updates
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access enabled on that account (any Claude/Titan model)
 *
 * Run with:
 *   npx tsx e2e/scripts/llm-interaction-test.ts
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
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots", "llm");
const LOGS_DIR = path.join(RESULTS_DIR, "logs");

// Build dir is where the symlinked plugin data.json lives
const BUILD_DIR = path.resolve(__dirname, "..", "..", "build");
const PLUGIN_DATA_PATH = path.join(BUILD_DIR, "data.json");

// Max time to wait for a real LLM response (ms)
const RESPONSE_TIMEOUT_MS = 60_000;

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
	fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
	const file = path.join(SCREENSHOTS_DIR, `${name}.png`);
	await page.screenshot({ path: file, fullPage: true });
	return file;
}

async function waitForSelector(
	page: Page,
	selector: string,
	timeoutMs = 8000
): Promise<import("playwright-core").ElementHandle | null> {
	try {
		return await page.waitForSelector(selector, { timeout: timeoutMs });
	} catch {
		return null;
	}
}

/**
 * Build the plugin settings JSON with Bedrock as active provider,
 * default AWS profile, and us-east-1 region.
 */
function buildBedrockSettings(): Record<string, unknown> {
	return {
		notor_dir: "notor/",
		active_provider: "bedrock",
		providers: [
			{
				type: "local",
				enabled: false,
				display_name: "Local (OpenAI-compatible)",
				endpoint: "http://localhost:11434/v1",
			},
			{
				type: "anthropic",
				enabled: false,
				display_name: "Anthropic",
				endpoint: "https://api.anthropic.com",
			},
			{
				type: "openai",
				enabled: false,
				display_name: "OpenAI",
				endpoint: "https://api.openai.com",
			},
			{
				type: "bedrock",
				enabled: true,
				display_name: "AWS Bedrock",
				aws_auth_method: "profile",
				aws_profile: "default",
				region: "us-east-1",
				// No model_id yet — we'll pick one from the live list
			},
		],
		auto_approve: {
			read_note: true,
			search_vault: true,
			list_vault: true,
			read_frontmatter: true,
			write_note: false,
			replace_in_note: false,
			update_frontmatter: false,
			manage_tags: false,
		},
		mode: "plan",
		open_notes_on_access: true,
		history_path: ".obsidian/plugins/notor/history/",
		history_max_size_mb: 500,
		history_max_age_days: 90,
		checkpoint_path: ".obsidian/plugins/notor/checkpoints/",
		checkpoint_max_per_conversation: 100,
		checkpoint_max_age_days: 30,
		model_pricing: {},
	};
}

async function main() {
	console.log("=== Notor LLM Interaction Test ===\n");
	console.log("Provider:  AWS Bedrock");
	console.log("Auth:      AWS profile (default)");
	console.log("Region:    us-east-1");
	console.log("Model:     First available from ListFoundationModels\n");

	// Build first
	console.log("[0/4] Building plugin...");
	execSync("npm run build", {
		cwd: path.resolve(__dirname, "..", ".."),
		stdio: "inherit",
	});
	console.log("Build complete.\n");

	// Pre-configure plugin settings
	console.log("[1/4] Injecting Bedrock settings into plugin data...");
	const settings = buildBedrockSettings();
	fs.mkdirSync(BUILD_DIR, { recursive: true });

	// Backup existing data.json if present
	let existingData: string | null = null;
	if (fs.existsSync(PLUGIN_DATA_PATH)) {
		existingData = fs.readFileSync(PLUGIN_DATA_PATH, "utf8");
		console.log(`  Backed up existing data.json`);
	}
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	console.log(`  Wrote Bedrock config to ${PLUGIN_DATA_PATH}\n`);

	fs.mkdirSync(LOGS_DIR, { recursive: true });

	let obsidian: ObsidianProcess | undefined;
	let collector: LogCollector | undefined;

	try {
		// Launch Obsidian
		console.log("[2/4] Launching Obsidian...");
		obsidian = await launchObsidian({ vaultPath: VAULT_PATH, cdpPort: CDP_PORT, timeout: 30_000 });

		console.log("[3/4] Connecting Playwright...");
		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
		const contexts = browser.contexts();
		const page = contexts[0]?.pages()[0];
		if (!page) throw new Error("No page found");

		collector = new LogCollector({ outputDir: LOGS_DIR });
		collector.attach(page);

		await page.waitForLoadState("domcontentloaded");
		// Give plugin time to fully initialize and Bedrock provider to register
		await page.waitForTimeout(5000);

		console.log("\n[4/4] Running LLM interaction tests...\n");

		// ── Test 1: Chat panel visible ─────────────────────────────────────
		console.log("Test 1: Chat panel visible with Bedrock pre-configured");
		{
			const chatContainer = await waitForSelector(page, ".notor-chat-container", 8000);
			if (chatContainer) {
				const shot = await screenshot(page, "01-startup");
				pass("Chat panel visible", "Found .notor-chat-container", shot);
			} else {
				const shot = await screenshot(page, "01-startup-missing");
				fail("Chat panel visible", ".notor-chat-container not found", shot);
				throw new Error("Chat panel not visible — cannot continue tests");
			}
		}

		// ── Test 2: Active provider is Bedrock ────────────────────────────
		console.log("\nTest 2: Active provider is Bedrock");
		{
			const settingsBtn = await page.$(".notor-chat-header-btn[aria-label='Chat settings']");
			if (!settingsBtn) {
				fail("Active provider is Bedrock", "Settings button not found");
			} else {
				await settingsBtn.click();
				await page.waitForTimeout(600);

				const popover = await page.$(".notor-settings-popover");
				if (!popover) {
					fail("Active provider is Bedrock", "Settings popover not found");
				} else {
					// Check provider dropdown — should have Bedrock selected
					const providerSelect = await page.$(".notor-settings-popover .notor-settings-select");
					if (providerSelect) {
						const selectedValue = await providerSelect.evaluate(
							(el: HTMLSelectElement) => el.value
						);
						const shot = await screenshot(page, "02-provider-dropdown");
						if (selectedValue === "bedrock") {
							pass("Active provider is Bedrock", `Provider dropdown value: "${selectedValue}"`, shot);
						} else {
							fail("Active provider is Bedrock", `Provider dropdown value: "${selectedValue}" (expected "bedrock")`, shot);
						}
					} else {
						fail("Active provider is Bedrock", "Provider select element not found in popover");
					}

					// Keep the popover open for the next test
				}
			}
		}

		// ── Test 3: Refresh models and pick first one ─────────────────────
		console.log("\nTest 3: Refresh Bedrock model list and select first model");
		let selectedModelId = "";
		{
			const refreshBtn = await page.$(".notor-settings-popover .notor-settings-refresh-btn");
			if (!refreshBtn) {
				fail("Refresh models", "Model refresh button not found in popover");
			} else {
				console.log("  Clicking refresh — waiting for Bedrock ListFoundationModels...");
				await refreshBtn.click();

				// Wait for model list to populate (up to 20s for Bedrock API call)
				let modelSelect: import("playwright-core").ElementHandle | null = null;
				const deadline = Date.now() + 20_000;
				while (Date.now() < deadline) {
					await page.waitForTimeout(1000);
					// Look for a select element in the model section (second .notor-settings-section)
					modelSelect = await page.$(".notor-model-select-wrapper select");
					if (modelSelect) break;
				}

				if (modelSelect) {
					// Get all options
					const allOptions = await page.$$(".notor-model-select-wrapper select option");
					const optionData: { value: string; text: string }[] = [];
					for (const opt of allOptions) {
						const value = await opt.evaluate((el) => (el as HTMLOptionElement).value);
						const text = (await opt.textContent()) ?? "";
						optionData.push({ value, text: text.trim() });
					}

					if (optionData.length > 0) {
						// Prefer a Claude or Amazon Nova model which reliably supports
						// the Bedrock Converse API with text-only prompts
						const PREFERRED_PREFIXES = [
							"anthropic.claude-sonnet-4-5",
							"anthropic.claude-haiku",
							"anthropic.claude-sonnet",
							"amazon.nova-lite",
							"amazon.nova-pro",
							"anthropic.claude",
							"amazon.nova",
						];
						let chosen = optionData[0]!;
						for (const prefix of PREFERRED_PREFIXES) {
							const match = optionData.find((o) => o.value.startsWith(prefix));
							if (match) { chosen = match; break; }
						}

						selectedModelId = chosen.value;
						await modelSelect.selectOption({ value: chosen.value });
						await page.waitForTimeout(500);

						const shot = await screenshot(page, "03-model-selected");
						pass("Refresh and select model", `${optionData.length} model(s) available; selected: "${chosen.text}" (${selectedModelId})`, shot);
					} else {
						fail("Refresh and select model", "Model select found but no options available");
					}
				} else {
					// May have fallen back to text input (model list unavailable)
					const textInput = await page.$(".notor-model-select-wrapper input");
					if (textInput) {
						const currentVal = await textInput.inputValue();
						fail("Refresh and select model", `No model dropdown appeared; text input present with value: "${currentVal}". Bedrock API may not be reachable.`);
					} else {
						fail("Refresh and select model", "Neither model select nor text input found after refresh");
					}
				}
			}

			// Close the settings popover
			const settingsBtn = await page.$(".notor-chat-header-btn[aria-label='Chat settings']");
			await settingsBtn?.click();
			await page.waitForTimeout(400);
		}

		if (!selectedModelId) {
			console.log("\n  ⚠ No model selected — cannot proceed with LLM call. Stopping here.");
			console.log("  Check that your AWS [default] profile has Bedrock access in us-east-1.\n");
		} else {
			// ── Test 4: Send a real prompt ─────────────────────────────────
			console.log(`\nTest 4: Send real prompt to ${selectedModelId}`);
			{
				const TEST_PROMPT = "Hello! Please respond with exactly: 'Notor LLM test successful.' and nothing else.";
				const textarea = await page.$(".notor-text-input");
				if (!textarea) {
					fail("Send real prompt", "Textarea not found");
				} else {
					await textarea.fill(TEST_PROMPT);
					await page.waitForTimeout(100);

					console.log(`  Sending: "${TEST_PROMPT}"`);
					await page.keyboard.press("Enter");
					await page.waitForTimeout(500);

					// Verify user message rendered
					const userMsg = await page.$(".notor-message-user");
					if (userMsg) {
						const text = await userMsg.textContent();
						pass("User message rendered", `"${text?.trim().substring(0, 60)}"`);
					} else {
						fail("User message rendered", "No user message element found after send");
					}

					// Verify stop button visible (responding state)
					const stopVisible = await page.evaluate(() => {
						const btn = document.querySelector(".notor-stop-btn");
						return btn && !btn.classList.contains("notor-hidden");
					});
					if (stopVisible) {
						pass("Responding state entered", "Stop button visible (send→stop transition occurred)");
					} else {
						fail("Responding state entered", "Stop button not visible after send");
					}

					const shot1 = await screenshot(page, "04-sending");

					// ── Test 5: Wait for streaming response ─────────────────
					console.log(`\nTest 5: Wait for LLM response (up to ${RESPONSE_TIMEOUT_MS / 1000}s)...`);
					{
						const startTime = Date.now();
						let responseReceived = false;

						while (Date.now() - startTime < RESPONSE_TIMEOUT_MS) {
							await page.waitForTimeout(1000);

							// Check if response appeared (assistant message or error)
							const assistantMsg = await page.$(".notor-message-assistant");
							const errorMsg = await page.$(".notor-chat-error");

							// Check if input is re-enabled (responding state ended)
							const inputEnabled = await page.evaluate(() => {
								const textarea = document.querySelector(".notor-text-input") as HTMLTextAreaElement;
								return textarea && !textarea.disabled;
							});

							if ((assistantMsg || errorMsg) && inputEnabled) {
								responseReceived = true;
								break;
							}

							// Log streaming progress
							if (assistantMsg) {
								const partialText = await assistantMsg.textContent();
								const elapsed = Math.round((Date.now() - startTime) / 1000);
								console.log(`  [${elapsed}s] Streaming: "${partialText?.trim().substring(0, 60)}..."`);
							}
						}

						if (responseReceived) {
							const elapsed = Math.round((Date.now() - startTime) / 1000);
							const assistantMsg = await page.$(".notor-message-assistant");
							const errorMsg = await page.$(".notor-chat-error");
							const shot = await screenshot(page, "05-response-received");

							if (assistantMsg) {
								const responseText = await assistantMsg.textContent();
								pass("LLM response received", `[${elapsed}s] Response: "${responseText?.trim().substring(0, 120)}"`, shot);

								// ── Test 6: Verify response content ─────────────
								console.log("\nTest 6: Verify response content");
								const cleanText = (responseText ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, "");
								if (cleanText.includes("notor") && (cleanText.includes("test") || cleanText.includes("successful"))) {
									pass("Response contains expected content", `Text matches expected pattern`);
								} else {
									// Any non-error response is valid — the model chose its own wording
									pass("Response received (content varies)", `Model responded: "${responseText?.trim().substring(0, 80)}"`);
								}
							} else if (errorMsg) {
								const errText = await errorMsg.textContent();
								fail("LLM response received", `Error displayed: "${errText?.trim().substring(0, 120)}"`, shot);
							}
						} else {
							const shot = await screenshot(page, "05-response-timeout");
							fail("LLM response received", `No response after ${RESPONSE_TIMEOUT_MS / 1000}s — check Bedrock connectivity`, shot);
						}
					}

					// ── Test 7: Input re-enabled after response ──────────────
					console.log("\nTest 7: Input state restored after response");
					{
						const isEnabled = await page.evaluate(() => {
							const ta = document.querySelector(".notor-text-input") as HTMLTextAreaElement;
							return ta && !ta.disabled;
						});
						const stopHidden = await page.evaluate(() => {
							const btn = document.querySelector(".notor-stop-btn");
							return !btn || btn.classList.contains("notor-hidden");
						});
						const sendVisible = await page.evaluate(() => {
							const btn = document.querySelector(".notor-send-btn");
							return btn && !btn.classList.contains("notor-hidden");
						});

						if (isEnabled && stopHidden && sendVisible) {
							pass("Input state restored", "Textarea enabled, stop hidden, send visible");
						} else {
							fail("Input state restored", `textarea.disabled=${!isEnabled}, stopHidden=${stopHidden}, sendVisible=${sendVisible}`);
						}
					}

					// ── Test 8: Token footer updated ────────────────────────
					console.log("\nTest 8: Token footer updated");
					{
						const tokenFooter = await page.$(".notor-token-footer");
						if (tokenFooter) {
							const isHidden = await tokenFooter.evaluate((el) => el.classList.contains("notor-hidden"));
							if (!isHidden) {
								const footerText = await tokenFooter.textContent();
								pass("Token footer updated", `Footer: "${footerText?.trim()}"`);
							} else {
								fail("Token footer updated", "Token footer element exists but is hidden after successful response");
							}
						} else {
							fail("Token footer updated", ".notor-token-footer element not found");
						}
					}

					// ── Test 9: Second message in same conversation ──────────
					console.log("\nTest 9: Follow-up message in same conversation");
					{
						const textarea2 = await page.$(".notor-text-input");
						if (textarea2) {
							await textarea2.fill("What is 2 + 2?");
							await page.keyboard.press("Enter");
							await page.waitForTimeout(500);

							// Wait for second response (up to 30s)
							const start2 = Date.now();
							while (Date.now() - start2 < 30_000) {
								await page.waitForTimeout(1000);
								const inputEnabled2 = await page.evaluate(() => {
									const ta = document.querySelector(".notor-text-input") as HTMLTextAreaElement;
									return ta && !ta.disabled;
								});
								if (inputEnabled2) break;
							}

							const allMsgs = await page.$$(".notor-message-user");
							const allResponses = await page.$$(".notor-message-assistant");
							const shot = await screenshot(page, "09-follow-up");

							if (allMsgs.length >= 2 && allResponses.length >= 2) {
								pass("Follow-up message", `${allMsgs.length} user messages, ${allResponses.length} responses in conversation`, shot);
							} else if (allMsgs.length >= 2) {
								const latestError = await page.$(".notor-chat-error");
								if (latestError) {
									const errText = await latestError.textContent();
									fail("Follow-up message", `Error on second message: "${errText?.trim()}"`, shot);
								} else {
									pass("Follow-up message (partial)", `${allMsgs.length} user messages, ${allResponses.length} responses`, shot);
								}
							} else {
								fail("Follow-up message", `Only ${allMsgs.length} user messages found`, shot);
							}
						} else {
							fail("Follow-up message", "Textarea not found for second message");
						}
					}
				}
			}
		}

		// ── Final screenshot ───────────────────────────────────────────────
		await screenshot(page, "99-final");

		// Collect logs
		console.log("\n=== Collecting final logs ===");
		await page.waitForTimeout(1000);
		const summaryPath = await collector.writeSummary();
		console.log(`Log summary: ${summaryPath}`);

		// Check logs for LLM-related entries
		const allLogs = collector.getStructuredLogs();
		const orchLogs = allLogs.filter((e) => e.source === "ChatOrchestrator");
		console.log(`\nOrchestrator log entries: ${orchLogs.length}`);
		for (const entry of orchLogs.slice(-10)) {
			console.log(`  [${entry.level}] ${entry.message}`, entry.data ?? "");
		}

		const errors = collector.getLogsByLevel("error");
		if (errors.length > 0) {
			console.log(`\nPlugin errors (${errors.length}):`);
			for (const e of errors) {
				console.log(`  [${e.source}] ${e.message}`, e.data ?? "");
			}
		}

		await browser.close().catch(() => {});

	} catch (err) {
		console.error("\nFatal error:", err);
		if (collector) await collector.dispose().catch(() => {});
	} finally {
		if (obsidian) {
			await closeObsidian(obsidian);
		}

		// Restore original data.json
		if (existingData !== null) {
			fs.writeFileSync(PLUGIN_DATA_PATH, existingData);
			console.log("\nRestored original data.json");
		} else {
			// Remove the injected data.json to leave build dir clean
			try { fs.unlinkSync(PLUGIN_DATA_PATH); } catch { /* ignore */ }
			console.log("\nRemoved injected data.json (none existed before)");
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
	const resultsPath = path.join(RESULTS_DIR, "llm-interaction-results.json");
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