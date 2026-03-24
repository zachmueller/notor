#!/usr/bin/env npx tsx
/**
 * E2E test for the `get_backlinks` and `get_outlinks` tools.
 *
 * Creates a small graph of interlinked notes, then prompts the LLM to use
 * each tool and verifies the output contains expected links.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	sendMessage,
	getLastAssistantMessage,
	getLastToolCallNames,
	newConversation,
	buildDefaultSettings,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Vault setup — a small link graph
// ---------------------------------------------------------------------------

// Graph:
//   Hub.md  → Spoke A.md, Spoke B.md, [[NonExistent]]
//   Spoke A.md → Hub.md
//   Spoke B.md → (no links)
//   Orphan.md  → (no links, and nothing links to it)

const VAULT_NOTES: Record<string, string> = {
	"LinkTest/Hub.md": [
		"# Hub",
		"",
		"This note links to [[Spoke A]] and [[Spoke B]].",
		"It also references [[NonExistent]] which does not exist.",
	].join("\n"),
	"LinkTest/Spoke A.md": [
		"# Spoke A",
		"",
		"Back-link to [[Hub]].",
	].join("\n"),
	"LinkTest/Spoke B.md": [
		"# Spoke B",
		"",
		"This note has no outgoing links.",
	].join("\n"),
	"LinkTest/Orphan.md": [
		"# Orphan",
		"",
		"No links in, no links out.",
	].join("\n"),
};

function setupTestVault(vaultPath: string): void {
	console.log("  Setting up note-links test fixtures...");
	for (const [relativePath, content] of Object.entries(VAULT_NOTES)) {
		const fullPath = path.join(vaultPath, relativePath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, content, "utf8");
		console.log(`    Created: ${relativePath}`);
	}
}

// ---------------------------------------------------------------------------
// Individual tests
// ---------------------------------------------------------------------------

/**
 * Test 1: get_backlinks on Hub — should find Spoke A (which links to Hub).
 */
async function testBacklinksHub(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n-- Test 1: get_backlinks on Hub (has backlinks from Spoke A) --");

	await newConversation(page);

	const prompt =
		"Use the get_backlinks tool on the note 'LinkTest/Hub.md' and tell me " +
		"which notes link to it. List the exact paths returned.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("01-backlinks-hub-timeout");
		ctx.fail("backlinks Hub — LLM response", "No response within timeout", shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const shot = await ctx.screenshot("01-backlinks-hub");

	if (!toolNames.some((n) => n.toLowerCase().includes("get_backlinks"))) {
		ctx.fail("backlinks Hub — tool called", `No get_backlinks card. Tools: [${toolNames.join(", ")}]. Response: "${response.substring(0, 120)}"`, shot);
		return;
	}
	ctx.pass("backlinks Hub — tool called", `Tool card found: ${toolNames.join(", ")}`, shot);

	// Spoke A links to Hub, so it should appear in the response
	if (response.toLowerCase().includes("spoke a")) {
		ctx.pass("backlinks Hub — contains Spoke A", "Response mentions Spoke A as a backlink");
	} else {
		ctx.fail("backlinks Hub — contains Spoke A", `Response did not mention Spoke A: "${response.substring(0, 200)}"`, shot);
	}
}

/**
 * Test 2: get_backlinks on Orphan — should return none.
 */
async function testBacklinksOrphan(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n-- Test 2: get_backlinks on Orphan (no backlinks) ------------");

	await newConversation(page);

	const prompt =
		"Use the get_backlinks tool on 'LinkTest/Orphan.md'. " +
		"Tell me the exact result — are there any backlinks?";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("02-backlinks-orphan-timeout");
		ctx.fail("backlinks Orphan — LLM response", "No response within timeout", shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const shot = await ctx.screenshot("02-backlinks-orphan");

	if (!toolNames.some((n) => n.toLowerCase().includes("get_backlinks"))) {
		ctx.fail("backlinks Orphan — tool called", `No get_backlinks card. Tools: [${toolNames.join(", ")}]`, shot);
		return;
	}
	ctx.pass("backlinks Orphan — tool called", `Tool card found: ${toolNames.join(", ")}`, shot);

	// Orphan has no backlinks — response should indicate none/empty
	const lower = response.toLowerCase();
	if (lower.includes("none") || lower.includes("no backlinks") || lower.includes("no notes") || lower.includes("no other notes") || lower.includes("doesn't have")) {
		ctx.pass("backlinks Orphan — reports none", "Response correctly indicates no backlinks");
	} else {
		ctx.fail("backlinks Orphan — reports none", `Expected 'none' indication. Response: "${response.substring(0, 200)}"`, shot);
	}
}

/**
 * Test 3: get_outlinks on Hub — should include Spoke A, Spoke B (resolved)
 * and NonExistent (unresolved).
 */
async function testOutlinksHub(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n-- Test 3: get_outlinks on Hub (resolved + unresolved) -------");

	await newConversation(page);

	const prompt =
		"Use the get_outlinks tool on 'LinkTest/Hub.md'. " +
		"List all resolved and unresolved links it returns.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("03-outlinks-hub-timeout");
		ctx.fail("outlinks Hub — LLM response", "No response within timeout", shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const shot = await ctx.screenshot("03-outlinks-hub");

	if (!toolNames.some((n) => n.toLowerCase().includes("get_outlinks"))) {
		ctx.fail("outlinks Hub — tool called", `No get_outlinks card. Tools: [${toolNames.join(", ")}]`, shot);
		return;
	}
	ctx.pass("outlinks Hub — tool called", `Tool card found: ${toolNames.join(", ")}`, shot);

	const lower = response.toLowerCase();

	// Check resolved links — Spoke A and Spoke B
	if (lower.includes("spoke a") && lower.includes("spoke b")) {
		ctx.pass("outlinks Hub — resolved links", "Response mentions both Spoke A and Spoke B as resolved links");
	} else {
		ctx.fail("outlinks Hub — resolved links", `Expected Spoke A and Spoke B. Response: "${response.substring(0, 200)}"`, shot);
	}

	// Check unresolved link — NonExistent
	if (lower.includes("nonexistent") || lower.includes("non-existent") || lower.includes("unresolved")) {
		ctx.pass("outlinks Hub — unresolved link", "Response mentions NonExistent or unresolved links");
	} else {
		ctx.fail("outlinks Hub — unresolved link", `Expected NonExistent in unresolved. Response: "${response.substring(0, 200)}"`, shot);
	}
}

/**
 * Test 4: get_outlinks on Spoke B — no outgoing links.
 */
async function testOutlinksEmpty(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n-- Test 4: get_outlinks on Spoke B (no outgoing links) -------");

	await newConversation(page);

	const prompt =
		"Use the get_outlinks tool on 'LinkTest/Spoke B.md'. " +
		"Tell me the exact result — are there any outgoing links?";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("04-outlinks-empty-timeout");
		ctx.fail("outlinks Spoke B — LLM response", "No response within timeout", shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const shot = await ctx.screenshot("04-outlinks-empty");

	if (!toolNames.some((n) => n.toLowerCase().includes("get_outlinks"))) {
		ctx.fail("outlinks Spoke B — tool called", `No get_outlinks card. Tools: [${toolNames.join(", ")}]`, shot);
		return;
	}
	ctx.pass("outlinks Spoke B — tool called", `Tool card found: ${toolNames.join(", ")}`, shot);

	const lower = response.toLowerCase();
	if (lower.includes("none") || lower.includes("no outgoing") || lower.includes("no links") || lower.includes("doesn't link") || lower.includes("does not link")) {
		ctx.pass("outlinks Spoke B — reports none", "Response correctly indicates no outgoing links");
	} else {
		ctx.fail("outlinks Spoke B — reports none", `Expected 'none' indication. Response: "${response.substring(0, 200)}"`, shot);
	}
}

/**
 * Test 5: get_backlinks on non-existent note — should return error.
 */
async function testBacklinksNotFound(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n-- Test 5: get_backlinks on non-existent note ----------------");

	await newConversation(page);

	const prompt =
		"Use the get_backlinks tool on 'LinkTest/DoesNotExist.md'. " +
		"Tell me what happened.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("05-backlinks-notfound-timeout");
		ctx.fail("backlinks not found — LLM response", "No response within timeout", shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const shot = await ctx.screenshot("05-backlinks-notfound");

	if (!toolNames.some((n) => n.toLowerCase().includes("get_backlinks"))) {
		ctx.fail("backlinks not found — tool called", `No get_backlinks card. Tools: [${toolNames.join(", ")}]`, shot);
		return;
	}
	ctx.pass("backlinks not found — tool called", `Tool card found: ${toolNames.join(", ")}`, shot);

	const lower = response.toLowerCase();
	if (lower.includes("not found") || lower.includes("doesn't exist") || lower.includes("does not exist") || lower.includes("couldn't find") || lower.includes("error")) {
		ctx.pass("backlinks not found — error reported", "Response correctly reports note not found");
	} else {
		ctx.fail("backlinks not found — error reported", `Expected error message. Response: "${response.substring(0, 200)}"`, shot);
	}
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------

async function allTests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);

	await testBacklinksHub(ctx);
	await testBacklinksOrphan(ctx);
	await testOutlinksHub(ctx);
	await testOutlinksEmpty(ctx);
	await testBacklinksNotFound(ctx);
}

runTest(
	{
		name: "note-links-test",
		settings: buildDefaultSettings({
			auto_approve: {
				get_backlinks: true,
				get_outlinks: true,
			},
		}),
		setupVault: (vaultPath) => setupTestVault(vaultPath),
		cleanupFiles: [
			"LinkTest",
		],
	},
	allTests,
);
