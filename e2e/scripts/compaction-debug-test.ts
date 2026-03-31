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
import { chromium, type Page } from "playwright-core";
import {
	launchObsidian,
	closeObsidian,
	type ObsidianProcess,
} from "../lib/obsidian-launcher";
import { LogCollector, type LogEntry } from "../lib/log-collector";
import {
	PROJECT_ROOT,
	VAULT_PATH,
	PLUGIN_DATA_PATH,
	RESULTS_DIR,
	LOGS_DIR,
	CDP_PORT,
	findVaultPage,
	buildDefaultSettings,
	sendMessage,
	waitForResponse,
	newConversation,
} from "../lib/test-helpers";

const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots", "compaction-debug");

const SCENARIO_TIMEOUT_MS = 480_000; // 8 min per scenario safety net

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

/**
 * After a message timeout, click the stop button (if visible) to cancel the
 * in-flight LLM request, then wait for the input to become re-enabled so the
 * next sendMessage call won't be silently swallowed by the isResponding guard.
 */
async function cancelAndWaitForIdle(page: Page): Promise<void> {
	const stopBtn = await page.$(".notor-stop-btn:not(.notor-hidden)");
	if (stopBtn) {
		console.log("      → Clicking stop button to cancel in-flight request…");
		await stopBtn.click();
	}
	await page.waitForTimeout(1_000);
	// Wait for the input to be re-enabled (up to 10s)
	await waitForResponse(page, 10_000);
}

/**
 * Run an async function with a timeout. Rejects with an error if the function
 * does not complete within the given duration.
 */
function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms / 1000}s`)), ms);
		fn().then(
			(v) => { clearTimeout(timer); resolve(v); },
			(e) => { clearTimeout(timer); reject(e); },
		);
	});
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

	await newConversation(page);
	const startIdx = collector.getStructuredLogs().length;

	// Large repeated phrase to maximise token accumulation per message.
	// ~18 000 chars ≈ ~4 500 tokens each; 15 messages ≈ ~67 500 user tokens + responses.
	const FILLER = "The quick brown fox jumps over the lazy dog. ".repeat(400);
	const NUM_MESSAGES = 15;

	console.log(`    Sending ${NUM_MESSAGES} messages (~${FILLER.length} chars each)…`);
	for (let i = 1; i <= NUM_MESSAGES; i++) {
		const msg = `Message ${i}: ${FILLER}`;
		const responded = await sendMessage(page, msg);
		if (!responded) {
			console.log(`      Message ${i}: no response within timeout, cancelling…`);
			await cancelAndWaitForIdle(page);
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

	// ~9 000 chars ≈ ~2 250 tokens each; 10 messages should give enough data points.
	const FILLER = "Please write a short poem about the number ".repeat(200);
	const NUM_MESSAGES = 10;

	console.log(`    Sending ${NUM_MESSAGES} messages with normal threshold (0.8)…`);
	for (let i = 1; i <= NUM_MESSAGES; i++) {
		const msg = `Message ${i}: ${FILLER}${i}.`;
		const responded = await sendMessage(page, msg);
		if (!responded) {
			console.log(`      Message ${i}: no response within timeout, cancelling…`);
			await cancelAndWaitForIdle(page);
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

	const NUM_MESSAGES = 6;
	console.log(`    Sending ${NUM_MESSAGES} messages with very low threshold (0.05)…`);
	for (let i = 1; i <= NUM_MESSAGES; i++) {
		const responded = await sendMessage(page, `Message ${i}: Please write a short sentence about the number ${i}.`);
		if (!responded) {
			console.log(`      Message ${i}: no response within timeout, cancelling…`);
			await cancelAndWaitForIdle(page);
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
	execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });

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
		fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(buildDefaultSettings({ compaction_threshold: 1.1, mode: "act" }), null, 2));

		obsidian = await launchObsidian({ vaultPath: VAULT_PATH, cdpPort: CDP_PORT, timeout: 30_000 });
		let browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);

		collector = new LogCollector({ outputDir: LOGS_DIR });
		let page = await findVaultPage(browser, 20_000);
		collector.attach(page);
		pass("Chat panel ready (session 1)", "Plugin loaded");

		await withTimeout(() => scenarioA(page, collector), SCENARIO_TIMEOUT_MS, "Scenario A");

		await screenshot(page, "session1-final");
		collector.writeSummary();
		await browser.close().catch(() => {});
		await closeObsidian(obsidian);
		obsidian = undefined;
		await new Promise(r => setTimeout(r, 2_000));

		// --- Session 2: Scenario B (normal threshold) ---
		console.log("\n[2/5] Starting Obsidian — Scenario B (threshold=0.8)…");
		fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(buildDefaultSettings({ compaction_threshold: 0.8, mode: "act" }), null, 2));

		obsidian = await launchObsidian({ vaultPath: VAULT_PATH, cdpPort: CDP_PORT, timeout: 30_000 });
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);

		// New collector to avoid mixing sessions
		const collector2 = new LogCollector({ outputDir: LOGS_DIR });
		page = await findVaultPage(browser, 20_000);
		collector2.attach(page);

		await withTimeout(() => scenarioB(page, collector2), SCENARIO_TIMEOUT_MS, "Scenario B");

		await screenshot(page, "session2-final");
		collector2.writeSummary();
		await browser.close().catch(() => {});
		await closeObsidian(obsidian);
		obsidian = undefined;
		await new Promise(r => setTimeout(r, 2_000));

		// --- Session 3: Scenario C (very low threshold) ---
		console.log("\n[3/5] Starting Obsidian — Scenario C (threshold=0.05)…");
		fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(buildDefaultSettings({ compaction_threshold: 0.05, mode: "act" }), null, 2));

		obsidian = await launchObsidian({ vaultPath: VAULT_PATH, cdpPort: CDP_PORT, timeout: 30_000 });
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);

		const collector3 = new LogCollector({ outputDir: LOGS_DIR });
		page = await findVaultPage(browser, 20_000);
		collector3.attach(page);

		await withTimeout(() => scenarioC(page, collector3), SCENARIO_TIMEOUT_MS, "Scenario C");

		await screenshot(page, "session3-final");
		collector3.writeSummary();
		await browser.close().catch(() => {});
		await closeObsidian(obsidian);
		obsidian = undefined;

	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		console.error("\nFatal error:", errMsg);
		fail("Fatal error", errMsg);
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
