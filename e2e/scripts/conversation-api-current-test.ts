#!/usr/bin/env npx tsx
/**
 * conversationApi.current() Extension API E2E Test
 *
 * Validates the parse-free `utils.conversationApi.current()` accessor available
 * to user extensions, which returns a `ConversationSnapshot` of the bound
 * conversation (id, persona, workflow, model, mode, extended-context flag, and
 * this-turn tool calls) assembled from the session (when a turn is live) and the
 * conversation header.
 *
 * Driven via a real vault extension tool that returns the snapshot as JSON, then
 * dispatched against a conversation with known header fields — no live model.
 *
 * Scenarios:
 *   1. The snapshot tool is discovered and registered (mode=read)
 *   2. Dispatched against a conversation with known header fields, current()
 *      returns a non-null snapshot whose id / activePersona / activeWorkflow /
 *      model / mode / useExtendedContext match the header
 *   3. toolCallsThisTurn is an array (empty under deterministic dispatch — the
 *      in-flight pending-call population requires a live LLM turn)
 *   4. No unexpected extension errors logged
 *
 * @see src/extensions/runtime-context/chat-utils.ts — buildConversationSnapshot / conversationApi.current
 * @see src/extensions/runtime-context/types.ts — ConversationSnapshot
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, writeCleanWorkspace } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Fixture: a read-mode tool that returns conversationApi.current() as JSON
// ---------------------------------------------------------------------------

const SNAPSHOT_TOOL_MD = `---
notor-type: tool
notor-tool-name: e2e_conv_snapshot
notor-description: "Returns conversationApi.current() as JSON for e2e testing. Use when asked for the conversation snapshot."
notor-mode: read
---

# Conversation Snapshot Tool

Returns the current conversation snapshot for e2e validation.

\`\`\`yaml
params:
  noop:
    type: string
    description: "Unused placeholder parameter"
\`\`\`

\`\`\`js
const api = utils.conversationApi;
if (!api) return JSON.stringify({ apiNull: true });
const snap = api.current();
return JSON.stringify({ apiNull: false, snapshot: snap });
\`\`\`
`;

const KNOWN = {
	persona: "researcher",
	workflowPath: "notor/workflows/daily/review.md",
	workflowName: "daily/review",
	providerId: "bedrock",
	modelId: "test-model-xyz",
	mode: "act",
};

// ---------------------------------------------------------------------------
// Test 1: tool registered
// ---------------------------------------------------------------------------

async function testToolRegistered(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: e2e_conv_snapshot tool registered (mode=read)");
	const { page } = ctx;

	// Reload extensions if discovery hasn't picked up the fixture yet.
	let info = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const tool = plugin?.getToolRegistry?.()?.get("e2e_conv_snapshot");
		return tool ? { found: true, mode: tool.mode } : { found: false };
	});

	if (!info.found) {
		await page.evaluate(async () => {
			const mgr = (window as any).app?.plugins?.plugins?.["notor"]?.getExtensionManager?.();
			if (mgr) await mgr.reload(false);
		});
		await page.waitForTimeout(1_500);
		info = await page.evaluate(() => {
			const tool = (window as any).app?.plugins?.plugins?.["notor"]?.getToolRegistry?.()?.get("e2e_conv_snapshot");
			return tool ? { found: true, mode: tool.mode } : { found: false };
		});
	}

	if (info.found && info.mode === "read") {
		ctx.pass("Snapshot tool registered", "e2e_conv_snapshot found with mode=read");
	} else {
		ctx.fail("Snapshot tool registered", `found=${info.found}, mode=${(info as any).mode}`);
	}
}

// ---------------------------------------------------------------------------
// Test 2-3: dispatch against a known conversation, assert the snapshot
// ---------------------------------------------------------------------------

async function testSnapshot(ctx: TestContext): Promise<void> {
	console.log("\nTest 2-3: current() returns a snapshot matching the conversation header");
	const { page } = ctx;

	const outcome = await page.evaluate(async (known) => {
		const w = window as any;
		const plugin = w.app?.plugins?.plugins?.["notor"];
		if (!plugin) return { ok: false, error: "Plugin not found" };

		const orchestrator = plugin.getActiveOrchestrator?.();
		const dispatcher = plugin.getToolDispatcher?.();
		const hm = plugin.getHistoryManager?.();
		if (!orchestrator || !dispatcher || !hm) {
			return { ok: false, error: "Missing orchestrator/dispatcher/historyManager" };
		}

		// Create + switch to a conversation with known header fields.
		const now = new Date().toISOString();
		const conv = {
			id: crypto.randomUUID(),
			title: "Snapshot Test",
			created_at: now,
			updated_at: now,
			provider_id: known.providerId,
			model_id: known.modelId,
			mode: known.mode,
			persona_name: known.persona,
			workflow_path: known.workflowPath,
			workflow_name: known.workflowName,
			use_extended_context: true,
			total_input_tokens: 0,
			total_output_tokens: 0,
			estimated_cost: 0,
			is_background: false,
		};
		const filename = await hm.importConversation(conv, [{
			id: crypto.randomUUID(), conversation_id: conv.id, role: "user",
			content: "hi", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
		}]);
		await orchestrator.switchConversation(filename);
		await new Promise((r) => setTimeout(r, 1_500));

		// Resolve the effective config the way the response loop does.
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

		const result = await dispatcher.dispatch(
			"e2e_conv_snapshot",
			{ noop: "x" },
			"act",
			"msg-conv-snap",
			undefined, // abortSignal
			undefined, // onProgress
			policyCtx,
			() => Promise.resolve("approved"), // read tool → auto-approved; not awaited
			orchestrator, // sessionContext — supplies getActiveConversation()
			undefined, // approvalHookDispatcher
			undefined, // interactionCallback
		);
		return { ok: true, expectedId: conv.id, result };
	}, KNOWN);

	if (!outcome.ok) {
		ctx.fail("Dispatch snapshot tool", outcome.error ?? "unknown");
		return;
	}

	const shot = await ctx.screenshot("02-snapshot");
	const result = (outcome as any).result;
	if (!result || result.success !== true || typeof result.result !== "string") {
		ctx.fail("Dispatch snapshot tool", `Tool did not succeed: ${JSON.stringify(result)?.substring(0, 200)}`, shot);
		return;
	}

	let parsed: any;
	try {
		parsed = JSON.parse(result.result);
	} catch (e) {
		ctx.fail("Dispatch snapshot tool", `Tool result not JSON: ${result.result?.substring(0, 200)}`, shot);
		return;
	}

	if (parsed.apiNull) {
		ctx.fail("conversationApi available", "utils.conversationApi was null inside the tool");
		return;
	}
	ctx.pass("conversationApi available", "utils.conversationApi was bound for the dispatched tool");

	const s = parsed.snapshot;
	if (!s) {
		ctx.fail("Snapshot is non-null", "current() returned null", shot);
		return;
	}
	ctx.pass("Snapshot is non-null", "current() returned a snapshot object", shot);

	const expectedId = (outcome as any).expectedId;
	const checks: Array<[string, boolean, string]> = [
		["Snapshot id matches", s.id === expectedId, `id=${s.id}`],
		["activePersona matches header", s.activePersona === KNOWN.persona, `activePersona=${JSON.stringify(s.activePersona)}`],
		["activeWorkflow matches header", !!s.activeWorkflow && s.activeWorkflow.name === KNOWN.workflowName && s.activeWorkflow.path === KNOWN.workflowPath, `activeWorkflow=${JSON.stringify(s.activeWorkflow)}`],
		["model matches header", !!s.model && s.model.providerId === KNOWN.providerId && s.model.modelId === KNOWN.modelId, `model=${JSON.stringify(s.model)}`],
		["mode matches header", s.mode === KNOWN.mode, `mode=${JSON.stringify(s.mode)}`],
		["useExtendedContext matches header", s.useExtendedContext === true, `useExtendedContext=${JSON.stringify(s.useExtendedContext)}`],
	];
	for (const [name, ok, detail] of checks) {
		if (ok) ctx.pass(name, detail);
		else ctx.fail(name, `Mismatch — ${detail}`);
	}

	if (Array.isArray(s.toolCallsThisTurn)) {
		ctx.pass("toolCallsThisTurn is an array", `length=${s.toolCallsThisTurn.length} (empty without a live session — by design)`);
	} else {
		ctx.fail("toolCallsThisTurn is an array", `Got ${JSON.stringify(s.toolCallsThisTurn)}`);
	}
}

// ---------------------------------------------------------------------------
// Test 4: no unexpected extension errors
// ---------------------------------------------------------------------------

async function testNoErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: no unexpected extension errors logged");
	const errors = ctx.collector.getLogsByLevel("error");
	const relevant = errors.filter(
		(e) =>
			e.source?.startsWith("ext:") ||
			e.source === "ExtensionManager" ||
			e.message?.toLowerCase().includes("conversationapi") ||
			e.message?.toLowerCase().includes("snapshot"),
	);
	if (relevant.length === 0) {
		ctx.pass("No extension errors", "Zero relevant error-level logs");
	} else {
		ctx.fail("No extension errors", `${relevant.length}: ${relevant.map((e) => e.message).join("; ")}`);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(8_000); // plugin init + extension discovery

	await page.evaluate(() => {
		if (typeof (window as any).__name === "undefined") {
			(window as any).__name = (fn: unknown, _name: string) => fn;
		}
	});

	await testToolRegistered(ctx);
	await testSnapshot(ctx);
	await testNoErrors(ctx);
}

const settings = buildDefaultSettings({ user_extension_settings: {}, user_shared_settings: {} });

runTest(
	{
		name: "conversation-api-current-test",
		settings,
		setupVault: (vaultPath) => {
			// Pin a clean workspace so the chat panel (deferred view in Obsidian 1.12)
			// mounts regardless of leftover workspace state from prior runs.
			writeCleanWorkspace(vaultPath);
			const toolsDir = path.join(vaultPath, "notor", "tools");
			if (fs.existsSync(toolsDir)) fs.rmSync(toolsDir, { recursive: true, force: true });
			fs.mkdirSync(toolsDir, { recursive: true });
			fs.writeFileSync(path.join(toolsDir, "e2e-conv-snapshot.md"), SNAPSHOT_TOOL_MD);
			console.log("  Snapshot tool fixture created: notor/tools/e2e-conv-snapshot.md");
		},
		cleanupFiles: ["notor/tools/e2e-conv-snapshot.md"],
	},
	tests,
);
