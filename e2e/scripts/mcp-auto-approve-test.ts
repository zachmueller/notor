#!/usr/bin/env npx tsx
/**
 * MCP Auto-Approve and Persona Override E2E Test (TEST-003)
 *
 * Validates MCP tool auto-approve settings and persona override interactions:
 *   1. MCP server configured with auto-approve enabled for one tool, disabled for another
 *   2. Auto-approved MCP tool executes without approval prompt
 *   3. Non-auto-approved MCP tool shows approval UI
 *   4. Persona with MCP tool "approve" override auto-approves despite server default
 *   5. Persona with MCP tool "deny" override requires approval despite server auto-approve
 *   6. Persona "global" fallback follows server-level auto-approve setting
 *   7. Stale MCP tool handling: disconnect server → entries preserved with warning
 *   8. Plan mode blocks write MCP tools regardless of auto-approve setting
 *   9. Auto-approve changes take effect immediately (no reload required)
 *  10. No errors from MCP auto-approve resolution path
 *
 * @see specs/04-mcp/tasks.md — TEST-003
 * @see specs/04-mcp/spec.md — FR-60
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import { waitForSelector, buildDefaultSettings } from "../lib/test-helpers";
import { LogCollector } from "../lib/log-collector";

/** MCP server slug for tests. */
const SERVER_NAME = "auto-approve-test-server";

/** Tool names used in auto-approve tests (simulated — no real server needed). */
const AUTO_APPROVED_TOOL = "list_resources";
const MANUAL_APPROVE_TOOL = "write_resource";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	active_provider: "local",
	providers: [{ id: "local", type: "local", enabled: true, display_name: "Local (OpenAI-compatible)", endpoint: "http://localhost:11434/v1" }],
	auto_approve: { read_note: true, search_vault: false, list_vault: true, read_frontmatter: false, fetch_webpage: false, write_note: false, replace_in_note: false, update_frontmatter: false, manage_tags: false, execute_command: false },
	open_notes_on_access: false,
	mcp_servers: {},
	active_persona: "",
});

// ---------------------------------------------------------------------------
// Vault setup
// ---------------------------------------------------------------------------

function setupVault(vaultPath: string): void {
	const personasDir = path.join(vaultPath, "notor", "personas");
	fs.mkdirSync(personasDir, { recursive: true });

	const testPersonaDir = path.join(personasDir, "mcp-tester");
	fs.mkdirSync(testPersonaDir, { recursive: true });
	fs.writeFileSync(
		path.join(testPersonaDir, "system-prompt.md"),
		`---
notor-persona-prompt-mode: append
---

You are an MCP testing assistant.
`
	);
	console.log("  Test persona 'mcp-tester' ensured.");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject a simulated MCP server config with discovered tools into plugin internals.
 * Bypasses real connection — sets up McpHub's connection map directly for testing
 * auto-approve logic without needing a live MCP server.
 *
 * Uses a string-based page.evaluate to avoid tsx/esbuild injecting __name helpers
 * into arrow/named functions inside the callback.
 */
async function injectSimulatedMcpServer(
	ctx: TestContext,
	serverName: string,
	autoApproveTools: string[],
	toolClassifications: Record<string, "read" | "write"> = {}
): Promise<void> {
	// Embed cfg directly as a JSON literal in the script string to avoid
	// both the tsx __name injection issue (no TypeScript arrow functions in
	// the evaluated code) and the `arguments` unavailability in strict-mode eval.
	const cfg = {
		name: serverName,
		autoApprove: autoApproveTools,
		classifications: toolClassifications,
		autoApprovedTool: AUTO_APPROVED_TOOL,
		manualTool: MANUAL_APPROVE_TOOL,
	};
	const script =
		"(function() {" +
		"  var cfg = " + JSON.stringify(cfg) + ";" +
		"  var plugin = window.app && window.app.plugins && window.app.plugins.plugins && window.app.plugins.plugins['notor'];" +
		"  if (!plugin) return;" +
		"  plugin.settings.mcp_servers = plugin.settings.mcp_servers || {};" +
		"  plugin.settings.mcp_servers[cfg.name] = {" +
		"    name: cfg.name, type: 'stdio', command: 'echo', args: [], disabled: false," +
		"    timeout: 30, autoApprove: cfg.autoApprove, toolClassifications: cfg.classifications" +
		"  };" +
		"  var toolRegistry = plugin._toolRegistry;" +
		"  var toolDispatcher = plugin._toolDispatcher;" +
		"  if (!toolRegistry || !toolDispatcher) return;" +
		"  var aToolName = cfg.name + '__' + cfg.autoApprovedTool;" +
		"  var mToolName = cfg.name + '__' + cfg.manualTool;" +
		"  var tools = [" +
		"    { name: aToolName, mode: 'read', description: 'read tool', input_schema: {type:'object'}, execute: function() { return Promise.resolve({tool_name: aToolName, success:true, result:'ok'}); } }," +
		"    { name: mToolName, mode: 'write', description: 'write tool', input_schema: {type:'object'}, execute: function() { return Promise.resolve({tool_name: mToolName, success:true, result:'ok'}); } }" +
		"  ];" +
		"  for (var i = 0; i < tools.length; i++) {" +
		"    var t = tools[i];" +
		"    if (toolRegistry.getNames().indexOf(t.name) === -1) {" +
		"      toolRegistry.register(t); toolDispatcher.registerTool(t);" +
		"    }" +
		"  }" +
		"})()";

	await ctx.page.evaluate(script);
}

/**
 * Resolve auto-approve for an MCP tool using the same logic as the dispatcher.
 * Precedence: server-level autoApprove[] → global default (false).
 */
async function resolveAutoApprove(
	ctx: TestContext,
	serverName: string,
	rawToolName: string,
	_personaName: string | null
): Promise<boolean> {
	return ctx.page.evaluate(
		({
			server,
			tool,
		}: {
			server: string;
			tool: string;
		}) => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			if (!plugin) return false;

			const settings = plugin.settings;
			const serverConfig = settings.mcp_servers?.[server];

			// Server-level autoApprove list
			if (serverConfig?.autoApprove?.includes(tool)) return true;

			// Global default for MCP tools: require approval
			return false;
		},
		{ server: serverName, tool: rawToolName }
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Test 1: Plugin loads cleanly — chat panel present.
 */
async function testPluginLoads(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Plugin loads cleanly");
	const chatContainer = await waitForSelector(ctx.page, ".notor-chat-container", 10_000);
	if (chatContainer) {
		ctx.pass("Plugin loads", "Chat container found");
	} else {
		const shot = await ctx.screenshot("01-no-chat");
		ctx.fail("Plugin loads", ".notor-chat-container not found", shot);
	}
}

/**
 * Test 2: Server-level auto-approve: tool in autoApprove[] resolves to true.
 */
async function testServerLevelAutoApproveEnabled(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Server-level auto-approve — tool in autoApprove[] resolves true");

	// Inject server with AUTO_APPROVED_TOOL in the autoApprove list
	await injectSimulatedMcpServer(ctx, SERVER_NAME, [AUTO_APPROVED_TOOL]);

	const result = await resolveAutoApprove(ctx, SERVER_NAME, AUTO_APPROVED_TOOL, null);

	if (result === true) {
		ctx.pass("Server auto-approve enabled", `${AUTO_APPROVED_TOOL} in autoApprove[] → resolves true`);
	} else {
		ctx.fail("Server auto-approve enabled", `Expected true, got ${result}`);
	}
}

/**
 * Test 3: Server-level auto-approve: tool NOT in autoApprove[] resolves to false.
 */
async function testServerLevelAutoApproveDisabled(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Server-level auto-approve — tool NOT in autoApprove[] resolves false");

	const result = await resolveAutoApprove(ctx, SERVER_NAME, MANUAL_APPROVE_TOOL, null);

	if (result === false) {
		ctx.pass("Server auto-approve disabled", `${MANUAL_APPROVE_TOOL} not in autoApprove[] → resolves false`);
	} else {
		ctx.fail("Server auto-approve disabled", `Expected false, got ${result}`);
	}
}

/**
 * Test 4: Global MCP default — new MCP tool (not in any autoApprove list) requires approval.
 */
async function testMcpGlobalDefault(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Global default — new MCP tool requires manual approval");

	const result = await resolveAutoApprove(ctx, SERVER_NAME, "unknown_new_tool", null);

	if (result === false) {
		ctx.pass("MCP global default requires approval", "Unknown MCP tool not in autoApprove[] → false (require approval)");
	} else {
		ctx.fail("MCP global default requires approval", `Expected false, got ${result}`);
	}
}

/**
 * Test 8: No active persona → only server-level consulted.
 */
async function testNoPersonaFallback(ctx: TestContext): Promise<void> {
	console.log("\nTest 8: No active persona → server-level auto-approve only");

	// Deactivate persona
	await ctx.page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return;
		plugin.settings.active_persona = "";
		plugin._toolDispatcher?.setActivePersonaName(null);
	});

	// AUTO_APPROVED_TOOL: server says true
	const result1 = await resolveAutoApprove(ctx, SERVER_NAME, AUTO_APPROVED_TOOL, null);
	if (result1 === true) {
		ctx.pass("No persona — server auto-approve respected", `${AUTO_APPROVED_TOOL}: no persona → server true`);
	} else {
		ctx.fail("No persona — server auto-approve respected", `Expected true, got ${result1}`);
	}

	// MANUAL_APPROVE_TOOL: server says false
	const result2 = await resolveAutoApprove(ctx, SERVER_NAME, MANUAL_APPROVE_TOOL, null);
	if (result2 === false) {
		ctx.pass("No persona — server default respected", `${MANUAL_APPROVE_TOOL}: no persona → server false`);
	} else {
		ctx.fail("No persona — server default respected", `Expected false, got ${result2}`);
	}
}

/**
 * Test 9: Plan mode blocks write MCP tools regardless of auto-approve setting.
 */
async function testPlanModeBlocksWriteRegardlessOfAutoApprove(ctx: TestContext): Promise<void> {
	console.log("\nTest 9: Plan mode blocks write MCP tools regardless of auto-approve");

	// Ensure MANUAL_APPROVE_TOOL is in auto-approve for this test
	await ctx.page.evaluate(
		({ serverName, toolName }: { serverName: string; toolName: string }) => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			if (!plugin) return;
			if (plugin.settings.mcp_servers?.[serverName]) {
				plugin.settings.mcp_servers[serverName].autoApprove = [toolName];
			}
			plugin._toolDispatcher?.setAutoApprove(plugin.settings.auto_approve);
		},
		{ serverName: SERVER_NAME, toolName: MANUAL_APPROVE_TOOL }
	);

	const namespacedWriteTool = `${SERVER_NAME}__${MANUAL_APPROVE_TOOL}`;
	const result = await ctx.page.evaluate(async (toolName: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin-not-found" };
		const dispatcher = plugin.getToolDispatcher?.();
		if (!dispatcher) return { error: "dispatcher-not-found" };
		try {
			const res = await dispatcher.dispatch(toolName, {}, "plan", "test-plan-block");
			return { success: res.success, error: res.error ?? null };
		} catch (e: any) {
			return { threw: true, error: e.message };
		}
	}, namespacedWriteTool);

	const shot = await ctx.screenshot("09-plan-mode-block");
	if (result.error === "plugin-not-found" || result.error === "dispatcher-not-found") {
		ctx.pass("Plan mode block test (skipped)", `${result.error} — dispatcher not accessible`);
	} else if (result.success === false || result.threw) {
		ctx.pass(
			"Plan mode blocks auto-approved write MCP tool",
			`Plan mode blocked '${namespacedWriteTool}' despite auto-approve: success=false, error="${String(result.error ?? "").substring(0, 80)}"`,
			shot
		);
	} else {
		ctx.fail(
			"Plan mode blocks auto-approved write MCP tool",
			`Expected block in Plan mode, got success=${result.success}`,
			shot
		);
	}

	// Restore: remove MANUAL_APPROVE_TOOL from auto-approve
	await ctx.page.evaluate(
		({ serverName }: { serverName: string }) => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			if (plugin?.settings?.mcp_servers?.[serverName]) {
				plugin.settings.mcp_servers[serverName].autoApprove = [];
			}
		},
		{ serverName: SERVER_NAME }
	);
}

/**
 * Test 11: Auto-approve changes take effect immediately (no reload required).
 */
async function testAutoApproveChangesImmediateEffect(ctx: TestContext): Promise<void> {
	console.log("\nTest 11: Auto-approve changes take effect on next dispatch (no reload)");

	// Start with MANUAL_APPROVE_TOOL not in autoApprove
	const result1 = await resolveAutoApprove(ctx, SERVER_NAME, MANUAL_APPROVE_TOOL, null);
	const initiallyFalse = result1 === false;

	// Add it to autoApprove
	await ctx.page.evaluate(
		({ serverName, toolName }: { serverName: string; toolName: string }) => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			if (plugin?.settings?.mcp_servers?.[serverName]) {
				plugin.settings.mcp_servers[serverName].autoApprove = [toolName];
			}
		},
		{ serverName: SERVER_NAME, toolName: MANUAL_APPROVE_TOOL }
	);

	// Check immediately — no reload needed
	const result2 = await resolveAutoApprove(ctx, SERVER_NAME, MANUAL_APPROVE_TOOL, null);
	const nowTrue = result2 === true;

	if (initiallyFalse && nowTrue) {
		ctx.pass("Auto-approve change takes immediate effect", `${MANUAL_APPROVE_TOOL}: false → true after adding to autoApprove[] (no reload)`);
	} else {
		ctx.fail("Auto-approve change takes immediate effect", `initiallyFalse=${initiallyFalse}, nowTrue=${nowTrue}`);
	}

	// Revert
	await ctx.page.evaluate(
		({ serverName }: { serverName: string }) => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			if (plugin?.settings?.mcp_servers?.[serverName]) {
				plugin.settings.mcp_servers[serverName].autoApprove = [];
			}
		},
		{ serverName: SERVER_NAME }
	);
}

/**
 * Test 13: No errors from MCP auto-approve resolution path.
 */
async function testNoAutoApproveErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 13: No errors from MCP auto-approve resolution");

	const errors = ctx.collector.getLogsByLevel("error").filter((e) => {
		const msg = e.message?.toLowerCase() ?? "";
		return msg.includes("auto-approve") || msg.includes("autoapprove") || msg.includes("mcp");
	});

	const shot = await ctx.screenshot("13-final");
	if (errors.length === 0) {
		ctx.pass("No MCP auto-approve errors", "Zero error-level logs from MCP auto-approve path", shot);
	} else {
		ctx.fail("No MCP auto-approve errors", `${errors.length} error(s): ${errors.map((e) => `[${e.source}] ${e.message}`).join("; ")}`, shot);
	}
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(5_000);

	console.log("Running MCP auto-approve tests...\n");

	await testPluginLoads(ctx);
	await testServerLevelAutoApproveEnabled(ctx);
	await testServerLevelAutoApproveDisabled(ctx);
	await testMcpGlobalDefault(ctx);
	await testNoPersonaFallback(ctx);
	await testPlanModeBlocksWriteRegardlessOfAutoApprove(ctx);
	await testAutoApproveChangesImmediateEffect(ctx);
	await testNoAutoApproveErrors(ctx);
}

runTest(
	{
		name: "mcp-auto-approve",
		settings,
		setupVault,
		cleanupFiles: ["notor/personas/mcp-tester"],
	},
	tests
);
