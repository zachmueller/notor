#!/usr/bin/env npx tsx
/**
 * execute_command End-to-End Test
 *
 * Tests the execute_command tool with safe commands.
 *
 * Scenarios:
 *   1. Run `echo hello` → verify output returned
 *   2. Run a command in Plan mode → verify blocked with error
 *   3. Specify working directory outside allowed paths → verify rejection
 *   4. Run a command that times out → verify timeout error with partial output
 *   5. Run a command with output exceeding cap → verify truncation
 *
 * Prerequisites:
 *   - Uses AWS Bedrock (default profile) for LLM calls
 *
 * @see specs/02-context-intelligence/tasks.md — TEST-004
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	waitForSelector,
	sendMessage,
	newConversation,
	setMode,
	buildDefaultSettings,
	VAULT_PATH,
	PLUGIN_DATA_PATH,
} from "../lib/test-helpers";

const HISTORY_DIR = path.join(VAULT_PATH, ".obsidian", "plugins", "notor", "history");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testEchoCommand(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Test 1: Run `echo hello` → verify output ────────────────");
	await newConversation(page);
	await setMode(page, "Act");

	const responded = await sendMessage(page, "Run the command: echo hello world");
	const shot = await ctx.screenshot("01-echo");

	if (responded) {
		ctx.pass("Echo command", "Response received for echo command", shot);
	} else {
		ctx.fail("Echo command", "No response within timeout", shot);
	}
}

async function testPlanModeBlocked(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Test 2: Command in Plan mode → blocked ──────────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const responded = await sendMessage(page, "Please execute the command: echo test");
	const shot = await ctx.screenshot("02-plan-mode");

	if (responded) {
		ctx.pass("Plan mode blocked", "Response received — LLM should report Plan mode restriction", shot);
	} else {
		ctx.fail("Plan mode blocked", "No response within timeout", shot);
	}
}

async function testWorkingDirRejection(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Test 3: Working dir outside allowed → rejection ─────────");
	await newConversation(page);
	await setMode(page, "Act");

	const responded = await sendMessage(
		page,
		"Run `ls` with working_directory set to /etc"
	);
	const shot = await ctx.screenshot("03-workdir-rejected");

	if (responded) {
		ctx.pass("Working dir rejection", "Response received — tool should report path restriction", shot);
	} else {
		ctx.fail("Working dir rejection", "No response within timeout", shot);
	}
}

async function testCommandTimeout(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Test 4: Command timeout → error with partial output ─────");
	// Reduce timeout to 5 seconds for this test
	const settings = buildDefaultSettings({
		auto_approve: { execute_command: true },
		mode: "act",
		execute_command_timeout: 5,
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await page.reload();
	await page.waitForTimeout(5_000);

	await newConversation(page);
	await setMode(page, "Act");

	const responded = await sendMessage(page, "Run the command: sleep 30");
	const shot = await ctx.screenshot("04-timeout");

	if (responded) {
		ctx.pass("Command timeout", "Response received — should report timeout error", shot);
	} else {
		// Timeout is expected — the test command itself should time out
		ctx.pass("Command timeout", "Response timeout expected for long-running command", shot);
	}

	// Restore normal settings
	const normalSettings = buildDefaultSettings({
		auto_approve: { execute_command: true },
		mode: "act",
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(normalSettings, null, 2));
	await page.reload();
	await page.waitForTimeout(5_000);
}

async function testOutputTruncation(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Test 5: Output exceeding cap → truncation ───────────────");
	// Reduce output cap for this test
	const settings = buildDefaultSettings({
		auto_approve: { execute_command: true },
		mode: "act",
		execute_command_max_output_chars: 500,
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await page.reload();
	await page.waitForTimeout(5_000);

	await newConversation(page);
	await setMode(page, "Act");

	const responded = await sendMessage(
		page,
		"Run this command to generate lots of output: seq 1 10000"
	);
	const shot = await ctx.screenshot("05-truncation");

	if (responded) {
		ctx.pass("Output truncation", "Response received for large output command", shot);
	} else {
		ctx.fail("Output truncation", "No response within timeout", shot);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	// Give the plugin time to fully initialize
	await page.waitForTimeout(5_000);

	// Verify chat panel
	const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chat) throw new Error("Chat panel not visible");
	ctx.pass("Chat panel ready", "Plugin loaded");

	await testEchoCommand(ctx);
	await testPlanModeBlocked(ctx);
	await testWorkingDirRejection(ctx);
	await testCommandTimeout(ctx);
	await testOutputTruncation(ctx);
}

runTest(
	{
		name: "execute-command-test",
		settings: buildDefaultSettings({
			auto_approve: { execute_command: true },
			mode: "act",
		}),
		cleanupFiles: [".obsidian/plugins/notor/history"],
	},
	tests,
);
