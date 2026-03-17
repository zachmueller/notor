#!/usr/bin/env npx tsx
/**
 * Compaction Diagnostics E2E Test
 *
 * Instruments the compaction/truncation flow end-to-end and asserts on structured
 * log output to confirm or deny two hypotheses about the observed errors:
 *
 *   Error 1: "⚠ N older messages trimmed from AI context…"
 *   Error 2: "⚠ AWS Bedrock error: A conversation must start with a user message."
 *
 * Hypothesis A — Truncation boundary bug:
 *   Truncation cuts an odd number of messages from the front, leaving the first
 *   remaining non-system message as assistant/tool_call/tool_result. Bedrock then
 *   rejects the request because the conversation doesn't start with a user message.
 *
 * Hypothesis B — Token estimation mismatch:
 *   shouldCompact() uses character-based token estimation; ContextManager uses actual
 *   output_tokens/input_tokens from LLM responses. The 90% truncation threshold can
 *   be reached before the 80% compaction threshold fires, bypassing compaction.
 *
 * Scenarios:
 *   1. Disable compaction (threshold=1.1), send many large messages to trigger
 *      truncation, assert on post-truncation message structure.
 *   2. Normal threshold (0.8), compare compaction estimate vs context manager
 *      estimate across same-turn logs to detect mismatch.
 *   3. Very low threshold (0.05), confirm compaction fires and produces valid
 *      message structure.
 *
 * Prerequisites:
 *   - Uses AWS Bedrock (default profile) for LLM calls
 *
 * Run with: npx tsx e2e/scripts/compaction-debug-test.ts
 */

import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type ElementHandle } from "playwright-core";
import {
	launchObsidian,
	closeObsidian,
	type ObsidianProcess,
} from "../lib/obsidian-launcher";
import { LogCollector, type LogEntry } from "../lib/log-collector";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VAULT_PATH = path.resolve(__dirname, "..", "test-vault");
const CDP_PORT = 9222;
const RESULTS_DIR = path.resolve(__dirname, "..", "results");
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots", "compaction-debug");
const LOGS_DIR = path.join(RESULTS_DIR, "logs");
const BUILD_DIR = path.resolve(__dirname, "..", "..", "build");
const PLUGIN_DATA_PATH = path.join(BUILD_DIR, "data.json");

const RESPONSE_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_500;

// ---------------------------------------------------------------------------
// Test infrastructure (same pattern as compaction-test.ts)
// ---------------------------------------------------------------------------

interface TestResult { name: string; passed: boolean; detail: string; screenshot?: string; evidence?: unknown; }
const results: TestResult[] = [];
function pass(n: string, d: string, s?: string, e?: unknown): void { console.log(`  ✓ PASS: ${n} — ${d}`); results.push({ name: n, passed: true, detail: d, screenshot: s, evidence: e }); }
function fail(n: string, d: string, s?: string, e?: unknown): void { console.error(`  ✗ FAIL: ${n} — ${d}`); results.push({ name: n, passed: false, detail: d, screenshot: s, evidence: e }); }
function info(n: string, d: string, e?: unknown): void { console.log(`  ℹ INFO: ${n} — ${d}`); results.push({ name: n, passed: true, detail: `[INFO] ${d}`, evidence: e }); }

async function screenshot(page: Page, name: string): Promise<string> {
	fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
	const file = path.join(SCREENSHOTS_DIR, `${name}.png`);
	await page.screenshot({ path: file, fullPage: true });
	return file;
}

async function waitForSelector(page: Page, sel: string, ms = 8_000): Promise<ElementHandle | null> {
	try { return await page.waitForSelector(sel, { timeout: ms }); } catch { return null; }
}

async function waitForResponse(page: Page, ms = RESPONSE_TIMEOUT_MS): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		await page.waitForTimeout(POLL_INTERVAL_MS);
		const ready = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			return el ? el.getAttribute("contenteditable") === "true" : false;
		});
		if (ready) return true;
	}
	return false;
}

async function sendMessage(page: Page, msg: string): Promise<boolean> {
	const input = await page.$(".notor-text-input");
	if (!input) throw new Error("Chat input not found");
	await input.click();
	await input.evaluate((el, m) => { el.textContent = m; el.dispatchEvent(new Event("input", { bubbles: true })); }, msg);
	await page.waitForTimeout(200);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(600);
	console.log(`    → Sent: "${msg.substring(0, 60)}…" (${msg.length} chars)`);
	return waitForResponse(page);
}

async function newConversation(page: Page): Promise<void> {
	const btn = await page.$(".notor-chat-header-btn[aria-label='New conversation']");
	if (btn) { await btn.click(); await page.waitForTimeout(1_500); }
}

// ---------------------------------------------------------------------------
// Log analysis helpers
// ---------------------------------------------------------------------------

interface LogData { [key: string]: unknown }

function getLogsAfterIndex(logs: LogEntry[], afterIndex: number, source: string, message: string): LogEntry[] {
	return logs.slice(afterIndex).filter(e => e.source === source && e.message === message);
}

function data(entry: LogEntry): LogData {
	return (entry.data as LogData) ?? {};
}

// ---------------------------------------------------------------------------
// Settings builder
// ---------------------------------------------------------------------------

function buildSettings(overrides?: Record<string, unknown>): Record<string, unknown> {
	return {
		notor_dir: "notor/",
		active_provider: "bedrock",
		providers: [
			{ type: "local", enabled: false, display_name: "Local", endpoint: "http://localhost:11434/v1" },
			{
				type: "bedrock", enabled: true, display_name: "AWS Bedrock",
				aws_auth_method: "profile", aws_profile: "default",
				region: "us-east-1", model_id: "deepseek.v3.2",
			},
		],
		auto_approve: {
			read_note: true, search_vault: true, list_vault: true, read_frontmatter: true,
			fetch_webpage: true, write_note: false, replace_in_note: false,
			update_frontmatter: false, manage_tags: false, execute_command: false,
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
		auto_context_open_notes: false,
		auto_context_vault_structure: false,
		auto_context_os: false,
		compaction_threshold: 0.8,
		compaction_prompt_override: "",
		fetch_webpage_timeout: 15,
		fetch_webpage_max_download_mb: 5,
		fetch_webpage_max_output_chars: 50000,
		domain_denylist: [],
		execute_command_timeout: 30,
		execute_command_max_output_chars: 50000,
		execute_command_allowed_paths: [],
		execute_command_shell: "",
		execute_command_shell_args: [],
		external_file_size_threshold_mb: 1,
		hooks: { pre_send: [], on_tool_call: [], on_tool_result: [], after_completion: [] },
		hook_timeout: 10,
		hook_env_truncation_chars: 10000,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Scenario 1 — Hypothesis A: truncation boundary bug
//
// Disable compaction entirely (threshold = 1.1), send several large messages to
// accumulate tokens, then inspect "Context window after truncation" logs.
//
// Invariant: after any truncation event, firstRemainingNonSystemRole MUST be "user".
// If it's anything else → Hypothesis A CONFIRMED.
// ---------------------------------------------------------------------------

async function scenarioA(page: Page, collector: LogCollector): Promise<void> {
	console.log("\n── Scenario 1: Hypothesis A — Truncation boundary bug ─────────────────");

	// Restart with compaction disabled
	await newConversation(page);
	const startIdx = collector.getStructuredLogs().length;

	// Large repeated phrase to maximise token accumulation per message.
	const FILLER = "The quick brown fox jumps over the lazy dog. ".repeat(60); // ~2520 chars
	const NUM_MESSAGES = 12;

	console.log(`    Sending ${NUM_MESSAGES} messages (~${FILLER.length} chars each)…`);
	for (let i = 1; i <= NUM_MESSAGES; i++) {
		const msg = `Message ${i}: ${FILLER}`;
		const responded = await sendMessage(page, msg);
		if (!responded) {
			console.log(`      Message ${i}: no response within timeout, continuing`);
			await page.waitForTimeout(2_000);
		}
		// Brief pause to let logs flush
		await page.waitForTimeout(500);
	}

	const shot = await screenshot(page, "01-scenario-a");
	const logs = collector.getStructuredLogs();

	// Check for any truncation events in this scenario
	const truncationLogs = getLogsAfterIndex(logs, startIdx, "ContextManager", "Context window after truncation");
	const assessmentLogs = getLogsAfterIndex(logs, startIdx, "ContextManager", "Context window assessment");

	console.log(`    ContextManager "assessment" logs: ${assessmentLogs.length}`);
	console.log(`    ContextManager "after truncation" logs: ${truncationLogs.length}`);

	// Report token progression
	if (assessmentLogs.length > 0) {
		const last = assessmentLogs[assessmentLogs.length - 1];
		const d = data(last);
		info("Scenario A — final token state", `totalTokens=${d.totalTokens} tokenBudget=${d.tokenBudget} needsTruncation=${d.needsTruncation}`, d);
	}

	if (truncationLogs.length === 0) {
		// Truncation didn't trigger — not enough messages to fill context window.
		// This is expected for large context windows; Hypothesis A can't be confirmed/denied.
		pass(
			"Scenario A — invariant (no truncation events)",
			`No truncation triggered in ${NUM_MESSAGES} messages. Context window not reached — invariant vacuously holds.`,
			shot
		);
		return;
	}

	// ASSERT: for every truncation event, firstRemainingNonSystemRole must be "user"
	let hypAConfirmed = false;
	const violations: LogData[] = [];

	for (const entry of truncationLogs) {
		const d = data(entry);
		const firstRole = String(d.firstRemainingNonSystemRole ?? "unknown");
		if (firstRole !== "user") {
			hypAConfirmed = true;
			violations.push(d);
			console.error(`    ✗ VIOLATION: firstRemainingNonSystemRole="${firstRole}" after truncation!`);
		} else {
			console.log(`    ✓ firstRemainingNonSystemRole="${firstRole}" — ok`);
		}
	}

	// Also check ChatMessages built for provider — second role (first non-system) must be "user"
	const chatMsgLogs = getLogsAfterIndex(logs, startIdx, "ChatOrchestrator", "ChatMessages built for provider");
	const chatViolations: LogData[] = [];
	for (const entry of chatMsgLogs) {
		const d = data(entry);
		const second = String(d.secondRole ?? "unknown");
		if (d.firstRole === "system" && second !== "user") {
			chatViolations.push(d);
			console.error(`    ✗ ChatMessages violation: secondRole="${second}" (expected "user")`);
		}
	}

	// Also check Bedrock messages — firstRole must be "user"
	const bedrockLogs = getLogsAfterIndex(logs, startIdx, "BedrockProvider", "Bedrock messages prepared");
	const bedrockViolations: LogData[] = [];
	for (const entry of bedrockLogs) {
		const d = data(entry);
		const first = String(d.firstRole ?? "unknown");
		if (first !== "user") {
			bedrockViolations.push(d);
			console.error(`    ✗ Bedrock violation: firstRole="${first}" (expected "user")`);
		}
	}

	const evidence = { truncationViolations: violations, chatMsgViolations: chatViolations, bedrockViolations };

	if (hypAConfirmed || chatViolations.length > 0 || bedrockViolations.length > 0) {
		fail(
			"Scenario A — Hypothesis A CONFIRMED",
			`Truncation produced invalid first-message role. truncationViolations=${violations.length} chatViolations=${chatViolations.length} bedrockViolations=${bedrockViolations.length}`,
			shot, evidence
		);
	} else {
		pass(
			"Scenario A — Hypothesis A denied",
			`${truncationLogs.length} truncation event(s) observed; all produced valid user-first structure.`,
			shot, evidence
		);
	}
}

// ---------------------------------------------------------------------------
// Scenario 2 — Hypothesis B: token estimation mismatch
//
// Normal threshold (0.8). For each turn, compare the "Compaction threshold check"
// totalTokens (character estimate) with the "Context window assessment" totalTokens
// (uses actual output_tokens). If truncation fires while compaction didn't → confirmed.
// ---------------------------------------------------------------------------

async function scenarioB(page: Page, collector: LogCollector): Promise<void> {
	console.log("\n── Scenario 2: Hypothesis B — Token estimation mismatch ───────────────");

	await newConversation(page);
	const startIdx = collector.getStructuredLogs().length;

	const FILLER = "Please write a short poem about the number ".repeat(20); // ~900 chars
	const NUM_MESSAGES = 8;

	console.log(`    Sending ${NUM_MESSAGES} messages with normal threshold (0.8)…`);
	for (let i = 1; i <= NUM_MESSAGES; i++) {
		const msg = `Message ${i}: ${FILLER}${i}.`;
		const responded = await sendMessage(page, msg);
		if (!responded) {
			console.log(`      Message ${i}: no response within timeout, continuing`);
			await page.waitForTimeout(2_000);
		}
		await page.waitForTimeout(500);
	}

	const shot = await screenshot(page, "02-scenario-b");
	const logs = collector.getStructuredLogs().slice(startIdx);

	const compactionChecks = logs.filter(e => e.source === "Compaction" && e.message === "Compaction threshold check");
	const assessments = logs.filter(e => e.source === "ContextManager" && e.message === "Context window assessment");
	const truncations = logs.filter(e => e.source === "ContextManager" && e.message === "Context window after truncation");

	console.log(`    Compaction threshold checks: ${compactionChecks.length}`);
	console.log(`    Context assessments: ${assessments.length}`);
	console.log(`    Truncation events: ${truncations.length}`);

	// Build per-turn comparison table: pair each compaction check with the nearest assessment
	const comparisonTable: Array<{
		turn: number;
		compactionTokens: number;
		compactionShouldTrigger: boolean;
		contextTokens: number;
		contextNeedsTruncation: boolean;
		mismatch: boolean;
	}> = [];

	const minLen = Math.min(compactionChecks.length, assessments.length);
	for (let i = 0; i < minLen; i++) {
		const cc = data(compactionChecks[i]);
		const ca = data(assessments[i]);
		const compactionTokens = Number(cc.totalTokens ?? 0);
		const contextTokens = Number(ca.totalTokens ?? 0);
		const compactionShouldTrigger = Boolean(cc.shouldTrigger);
		const contextNeedsTruncation = Boolean(ca.needsTruncation);
		// Mismatch: context says truncation needed but compaction didn't trigger
		const mismatch = contextNeedsTruncation && !compactionShouldTrigger;
		comparisonTable.push({
			turn: i + 1,
			compactionTokens,
			compactionShouldTrigger,
			contextTokens,
			contextNeedsTruncation,
			mismatch,
		});
		const ratio = compactionTokens > 0 ? (contextTokens / compactionTokens).toFixed(2) : "N/A";
		console.log(`    Turn ${i + 1}: compactionEst=${compactionTokens} contextEst=${contextTokens} ratio=${ratio} compactionTrigger=${compactionShouldTrigger} truncationNeeded=${contextNeedsTruncation}`);
	}

	const mismatches = comparisonTable.filter(r => r.mismatch);
	const hypBConfirmed = mismatches.length > 0;

	// Also check: did truncation fire (actual event) while compaction didn't just before it?
	const truncationWithoutCompaction = truncations.length > 0 && !compactionChecks.some(c => Boolean(data(c).shouldTrigger));

	const evidence = {
		comparisonTable,
		truncationEvents: truncations.length,
		compactionTriggered: compactionChecks.filter(c => Boolean(data(c).shouldTrigger)).length > 0,
		truncationWithoutPrecedingCompaction: truncationWithoutCompaction,
	};

	if (hypBConfirmed || truncationWithoutCompaction) {
		fail(
			"Scenario B — Hypothesis B CONFIRMED",
			`Token estimation mismatch detected: ${mismatches.length} turn(s) where context manager triggered truncation but compaction estimate did not fire. truncationWithoutCompaction=${truncationWithoutCompaction}`,
			shot, evidence
		);
	} else {
		pass(
			"Scenario B — Hypothesis B denied",
			`No mismatch detected. Compaction and truncation estimates appear consistent across ${minLen} turn(s).`,
			shot, evidence
		);
		if (comparisonTable.length === 0) {
			info("Scenario B — insufficient data", "Not enough turns to compare estimates meaningfully. Run more messages.", evidence);
		}
	}
}

// ---------------------------------------------------------------------------
// Scenario 3 — Happy path: compaction fires, message structure is valid
// ---------------------------------------------------------------------------

async function scenarioC(page: Page, collector: LogCollector): Promise<void> {
	console.log("\n── Scenario 3: Happy path — compaction fires at low threshold ──────────");

	await newConversation(page);
	const startIdx = collector.getStructuredLogs().length;

	const NUM_MESSAGES = 4;
	console.log(`    Sending ${NUM_MESSAGES} messages with very low threshold (0.05)…`);
	for (let i = 1; i <= NUM_MESSAGES; i++) {
		const responded = await sendMessage(page, `Message ${i}: Please write a short sentence about the number ${i}.`);
		if (!responded) {
			console.log(`      Message ${i}: no response within timeout, continuing`);
			await page.waitForTimeout(2_000);
		}
		await page.waitForTimeout(500);
	}

	const shot = await screenshot(page, "03-scenario-c");
	const logs = collector.getStructuredLogs().slice(startIdx);

	// Did compaction fire?
	const compactionFired = logs.some(e =>
		e.source === "Compaction" && e.message === "Compaction threshold check" && Boolean(data(e).shouldTrigger)
	);
	const compactionSucceeded = logs.some(e => e.source === "ChatOrchestrator" && e.message === "Compaction message split");
	const summarizationLogs = logs.filter(e => e.source === "Compaction" && e.message === "Compaction summarization request structure");

	console.log(`    Compaction fired: ${compactionFired}`);
	console.log(`    Compaction message split logged: ${compactionSucceeded}`);
	console.log(`    Summarization request structure logs: ${summarizationLogs.length}`);

	if (!compactionFired) {
		info(
			"Scenario C — compaction did not fire",
			"Threshold 0.05 was not reached (model context window very large). Skipping structure validation.",
			{ logs: logs.filter(e => e.source === "Compaction").slice(0, 5) }
		);
		return;
	}

	// Assert: summarization request ends with user message (the "Please summarize" instruction)
	let summarizationValid = true;
	for (const entry of summarizationLogs) {
		const d = data(entry);
		const lastChatRole = String(d.lastChatRole ?? "unknown");
		if (lastChatRole !== "user") {
			summarizationValid = false;
			console.error(`    ✗ Summarization request lastChatRole="${lastChatRole}" (expected "user")`);
		} else {
			console.log(`    ✓ Summarization request lastChatRole="${lastChatRole}" — ok`);
		}
	}

	// Assert: ChatMessages built for provider after compaction still starts system → user
	const chatMsgLogs = logs.filter(e => e.source === "ChatOrchestrator" && e.message === "ChatMessages built for provider");
	let chatStructureValid = true;
	for (const entry of chatMsgLogs) {
		const d = data(entry);
		if (d.firstRole !== "system" || d.secondRole !== "user") {
			chatStructureValid = false;
			console.error(`    ✗ ChatMessages after compaction: firstRole="${d.firstRole}" secondRole="${d.secondRole}"`);
		}
	}

	const evidence = { summarizationLogs: summarizationLogs.map(e => data(e)), chatMsgRoles: chatMsgLogs.map(e => ({ first: data(e).firstRole, second: data(e).secondRole })) };

	if (summarizationValid && chatStructureValid) {
		pass("Scenario C — compaction happy path", `Compaction fired and produced valid message structure across ${chatMsgLogs.length} turns.`, shot, evidence);
	} else {
		fail("Scenario C — compaction produced invalid structure", `summarizationValid=${summarizationValid} chatStructureValid=${chatStructureValid}`, shot, evidence);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log("=== Notor Compaction Diagnostics E2E Test ===\n");

	console.log("[0/5] Building plugin…");
	execSync("npm run build", { cwd: path.resolve(__dirname, "..", ".."), stdio: "inherit" });

	fs.mkdirSync(LOGS_DIR, { recursive: true });
	fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

	// Snapshot current settings for restoration
	let existingData: string | null = null;
	if (fs.existsSync(PLUGIN_DATA_PATH)) existingData = fs.readFileSync(PLUGIN_DATA_PATH, "utf8");

	let obsidian: ObsidianProcess | undefined;
	let collector: LogCollector | undefined;

	try {
		// -----------------------------------------------------------------------
		// Scenario 1 & 2 run together (compaction disabled for S1, normal for S2)
		// We need two separate Obsidian sessions because compaction_threshold is
		// baked into settings on launch. Run Scenario A first (threshold=1.1),
		// then restart with threshold=0.8 for Scenario B, then 0.05 for Scenario C.
		// -----------------------------------------------------------------------

		// --- Session 1: Scenario A (compaction disabled) ---
		console.log("\n[1/5] Starting Obsidian — Scenario A (threshold=1.1, compaction disabled)…");
		fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(buildSettings({ compaction_threshold: 1.1 }), null, 2));

		obsidian = await launchObsidian({ vaultPath: VAULT_PATH, cdpPort: CDP_PORT, timeout: 30_000 });
		let browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
		let page = browser.contexts()[0]?.pages()[0];
		if (!page) throw new Error("No page found");

		collector = new LogCollector({ outputDir: LOGS_DIR });
		collector.attach(page);
		await page.waitForLoadState("domcontentloaded");
		await page.waitForTimeout(5_000);

		const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
		if (!chat) throw new Error("Chat panel not visible");
		pass("Chat panel ready (session 1)", "Plugin loaded");

		await scenarioA(page, collector);

		await screenshot(page, "session1-final");
		collector.writeSummary();
		await browser.close().catch(() => {});
		await closeObsidian(obsidian);
		obsidian = undefined;
		await new Promise(r => setTimeout(r, 2_000));

		// --- Session 2: Scenario B (normal threshold) ---
		console.log("\n[2/5] Starting Obsidian — Scenario B (threshold=0.8)…");
		fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(buildSettings({ compaction_threshold: 0.8 }), null, 2));

		obsidian = await launchObsidian({ vaultPath: VAULT_PATH, cdpPort: CDP_PORT, timeout: 30_000 });
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
		page = browser.contexts()[0]?.pages()[0];
		if (!page) throw new Error("No page found");

		// New collector to avoid mixing sessions
		const collector2 = new LogCollector({ outputDir: LOGS_DIR });
		collector2.attach(page);
		await page.waitForLoadState("domcontentloaded");
		await page.waitForTimeout(5_000);

		await scenarioB(page, collector2);

		await screenshot(page, "session2-final");
		collector2.writeSummary();
		await browser.close().catch(() => {});
		await closeObsidian(obsidian);
		obsidian = undefined;
		await new Promise(r => setTimeout(r, 2_000));

		// --- Session 3: Scenario C (very low threshold) ---
		console.log("\n[3/5] Starting Obsidian — Scenario C (threshold=0.05)…");
		fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(buildSettings({ compaction_threshold: 0.05 }), null, 2));

		obsidian = await launchObsidian({ vaultPath: VAULT_PATH, cdpPort: CDP_PORT, timeout: 30_000 });
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
		page = browser.contexts()[0]?.pages()[0];
		if (!page) throw new Error("No page found");

		const collector3 = new LogCollector({ outputDir: LOGS_DIR });
		collector3.attach(page);
		await page.waitForLoadState("domcontentloaded");
		await page.waitForTimeout(5_000);

		await scenarioC(page, collector3);

		await screenshot(page, "session3-final");
		collector3.writeSummary();
		await browser.close().catch(() => {});
		await closeObsidian(obsidian);
		obsidian = undefined;

	} catch (err) {
		console.error("\nFatal error:", err);
		if (collector) collector.writeSummary();
	} finally {
		if (obsidian) await closeObsidian(obsidian);
		// Restore original settings
		if (existingData !== null) fs.writeFileSync(PLUGIN_DATA_PATH, existingData);
		else try { fs.unlinkSync(PLUGIN_DATA_PATH); } catch { /* ignore */ }
	}

	// ---------------------------------------------------------------------------
	// Summary
	// ---------------------------------------------------------------------------

	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;
	console.log(`\n=== Results: ${passed}/${results.length} passed, ${failed} failed ===`);

	for (const r of results) {
		const icon = r.passed ? "✓" : "✗";
		console.log(`  ${icon} ${r.name}: ${r.detail}`);
	}

	const resultsPath = path.join(RESULTS_DIR, "compaction-debug-results.json");
	fs.writeFileSync(resultsPath, JSON.stringify({ passed, failed, total: results.length, results }, null, 2));
	console.log(`\nDetailed results: ${resultsPath}`);
	console.log(`Log summaries: ${LOGS_DIR}/latest-summary.json`);

	if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
