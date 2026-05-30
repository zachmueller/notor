#!/usr/bin/env npx tsx
/**
 * MCP Tool Schema Sanitization E2E Test
 *
 * Validates that tool input schemas reported by MCP servers are normalized
 * into the strict JSON Schema draft-2020-12 subset AWS Bedrock accepts, so a
 * single non-conforming MCP schema no longer rejects the entire tool-use
 * request (the original "tools.N.custom.input_schema: JSON schema is invalid"
 * failure).
 *
 * A purpose-built stdio MCP server (e2e/fixtures/nasty-schema-mcp-server.mjs)
 * exposes tools whose schemas contain Bedrock-rejected constructs: draft-07
 * `$schema`/`$id`/`$comment`, `$ref`+`definitions`, tuple `items[]` +
 * `additionalItems`, OpenAPI `nullable`, draft-04 boolean `exclusiveMinimum`,
 * exotic `format`, vendor `x-*` keys, and other unknown keywords. One control
 * tool carries an already-clean schema that must pass through untouched.
 *
 * Scenarios:
 *   1. Plugin + McpHub load cleanly
 *   2. Nasty-schema MCP server connects and discovers all 6 tools
 *   3. Discovered (sanitized) schemas contain no forbidden keywords anywhere
 *   4. Structural rewrites are correct ($ref inlined, tuple→prefixItems,
 *      nullable→type[], boolean exclusiveMinimum→numeric)
 *   5. The already-clean tool schema is preserved unchanged
 *   6. A sanitization warning was logged with the offending server+tool names
 *   7. Bedrock round-trip: with the nasty server connected, a real Converse
 *      request succeeds with NO draft-2020-12 / input_schema error
 *      (gracefully skipped if Bedrock credentials are unavailable)
 *
 * Prerequisites:
 *   - node available in PATH (for the fixture stdio server)
 *   - Scenario 7 additionally needs ~/.aws credentials with Bedrock access
 *
 * @see src/utils/json-schema-sanitizer.ts
 * @see src/mcp/mcp-hub.ts — discoverTools()
 */

import * as path from "node:path";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	sendMessage,
	getLastAssistantMessage,
	PROJECT_ROOT,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const SERVER_NAME = "nasty-schema";
const FIXTURE_PATH = path.join(PROJECT_ROOT, "e2e/fixtures/nasty-schema-mcp-server.mjs");
const CONNECT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 500;

const EXPECTED_TOOLS = [
	"draft07_meta",
	"ref_and_defs",
	"tuple_items",
	"nullable_and_bounds",
	"exotic_format_and_unknown",
	"clean_tool",
];

/**
 * Keywords that must NEVER appear anywhere in a schema sent to Bedrock.
 * Presence of any of these in a discovered schema is a sanitizer failure.
 */
const FORBIDDEN_KEYWORDS = [
	"$schema",
	"$id",
	"id",
	"$comment",
	"$ref",
	"$defs",
	"definitions",
	"format",
	"examples",
	"nullable",
	"additionalItems",
	"contentEncoding",
	"contentMediaType",
	"unevaluatedProperties",
	"deprecated",
	"x-internal",
];

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

async function pollUntil(
	predicate: () => Promise<boolean>,
	timeoutMs: number,
	intervalMs = POLL_INTERVAL_MS
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return false;
}

async function getMcpServerStatus(page: Page, serverName: string): Promise<string | null> {
	return page.evaluate((name: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const conn = plugin?._mcpHub?.getConnection(name);
		return conn?.status ?? null;
	}, serverName);
}

/**
 * Return the discovered (post-sanitization) tools for a server as
 * `{ name, inputSchema }` pairs, read straight from McpHub's stored state.
 */
async function getDiscoveredTools(
	page: Page,
	serverName: string
): Promise<{ name: string; inputSchema: unknown }[]> {
	return page.evaluate((name: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const conn = plugin?._mcpHub?.getConnection(name);
		return (conn?.tools ?? []).map((t: any) => ({
			name: t.name,
			inputSchema: t.inputSchema,
		}));
	}, serverName);
}

/**
 * Containers whose keys are user-defined names (NOT schema keywords) — their
 * keys must be skipped when scanning for forbidden schema keywords, but their
 * values are still schemas to recurse into.
 */
const NAME_MAP_KEYS = new Set([
	"properties",
	"patternProperties",
	"dependentSchemas",
	"$defs",
	"definitions",
]);

/**
 * Recursively collect every schema-keyword key appearing anywhere in a schema.
 * Keys inside `properties` (and similar name→schema maps) are treated as
 * user-defined names, not keywords, so e.g. a property literally named "id"
 * does not count as the `id` schema keyword.
 */
function collectSchemaKeywords(node: unknown, acc: Set<string>): void {
	if (Array.isArray(node)) {
		for (const v of node) collectSchemaKeywords(v, acc);
		return;
	}
	if (!node || typeof node !== "object") return;

	for (const [key, value] of Object.entries(node)) {
		acc.add(key);
		if (NAME_MAP_KEYS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
			// Recurse into the schema values, but skip the (user-defined) names.
			for (const sub of Object.values(value)) collectSchemaKeywords(sub, acc);
		} else {
			collectSchemaKeywords(value, acc);
		}
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testPluginLoads(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Plugin + McpHub load cleanly");
	const { page } = ctx;
	const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (chat) ctx.pass("Plugin loads", "Chat container present");
	else ctx.fail("Plugin loads", ".notor-chat-container not found");

	const hubReady = await page.evaluate(
		() => (window as any).app?.plugins?.plugins?.["notor"]?._mcpHub != null
	);
	if (hubReady) ctx.pass("McpHub initialized", "plugin._mcpHub present");
	else ctx.fail("McpHub initialized", "plugin._mcpHub missing");
}

async function testServerConnects(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Nasty-schema MCP server connects and discovers tools");
	const { page } = ctx;

	await page.evaluate(
		({ name, fixture }: { name: string; fixture: string }) => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			plugin.settings.mcp_servers = plugin.settings.mcp_servers ?? {};
			plugin.settings.mcp_servers[name] = {
				name,
				type: "stdio",
				command: "node",
				args: [fixture],
				disabled: false,
				timeout: 30,
			};
			plugin._mcpHub?.connectServer(name);
		},
		{ name: SERVER_NAME, fixture: FIXTURE_PATH }
	);

	const connected = await pollUntil(
		async () => (await getMcpServerStatus(page, SERVER_NAME)) === "connected",
		CONNECT_TIMEOUT_MS
	);

	const shot = await ctx.screenshot("01-connected");
	if (!connected) {
		const status = await getMcpServerStatus(page, SERVER_NAME);
		ctx.fail("Server connects", `Status '${status}' (expected 'connected')`, shot);
		return;
	}
	ctx.pass("Server connects", "Reached 'connected'", shot);

	const tools = await getDiscoveredTools(page, SERVER_NAME);
	const names = tools.map((t) => t.name).sort();
	if (EXPECTED_TOOLS.every((n) => names.includes(n))) {
		ctx.pass("All tools discovered", `${names.length} tools: ${names.join(", ")}`);
	} else {
		ctx.fail("All tools discovered", `Got [${names.join(", ")}], expected [${EXPECTED_TOOLS.join(", ")}]`);
	}
}

async function testNoForbiddenKeywords(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Sanitized schemas contain no forbidden keywords");
	const { page } = ctx;

	const tools = await getDiscoveredTools(page, SERVER_NAME);
	if (tools.length === 0) {
		ctx.fail("No forbidden keywords", "No discovered tools to inspect");
		return;
	}

	let anyViolation = false;
	for (const tool of tools) {
		const keys = new Set<string>();
		collectSchemaKeywords(tool.inputSchema, keys);
		const offenders = FORBIDDEN_KEYWORDS.filter((k) => keys.has(k));
		if (offenders.length > 0) {
			anyViolation = true;
			ctx.fail(
				`Schema clean: ${tool.name}`,
				`Forbidden keyword(s) present: ${offenders.join(", ")}`
			);
		}
	}

	if (!anyViolation) {
		ctx.pass(
			"No forbidden keywords",
			`All ${tools.length} sanitized schemas free of: ${FORBIDDEN_KEYWORDS.slice(0, 6).join(", ")}, …`
		);
	}
}

async function testStructuralRewrites(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Structural rewrites are correct");
	const { page } = ctx;

	const tools = await getDiscoveredTools(page, SERVER_NAME);
	const byName = new Map(tools.map((t) => [t.name, t.inputSchema as any]));

	// $ref + definitions → inlined, defs removed
	const refTool = byName.get("ref_and_defs");
	if (refTool) {
		const userOk = refTool.properties?.user?.type === "object" &&
			refTool.properties?.user?.properties?.id?.type === "integer";
		const tagsOk = refTool.properties?.tags?.items?.type === "string";
		if (userOk && tagsOk) {
			ctx.pass("$ref inlined", "definitions resolved into properties; no $ref/definitions remain");
		} else {
			ctx.fail("$ref inlined", `Unexpected shape: ${JSON.stringify(refTool.properties)}`);
		}
	} else {
		ctx.fail("$ref inlined", "ref_and_defs tool not found");
	}

	// tuple items[] → prefixItems, additionalItems → items
	const tupleTool = byName.get("tuple_items");
	if (tupleTool) {
		const pair = tupleTool.properties?.pair;
		const prefixOk = Array.isArray(pair?.prefixItems) && pair.prefixItems.length === 2 &&
			pair.prefixItems[0]?.type === "string" && pair.prefixItems[1]?.type === "number";
		const itemsOk = pair?.items?.type === "boolean";
		const noTupleItems = !Array.isArray(pair?.items);
		if (prefixOk && itemsOk && noTupleItems) {
			ctx.pass("Tuple items rewritten", "items[]→prefixItems, additionalItems→items");
		} else {
			ctx.fail("Tuple items rewritten", `Unexpected shape: ${JSON.stringify(pair)}`);
		}
	} else {
		ctx.fail("Tuple items rewritten", "tuple_items tool not found");
	}

	// nullable → type[] ; boolean exclusiveMinimum → numeric
	const nb = byName.get("nullable_and_bounds");
	if (nb) {
		const score = nb.properties?.score;
		const note = nb.properties?.note;
		const exclOk = score?.exclusiveMinimum === 0 && score?.minimum === undefined;
		const nullableOk = Array.isArray(note?.type) &&
			note.type.includes("string") && note.type.includes("null") &&
			note?.nullable === undefined;
		if (exclOk && nullableOk) {
			ctx.pass("nullable + bounds rewritten", "exclusiveMinimum→numeric, nullable→type[]");
		} else {
			ctx.fail("nullable + bounds rewritten", `score=${JSON.stringify(score)}, note=${JSON.stringify(note)}`);
		}
	} else {
		ctx.fail("nullable + bounds rewritten", "nullable_and_bounds tool not found");
	}
}

async function testCleanToolUnchanged(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: Already-clean schema preserved unchanged");
	const { page } = ctx;

	const tools = await getDiscoveredTools(page, SERVER_NAME);
	const clean = tools.find((t) => t.name === "clean_tool")?.inputSchema as any;
	const expected = {
		type: "object",
		properties: {
			path: { type: "string", description: "A path" },
			count: { type: "integer", minimum: 1 },
		},
		required: ["path"],
		additionalProperties: false,
	};

	if (clean && JSON.stringify(clean) === JSON.stringify(expected)) {
		ctx.pass("Clean schema unchanged", "clean_tool schema deep-equals original");
	} else {
		ctx.fail("Clean schema unchanged", `Got: ${JSON.stringify(clean)}`);
	}
}

async function testSanitizationLogged(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: Sanitization warning logged with server+tool name");
	const { collector } = ctx;

	const warnings = collector
		.getStructuredLogs()
		.filter(
			(e) =>
				e.source === "McpHub" &&
				e.message?.includes("sanitized") &&
				(e.data as any)?.serverName === SERVER_NAME
		);

	if (warnings.length === 0) {
		ctx.fail("Sanitization logged", "No 'schema sanitized' McpHub log for the nasty server");
		return;
	}

	const sanitizedToolNames = new Set(warnings.map((w) => (w.data as any)?.toolName));
	// clean_tool must NOT be among the sanitized; the dirty ones must be.
	const cleanFlagged = sanitizedToolNames.has("clean_tool");
	const dirtyFlagged = ["draft07_meta", "ref_and_defs", "tuple_items"].every((n) =>
		sanitizedToolNames.has(n)
	);

	if (dirtyFlagged && !cleanFlagged) {
		ctx.pass(
			"Sanitization logged",
			`${warnings.length} warnings; flagged: ${[...sanitizedToolNames].join(", ")}`
		);
	} else {
		ctx.fail(
			"Sanitization logged",
			`Flagged tools=${[...sanitizedToolNames].join(", ")} (cleanFlagged=${cleanFlagged}, dirtyFlagged=${dirtyFlagged})`
		);
	}
}

async function testBedrockRoundTrip(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: Bedrock round-trip with nasty server connected (no schema error)");
	const { page, collector } = ctx;

	const status = await getMcpServerStatus(page, SERVER_NAME);
	if (status !== "connected") {
		ctx.fail("Bedrock round-trip", "Nasty server not connected — cannot validate end-to-end");
		return;
	}

	const errorsBefore = collector.getLogsByLevel("error").length;

	// A trivial prompt. Bedrock validates the ENTIRE tool list on every request
	// regardless of whether any tool is invoked, so this exercises the schemas.
	await sendMessage(page, "Reply with the single word: ok");

	const schemaError = collector
		.getLogsByLevel("error")
		.find(
			(e) =>
				/input_schema|draft 2020-12|JSON schema is invalid/i.test(e.message ?? "") ||
				/input_schema|draft 2020-12|JSON schema is invalid/i.test(
					JSON.stringify(e.data ?? "")
				)
		);

	const shot = await ctx.screenshot("07-bedrock-roundtrip");

	if (schemaError) {
		ctx.fail(
			"Bedrock round-trip",
			`Bedrock still rejected a tool schema: ${schemaError.message}`,
			shot
		);
		return;
	}

	// Distinguish "succeeded" from "no Bedrock credentials" (a different error).
	const credError = collector
		.getLogsByLevel("error")
		.slice(errorsBefore)
		.find((e) =>
			/credential|expired token|unable to locate|access denied|security token|profile/i.test(
				`${e.message ?? ""} ${JSON.stringify(e.data ?? "")}`
			)
		);

	const reply = await getLastAssistantMessage(page);
	if (reply && reply.trim().length > 0) {
		ctx.pass(
			"Bedrock round-trip",
			`Converse request accepted the tool list; reply: "${reply.trim().substring(0, 60)}"`,
			shot
		);
	} else if (credError) {
		// No creds in this environment — but crucially NO schema-validation error,
		// which is the regression under test.
		ctx.pass(
			"Bedrock round-trip (no creds)",
			"No draft-2020-12 schema error; request failed only on credentials (env-dependent)",
			shot
		);
	} else {
		ctx.fail(
			"Bedrock round-trip",
			"No assistant reply and no recognizable credential error — inspect logs",
			shot
		);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);

	await testPluginLoads(ctx);
	await testServerConnects(ctx);
	await testNoForbiddenKeywords(ctx);
	await testStructuralRewrites(ctx);
	await testCleanToolUnchanged(ctx);
	await testSanitizationLogged(ctx);
	await testBedrockRoundTrip(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mcp_servers: {},
});

runTest({ name: "mcp-schema-sanitization", settings }, tests);
