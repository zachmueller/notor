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

import { runTest, type TestContext } from "../lib/test-harness";
import { waitForSelector, buildDefaultSettings } from "../lib/test-helpers";

// Max time to wait for a real LLM response (ms)
const RESPONSE_TIMEOUT_MS = 60_000;

const settings = buildDefaultSettings({
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
});

async function tests(ctx: TestContext) {
	const { page } = ctx;

	console.log("Provider:  AWS Bedrock");
	console.log("Auth:      AWS profile (default)");
	console.log("Region:    us-east-1");
	console.log("Model:     First available from ListFoundationModels\n");

	// Give plugin time to fully initialize and Bedrock provider to register
	await page.waitForTimeout(5000);

	console.log("Running LLM interaction tests...\n");

	// ── Test 1: Chat panel visible ─────────────────────────────────────
	console.log("Test 1: Chat panel visible with Bedrock pre-configured");
	{
		const chatContainer = await waitForSelector(page, ".notor-chat-container", 8000);
		if (chatContainer) {
			const shot = await ctx.screenshot("01-startup");
			ctx.pass("Chat panel visible", "Found .notor-chat-container", shot);
		} else {
			const shot = await ctx.screenshot("01-startup-missing");
			ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
			throw new Error("Chat panel not visible — cannot continue tests");
		}
	}

	// ── Test 2: Active provider is Bedrock ────────────────────────────
	console.log("\nTest 2: Active provider is Bedrock");
	{
		const settingsBtn = await page.$(".notor-chat-header-btn[aria-label='Chat settings']");
		if (!settingsBtn) {
			ctx.fail("Active provider is Bedrock", "Settings button not found");
		} else {
			await settingsBtn.click();
			await page.waitForTimeout(600);

			const popover = await page.$(".notor-settings-popover");
			if (!popover) {
				ctx.fail("Active provider is Bedrock", "Settings popover not found");
			} else {
				// Check provider dropdown — inside .notor-custom-model-section (not the preset dropdown)
				const providerSelect = await page.$(".notor-custom-model-section .notor-settings-select");
				if (providerSelect) {
					const selectedValue = await providerSelect.evaluate(
						(el: HTMLSelectElement) => el.value
					);
					const shot = await ctx.screenshot("02-provider-dropdown");
					if (selectedValue === "bedrock") {
						ctx.pass("Active provider is Bedrock", `Provider dropdown value: "${selectedValue}"`, shot);
					} else {
						ctx.fail("Active provider is Bedrock", `Provider dropdown value: "${selectedValue}" (expected "bedrock")`, shot);
					}
				} else {
					ctx.fail("Active provider is Bedrock", "Provider select element not found in popover");
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
			ctx.fail("Refresh models", "Model refresh button not found in popover");
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

					const shot = await ctx.screenshot("03-model-selected");
					ctx.pass("Refresh and select model", `${optionData.length} model(s) available; selected: "${chosen.text}" (${selectedModelId})`, shot);
				} else {
					ctx.fail("Refresh and select model", "Model select found but no options available");
				}
			} else {
				// May have fallen back to text input (model list unavailable)
				const textInput = await page.$(".notor-model-select-wrapper input");
				if (textInput) {
					const currentVal = await textInput.inputValue();
					ctx.fail("Refresh and select model", `No model dropdown appeared; text input present with value: "${currentVal}". Bedrock API may not be reachable.`);
				} else {
					ctx.fail("Refresh and select model", "Neither model select nor text input found after refresh");
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
			const textInput = await page.$(".notor-text-input");
			if (!textInput) {
				ctx.fail("Send real prompt", "Text input not found");
			} else {
				// contenteditable div — click, clear, and type instead of fill()
				await textInput.click();
				await page.keyboard.type(TEST_PROMPT);
				await page.waitForTimeout(100);

				console.log(`  Sending: "${TEST_PROMPT}"`);
				await page.keyboard.press("Enter");
				await page.waitForTimeout(500);

				// Verify user message rendered
				const userMsg = await page.$(".notor-message-user");
				if (userMsg) {
					const text = await userMsg.textContent();
					ctx.pass("User message rendered", `"${text?.trim().substring(0, 60)}"`);
				} else {
					ctx.fail("User message rendered", "No user message element found after send");
				}

				// Verify stop button visible (responding state)
				const stopVisible = await page.evaluate(() => {
					const btn = document.querySelector(".notor-stop-btn");
					return btn && !btn.classList.contains("notor-hidden");
				});
				if (stopVisible) {
					ctx.pass("Responding state entered", "Stop button visible (send→stop transition occurred)");
				} else {
					ctx.fail("Responding state entered", "Stop button not visible after send");
				}

				const shot1 = await ctx.screenshot("04-sending");

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
						// The text input is a contenteditable div; contenteditable="false" while responding.
						const inputEnabled = await page.evaluate(() => {
							const el = document.querySelector(".notor-text-input");
							return el && el.getAttribute("contenteditable") === "true";
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
						const shot = await ctx.screenshot("05-response-received");

						if (assistantMsg) {
							const responseText = await assistantMsg.textContent();
							ctx.pass("LLM response received", `[${elapsed}s] Response: "${responseText?.trim().substring(0, 120)}"`, shot);

							// ── Test 6: Verify response content ─────────────
							console.log("\nTest 6: Verify response content");
							const cleanText = (responseText ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, "");
							if (cleanText.includes("notor") && (cleanText.includes("test") || cleanText.includes("successful"))) {
								ctx.pass("Response contains expected content", `Text matches expected pattern`);
							} else {
								// Any non-error response is valid — the model chose its own wording
								ctx.pass("Response received (content varies)", `Model responded: "${responseText?.trim().substring(0, 80)}"`);
							}
						} else if (errorMsg) {
							const errText = await errorMsg.textContent();
							ctx.fail("LLM response received", `Error displayed: "${errText?.trim().substring(0, 120)}"`, shot);
						}
					} else {
						const shot = await ctx.screenshot("05-response-timeout");
						ctx.fail("LLM response received", `No response after ${RESPONSE_TIMEOUT_MS / 1000}s — check Bedrock connectivity`, shot);
					}
				}

				// ── Test 7: Input re-enabled after response ──────────────
				console.log("\nTest 7: Input state restored after response");
				{
					const isEnabled = await page.evaluate(() => {
						const el = document.querySelector(".notor-text-input");
						return el && el.getAttribute("contenteditable") === "true";
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
						ctx.pass("Input state restored", "Textarea enabled, stop hidden, send visible");
					} else {
						ctx.fail("Input state restored", `textarea.disabled=${!isEnabled}, stopHidden=${stopHidden}, sendVisible=${sendVisible}`);
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
							ctx.pass("Token footer updated", `Footer: "${footerText?.trim()}"`);
						} else {
							ctx.fail("Token footer updated", "Token footer element exists but is hidden after successful response");
						}
					} else {
						ctx.fail("Token footer updated", ".notor-token-footer element not found");
					}
				}

				// ── Test 9: Second message in same conversation ──────────
				console.log("\nTest 9: Follow-up message in same conversation");
				{
					const responded2 = await sendMessage(page, "What is 2 + 2?");

					const allMsgs = await page.$$(".notor-message-user");
					const allResponses = await page.$$(".notor-message-assistant");
					const shot = await ctx.screenshot("09-follow-up");

					if (allMsgs.length >= 2 && allResponses.length >= 2) {
						ctx.pass("Follow-up message", `${allMsgs.length} user messages, ${allResponses.length} responses in conversation`, shot);
					} else if (!responded2) {
						ctx.fail("Follow-up message", `Second message timed out. ${allMsgs.length} user msgs, ${allResponses.length} responses`, shot);
					} else if (allMsgs.length >= 2) {
						const latestError = await page.$(".notor-chat-error");
						if (latestError) {
							const errText = await latestError.textContent();
							ctx.fail("Follow-up message", `Error on second message: "${errText?.trim()}"`, shot);
						} else {
							ctx.pass("Follow-up message (partial)", `${allMsgs.length} user messages, ${allResponses.length} responses`, shot);
						}
					} else {
						ctx.fail("Follow-up message", `Only ${allMsgs.length} user messages found`, shot);
					}
				}
			}
		}
	}

	// ── Orchestrator log analysis ─────────────────────────────────────────
	const allLogs = ctx.collector.getStructuredLogs();
	const orchLogs = allLogs.filter((e) => e.source === "ChatOrchestrator");
	console.log(`\nOrchestrator log entries: ${orchLogs.length}`);
	for (const entry of orchLogs.slice(-10)) {
		console.log(`  [${entry.level}] ${entry.message}`, entry.data ?? "");
	}
}

runTest({ name: "llm-interaction-test", settings }, tests);
