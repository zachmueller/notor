#!/usr/bin/env npx tsx
/**
 * Resilient Replace Matching E2E Test
 *
 * Validates the tiered, drift-tolerant matching (`resilientIndexOf`) end-to-end
 * through the real `replace_in_note` tool: a SEARCH that differs from the note's
 * content only by Unicode variants (em-dash vs hyphen, curly vs straight quotes,
 * non-breaking vs regular space) or by leading whitespace still matches and the
 * file is actually written. A search whose normalized form matches 2+ locations
 * returns a `not_unique` error and writes nothing (atomic).
 *
 * Driven deterministically (no live model) by dispatching `replace_in_note` via
 * the tool dispatcher against fixture notes, then reading the file back to
 * confirm the write.
 *
 * Scenarios:
 *   1. em-dash (file) vs hyphen (search) matches via the normalized tier + writes
 *   2. curly quotes (file) vs straight quotes (search) matches + writes
 *   3. non-breaking space (file) vs regular space (search) matches + writes
 *   4. altered leading indentation matches via the line-trimmed tier + writes
 *   5. a search matching 2+ normalized locations → not_unique error, file unchanged
 *   6. No unexpected error logs (not_unique is an info, not an error)
 *
 * @see src/utils/unicode-normalize.ts — resilientIndexOf tiers
 * @see src/extensions/builtin-tool-scaffolds/replace-in-note.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, writeCleanWorkspace } from "../lib/test-helpers";

const DIR = "notor/e2e-replace";

// Fixture content. NBSP is a literal U+00A0 byte; the em-dash / curly quotes are
// literal too — the search strings below use the ASCII equivalents.
const FIXTURES: Record<string, string> = {
	"emdash.md": "---\ntitle: Emdash\n---\n\nThe plan—revised—ships Friday.\n",
	"quotes.md": "He said “hello” to O’Brien.\n",
	"nbsp.md": "Total price: 100 dollars.\n",
	"indent.md": "function f() {\n        return 42;\n}\n",
	"dup.md": "alpha\nTODO item\nbeta\nTODO item\ngamma\n",
};

// ---------------------------------------------------------------------------
// Dispatch helper — replace_in_note via the tool dispatcher (auto-approved)
// ---------------------------------------------------------------------------

async function dispatchReplace(
	page: Page,
	notePath: string,
	oldText: string,
	newText: string,
): Promise<any> {
	return page.evaluate(async (args) => {
		const w = window as any;
		const plugin = w.app?.plugins?.plugins?.["notor"];
		if (!plugin) return { ok: false, error: "Plugin not found" };

		const orchestrator = plugin.getActiveOrchestrator?.();
		const dispatcher = plugin.getToolDispatcher?.();
		if (!orchestrator || !dispatcher) return { ok: false, error: "Missing orchestrator/dispatcher" };

		const resolver = orchestrator.configResolver;
		if (!resolver?.resolveEffectiveConfig) return { ok: false, error: "No config resolver" };
		const { effective } = await resolver.resolveEffectiveConfig(undefined, null, null);
		if (!effective) return { ok: false, error: "No effective tool config" };

		const policyCtx = {
			effectiveConfig: effective,
			mode: "act",
			domainDenylist: plugin.settings?.domain_denylist ?? [],
			vaultRootPath: orchestrator.getVaultRootPath?.() ?? "",
			resolveVaultPath: (p: string) => p,
		};

		try {
			const result = await dispatcher.dispatch(
				"replace_in_note",
				{ path: args.notePath, changes: [{ old_text: args.oldText, new_text: args.newText }] },
				"act",
				"msg-replace",
				undefined, // abortSignal
				undefined, // onProgress
				policyCtx,
				() => Promise.resolve("approved"), // auto-approved (override) — not awaited
				orchestrator, // sessionContext
				undefined, // approvalHookDispatcher
				undefined, // interactionCallback
			);
			// Read the file back to verify the on-disk effect.
			const file = w.app.vault.getFileByPath(args.notePath);
			const after = file ? await w.app.vault.read(file) : null;
			return { ok: true, result, after };
		} catch (e: any) {
			return { ok: false, error: e?.message ?? String(e) };
		}
	}, { notePath, oldText, newText });
}

// ---------------------------------------------------------------------------
// Success scenarios (1-4)
// ---------------------------------------------------------------------------

interface SuccessCase {
	label: string;
	file: string;
	oldText: string;
	newText: string;
	/** Substring expected to be present after the write. */
	expectPresent: string;
	/** Substring expected to be ABSENT after the write (the original variant). */
	expectAbsent: string;
}

async function testSuccessCase(ctx: TestContext, c: SuccessCase, idx: number): Promise<void> {
	console.log(`\nTest ${idx}: ${c.label}`);
	const notePath = `${DIR}/${c.file}`;
	const outcome = await dispatchReplace(ctx.page, notePath, c.oldText, c.newText);

	if (!outcome.ok) {
		ctx.fail(c.label, outcome.error ?? "dispatch failed");
		return;
	}
	const result = outcome.result;
	const succeeded = result?.success === true && typeof result.result === "string" && /Applied 1 replacement/.test(result.result);
	if (!succeeded) {
		ctx.fail(c.label, `Tool did not report success: ${JSON.stringify(result)?.substring(0, 200)}`);
		return;
	}
	ctx.pass(`${c.label} — tool succeeded`, result.result);

	const after: string | null = outcome.after;
	if (after && after.includes(c.expectPresent) && !after.includes(c.expectAbsent)) {
		ctx.pass(`${c.label} — file written`, `Note now contains the replacement (and the original variant is gone)`);
	} else {
		ctx.fail(`${c.label} — file written`, `after=${JSON.stringify(after)}`);
	}
}

// ---------------------------------------------------------------------------
// not_unique scenario (5)
// ---------------------------------------------------------------------------

async function testNotUnique(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: ambiguous (2+ matches) → not_unique error, file unchanged");
	const notePath = `${DIR}/dup.md`;
	const original = FIXTURES["dup.md"]!;

	const outcome = await dispatchReplace(ctx.page, notePath, "TODO item", "DONE item");
	if (!outcome.ok) {
		ctx.fail("Ambiguous match errors", outcome.error ?? "dispatch failed");
		return;
	}
	const result = outcome.result;
	const shot = await ctx.screenshot("05-not-unique");

	const isErr = result?.success === false && typeof result.error === "string";
	const mentionsAmbiguity = isErr && /matched 2 locations|did not match uniquely|add surrounding context/i.test(result.error);
	if (isErr && mentionsAmbiguity) {
		ctx.pass("Ambiguous match errors", `Tool failed with: "${result.error}"`, shot);
	} else {
		ctx.fail("Ambiguous match errors", `Expected a not_unique error, got: ${JSON.stringify(result)?.substring(0, 200)}`, shot);
	}

	// File must be untouched (atomic — vault.process threw).
	if (outcome.after === original) {
		ctx.pass("Ambiguous match leaves file unchanged", "dup.md still has both TODO lines (no write)");
	} else {
		ctx.fail("Ambiguous match leaves file unchanged", `File changed despite the error: ${JSON.stringify(outcome.after)}`);
	}
}

// ---------------------------------------------------------------------------
// Test 6: no unexpected error logs
// ---------------------------------------------------------------------------

async function testNoErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: no unexpected error logs (not_unique is an info, not an error)");
	const errors = ctx.collector.getLogsByLevel("error");
	const relevant = errors.filter(
		(e) => e.source === "replace_in_note" || e.message?.toLowerCase().includes("replace_in_note"),
	);
	if (relevant.length === 0) {
		ctx.pass("No replace_in_note errors", "Zero error-level logs from the tool");
	} else {
		ctx.fail("No replace_in_note errors", `${relevant.length}: ${relevant.map((e) => e.message).join("; ")}`);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // plugin init

	await page.evaluate(() => {
		if (typeof (window as any).__name === "undefined") {
			(window as any).__name = (fn: unknown, _name: string) => fn;
		}
	});

	const cases: SuccessCase[] = [
		{
			label: "em-dash vs hyphen (normalized tier)",
			file: "emdash.md",
			oldText: "The plan-revised-ships Friday.", // hyphens; file has em-dashes
			newText: "The plan is final.",
			expectPresent: "The plan is final.",
			expectAbsent: "plan—revised",
		},
		{
			label: "curly vs straight quotes (normalized tier)",
			file: "quotes.md",
			oldText: "He said \"hello\" to O'Brien.", // straight quotes; file has curly
			newText: "He greeted everyone.",
			expectPresent: "He greeted everyone.",
			expectAbsent: "“hello”",
		},
		{
			label: "non-breaking space vs regular space (normalized tier)",
			file: "nbsp.md",
			oldText: "Total price: 100 dollars.", // regular space; file has NBSP
			newText: "Total price: 200 dollars.",
			expectPresent: "Total price: 200 dollars.",
			expectAbsent: "Total price",
		},
		{
			label: "altered leading indentation (line-trimmed tier)",
			file: "indent.md",
			oldText: "return 42;", // no indent; file line is indented 8 spaces
			newText: "return 99;",
			expectPresent: "return 99;",
			expectAbsent: "return 42;",
		},
	];

	for (let i = 0; i < cases.length; i++) {
		await testSuccessCase(ctx, cases[i]!, i + 1);
	}
	await testNotUnique(ctx);
	await testNoErrors(ctx);
}

const settings = buildDefaultSettings({ auto_approve: { replace_in_note: true } });

runTest(
	{
		name: "resilient-replace-test",
		settings,
		setupVault: (vaultPath) => {
			// Pin a clean workspace so the chat panel (deferred view in Obsidian 1.12)
			// mounts regardless of leftover workspace state from prior runs.
			writeCleanWorkspace(vaultPath);
			const dir = path.join(vaultPath, DIR);
			if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
			fs.mkdirSync(dir, { recursive: true });
			for (const [name, content] of Object.entries(FIXTURES)) {
				fs.writeFileSync(path.join(dir, name), content);
			}
			console.log(`  Replace fixtures created in ${DIR}/ (${Object.keys(FIXTURES).length} notes)`);
		},
		cleanupFiles: [DIR],
	},
	tests,
);
