#!/usr/bin/env npx tsx
/**
 * Phase B Verification: Structural Extraction Test (BV.1)
 *
 * Validates that all Phase B orchestrator decomposition extractions are
 * properly wired — the extracted classes exist on orchestrator instances,
 * their public APIs are callable, and the orchestrator facade still
 * delegates correctly. This is a structural/smoke test, not a functional
 * integration test.
 *
 * Scenarios:
 *   1. Plugin loads and TypeScript compiled successfully
 *   2. ViewRouter is instantiated and wired on each orchestrator
 *   3. SessionManager is instantiated and wired on each orchestrator
 *   4. ConversationLifecycleManager is instantiated and wired
 *   5. ConfigResolver is instantiated and wired
 *   6. HookDispatcher is instantiated and wired
 *   7. CompactionManager is instantiated and wired
 *   8. MessagePipeline functions are importable (module-level exports)
 *   9. Facade delegation: public orchestrator methods still work
 *  10. No unexpected error logs from extraction wiring
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-implementation-tasks.md — BV.1
 */

import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	writeCleanWorkspace,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const CHAT_VIEW_TYPE = "notor-chat-view";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

async function safeRun(
	ctx: TestContext,
	name: string,
	fn: () => Promise<void>,
): Promise<void> {
	try {
		await fn();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.fail(name, `Unhandled error: ${msg.substring(0, 200)}`);
		console.error(`  [catch] ${name}:`, err);
	}
}

/** Get the first orchestrator from the registry. */
async function getFirstOrchestrator(page: any): Promise<any> {
	return page.evaluate((viewType: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		const orchMap = (plugin as any)._orchestrators;
		if (!orchMap || orchMap.size === 0) return null;
		// Return "exists" marker — can't return class instances directly
		return { exists: true, registrySize: orchMap.size };
	}, CHAT_VIEW_TYPE);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testPluginLoaded(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 1: Plugin loads and TypeScript compiled successfully --");
	const { page } = ctx;

	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };
		return {
			hasOrchestrators: (plugin as any)._orchestrators instanceof Map,
			registrySize: (plugin as any)._orchestrators?.size ?? -1,
		};
	});

	if ((result as any).error) {
		ctx.fail("Plugin loaded", `Error: ${(result as any).error}`);
		return;
	}

	const r = result as { hasOrchestrators: boolean; registrySize: number };

	if (r.hasOrchestrators && r.registrySize >= 1) {
		ctx.pass(
			"Plugin loaded",
			`Registry has ${r.registrySize} orchestrator(s) — TypeScript compiled and plugin loaded`,
		);
	} else {
		ctx.fail(
			"Plugin loaded",
			`hasOrchestrators=${r.hasOrchestrators}, registrySize=${r.registrySize}`,
		);
	}
}

async function testViewRouterWired(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 2: ViewRouter is instantiated and wired --");
	const { page } = ctx;

	const result = await page.evaluate((viewType: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const orchMap = (plugin as any)._orchestrators;
		if (!orchMap || orchMap.size === 0) return { error: "no orchestrators" };

		const orch = orchMap.values().next().value;
		const vr = (orch as any).viewRouter;

		return {
			hasViewRouter: !!vr,
			hasSetView: typeof vr?.setView === "function",
			hasGetView: typeof vr?.getView === "function",
			hasGetViewForSession: typeof vr?.getViewForSession === "function",
			hasRenderMessage: typeof vr?.renderMessage === "function",
			viewIsSet: vr?.getView() !== undefined,
		};
	}, CHAT_VIEW_TYPE);

	if ((result as any).error) {
		ctx.fail("ViewRouter wired", `Error: ${(result as any).error}`);
		return;
	}

	const r = result as {
		hasViewRouter: boolean;
		hasSetView: boolean;
		hasGetView: boolean;
		hasGetViewForSession: boolean;
		hasRenderMessage: boolean;
		viewIsSet: boolean;
	};

	const allWired = r.hasViewRouter && r.hasSetView && r.hasGetView &&
		r.hasGetViewForSession && r.hasRenderMessage && r.viewIsSet;

	if (allWired) {
		ctx.pass(
			"ViewRouter wired",
			`ViewRouter present with all methods: setView=${r.hasSetView}, getView=${r.hasGetView}, ` +
			`getViewForSession=${r.hasGetViewForSession}, renderMessage=${r.hasRenderMessage}, viewIsSet=${r.viewIsSet}`,
		);
	} else {
		ctx.fail(
			"ViewRouter wired",
			`hasViewRouter=${r.hasViewRouter}, setView=${r.hasSetView}, getView=${r.hasGetView}, ` +
			`getViewForSession=${r.hasGetViewForSession}, renderMessage=${r.hasRenderMessage}, viewIsSet=${r.viewIsSet}`,
		);
	}
}

async function testSessionManagerWired(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 3: SessionManager is instantiated and wired --");
	const { page } = ctx;

	const result = await page.evaluate((viewType: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const orchMap = (plugin as any)._orchestrators;
		if (!orchMap || orchMap.size === 0) return { error: "no orchestrators" };

		const orch = orchMap.values().next().value;
		const sm = (orch as any).sessionManager;

		return {
			hasSessionManager: !!sm,
			hasGetActiveSession: typeof sm?.getActiveSession === "function",
			hasGetActiveSessions: typeof sm?.getActiveSessions === "function",
			hasHasActiveSession: typeof sm?.hasActiveSession === "function",
			hasOnSessionsChanged: typeof sm?.onSessionsChanged === "function",
			hasCheckSessionGuards: typeof sm?.checkSessionGuards === "function",
			hasRegisterSession: typeof sm?.registerSession === "function",
			hasUnregisterSession: typeof sm?.unregisterSession === "function",
			hasDestroy: typeof sm?.destroy === "function",
			// Verify facade delegates
			facadeGetActiveSessions: typeof orch?.getActiveSessions === "function",
			facadeHasActiveSession: typeof orch?.hasActiveSession === "function",
			// Quick smoke: getActiveSessions returns an array
			activeSessionsIsArray: Array.isArray(sm?.getActiveSessions?.()),
		};
	}, CHAT_VIEW_TYPE);

	if ((result as any).error) {
		ctx.fail("SessionManager wired", `Error: ${(result as any).error}`);
		return;
	}

	const r = result as {
		hasSessionManager: boolean;
		hasGetActiveSession: boolean;
		hasGetActiveSessions: boolean;
		hasHasActiveSession: boolean;
		hasOnSessionsChanged: boolean;
		hasCheckSessionGuards: boolean;
		hasRegisterSession: boolean;
		hasUnregisterSession: boolean;
		hasDestroy: boolean;
		facadeGetActiveSessions: boolean;
		facadeHasActiveSession: boolean;
		activeSessionsIsArray: boolean;
	};

	const allWired = r.hasSessionManager && r.hasGetActiveSession &&
		r.hasGetActiveSessions && r.hasHasActiveSession && r.hasOnSessionsChanged &&
		r.hasCheckSessionGuards && r.hasRegisterSession && r.hasUnregisterSession &&
		r.hasDestroy && r.activeSessionsIsArray;

	if (allWired) {
		ctx.pass(
			"SessionManager wired",
			`SessionManager present with all methods. Facade delegates: getActiveSessions=${r.facadeGetActiveSessions}, ` +
			`hasActiveSession=${r.facadeHasActiveSession}. activeSessionsIsArray=${r.activeSessionsIsArray}`,
		);
	} else {
		ctx.fail(
			"SessionManager wired",
			`hasSessionManager=${r.hasSessionManager}, methods: getActive=${r.hasGetActiveSession}, ` +
			`getAll=${r.hasGetActiveSessions}, has=${r.hasHasActiveSession}, onChanged=${r.hasOnSessionsChanged}, ` +
			`checkGuards=${r.hasCheckSessionGuards}, register=${r.hasRegisterSession}, ` +
			`unregister=${r.hasUnregisterSession}, destroy=${r.hasDestroy}`,
		);
	}
}

async function testConversationLifecycleWired(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 4: ConversationLifecycleManager is instantiated and wired --");
	const { page } = ctx;

	const result = await page.evaluate((viewType: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const orchMap = (plugin as any)._orchestrators;
		if (!orchMap || orchMap.size === 0) return { error: "no orchestrators" };

		const orch = orchMap.values().next().value;
		const lm = (orch as any).lifecycle;

		return {
			hasLifecycle: !!lm,
			hasNewConversation: typeof lm?.newConversation === "function",
			hasSwitchConversation: typeof lm?.switchConversation === "function",
			hasSwitchToConversationById: typeof lm?.switchToConversationById === "function",
			hasForkConversation: typeof lm?.forkConversation === "function",
			hasMaybeRevertWorkflowPersona: typeof lm?.maybeRevertWorkflowPersona === "function",
			hasSetWorkflowPersonaRevert: typeof lm?.setWorkflowPersonaRevert === "function",
			// Verify facade delegates
			facadeNewConversation: typeof orch?.newConversation === "function",
			facadeSwitchConversation: typeof orch?.switchConversation === "function",
			facadeForkConversation: typeof orch?.forkConversation === "function",
		};
	}, CHAT_VIEW_TYPE);

	if ((result as any).error) {
		ctx.fail("ConversationLifecycleManager wired", `Error: ${(result as any).error}`);
		return;
	}

	const r = result as {
		hasLifecycle: boolean;
		hasNewConversation: boolean;
		hasSwitchConversation: boolean;
		hasSwitchToConversationById: boolean;
		hasForkConversation: boolean;
		hasMaybeRevertWorkflowPersona: boolean;
		hasSetWorkflowPersonaRevert: boolean;
		facadeNewConversation: boolean;
		facadeSwitchConversation: boolean;
		facadeForkConversation: boolean;
	};

	const allWired = r.hasLifecycle && r.hasNewConversation && r.hasSwitchConversation &&
		r.hasSwitchToConversationById && r.hasForkConversation;

	if (allWired) {
		ctx.pass(
			"ConversationLifecycleManager wired",
			`Lifecycle present with all methods. Facade delegates: new=${r.facadeNewConversation}, ` +
			`switch=${r.facadeSwitchConversation}, fork=${r.facadeForkConversation}`,
		);
	} else {
		ctx.fail(
			"ConversationLifecycleManager wired",
			`hasLifecycle=${r.hasLifecycle}, new=${r.hasNewConversation}, switch=${r.hasSwitchConversation}, ` +
			`switchById=${r.hasSwitchToConversationById}, fork=${r.hasForkConversation}`,
		);
	}
}

async function testConfigResolverWired(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 5: ConfigResolver is instantiated and wired --");
	const { page } = ctx;

	const result = await page.evaluate((viewType: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const orchMap = (plugin as any)._orchestrators;
		if (!orchMap || orchMap.size === 0) return { error: "no orchestrators" };

		const orch = orchMap.values().next().value;
		const cr = (orch as any).configResolver;

		return {
			hasConfigResolver: !!cr,
			hasResolveEffectiveConfig: typeof cr?.resolveEffectiveConfig === "function",
			hasUpdateDisplayConfig: typeof cr?.updateDisplayConfig === "function",
			hasGetEffectiveToolConfig: typeof cr?.getEffectiveToolConfig === "function",
			hasGetActiveParsedConfigs: typeof cr?.getActiveParsedConfigs === "function",
			hasSetGetToolDefinitions: typeof cr?.setGetToolDefinitions === "function",
			hasUpdateSettings: typeof cr?.updateSettings === "function",
			// Verify facade delegates
			facadeGetEffectiveToolConfig: typeof orch?.getEffectiveToolConfig === "function",
			facadeGetActiveParsedConfigs: typeof orch?.getActiveParsedConfigs === "function",
		};
	}, CHAT_VIEW_TYPE);

	if ((result as any).error) {
		ctx.fail("ConfigResolver wired", `Error: ${(result as any).error}`);
		return;
	}

	const r = result as {
		hasConfigResolver: boolean;
		hasResolveEffectiveConfig: boolean;
		hasUpdateDisplayConfig: boolean;
		hasGetEffectiveToolConfig: boolean;
		hasGetActiveParsedConfigs: boolean;
		hasSetGetToolDefinitions: boolean;
		hasUpdateSettings: boolean;
		facadeGetEffectiveToolConfig: boolean;
		facadeGetActiveParsedConfigs: boolean;
	};

	const allWired = r.hasConfigResolver && r.hasResolveEffectiveConfig &&
		r.hasUpdateDisplayConfig && r.hasGetEffectiveToolConfig &&
		r.hasGetActiveParsedConfigs && r.hasSetGetToolDefinitions;

	if (allWired) {
		ctx.pass(
			"ConfigResolver wired",
			`ConfigResolver present with all methods. Facade: getEffective=${r.facadeGetEffectiveToolConfig}, ` +
			`getParsed=${r.facadeGetActiveParsedConfigs}`,
		);
	} else {
		ctx.fail(
			"ConfigResolver wired",
			`hasConfigResolver=${r.hasConfigResolver}, resolve=${r.hasResolveEffectiveConfig}, ` +
			`updateDisplay=${r.hasUpdateDisplayConfig}, getEffective=${r.hasGetEffectiveToolConfig}, ` +
			`getParsed=${r.hasGetActiveParsedConfigs}, setGetToolDefs=${r.hasSetGetToolDefinitions}`,
		);
	}
}

async function testHookDispatcherWired(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 6: HookDispatcher is instantiated and wired --");
	const { page } = ctx;

	const result = await page.evaluate((viewType: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const orchMap = (plugin as any)._orchestrators;
		if (!orchMap || orchMap.size === 0) return { error: "no orchestrators" };

		const orch = orchMap.values().next().value;
		const hd = (orch as any).hookDispatcher;

		return {
			hasHookDispatcher: !!hd,
			hasDispatchPreSendHooks: typeof hd?.dispatchPreSendHooks === "function",
			hasDispatchToolCallHook: typeof hd?.dispatchToolCallHook === "function",
			hasDispatchToolResultHook: typeof hd?.dispatchToolResultHook === "function",
			hasDispatchAfterCompletionHooks: typeof hd?.dispatchAfterCompletionHooks === "function",
		};
	}, CHAT_VIEW_TYPE);

	if ((result as any).error) {
		ctx.fail("HookDispatcher wired", `Error: ${(result as any).error}`);
		return;
	}

	const r = result as {
		hasHookDispatcher: boolean;
		hasDispatchPreSendHooks: boolean;
		hasDispatchToolCallHook: boolean;
		hasDispatchToolResultHook: boolean;
		hasDispatchAfterCompletionHooks: boolean;
	};

	const allWired = r.hasHookDispatcher && r.hasDispatchPreSendHooks &&
		r.hasDispatchToolCallHook && r.hasDispatchToolResultHook &&
		r.hasDispatchAfterCompletionHooks;

	if (allWired) {
		ctx.pass(
			"HookDispatcher wired",
			`HookDispatcher present with all methods: preSend=${r.hasDispatchPreSendHooks}, ` +
			`toolCall=${r.hasDispatchToolCallHook}, toolResult=${r.hasDispatchToolResultHook}, ` +
			`afterCompletion=${r.hasDispatchAfterCompletionHooks}`,
		);
	} else {
		ctx.fail(
			"HookDispatcher wired",
			`hasHookDispatcher=${r.hasHookDispatcher}, preSend=${r.hasDispatchPreSendHooks}, ` +
			`toolCall=${r.hasDispatchToolCallHook}, toolResult=${r.hasDispatchToolResultHook}, ` +
			`afterCompletion=${r.hasDispatchAfterCompletionHooks}`,
		);
	}
}

async function testCompactionManagerWired(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 7: CompactionManager is instantiated and wired --");
	const { page } = ctx;

	const result = await page.evaluate((viewType: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const orchMap = (plugin as any)._orchestrators;
		if (!orchMap || orchMap.size === 0) return { error: "no orchestrators" };

		const orch = orchMap.values().next().value;
		const cm = (orch as any).compactionManager;

		return {
			hasCompactionManager: !!cm,
			hasCheckAndPerformCompaction: typeof cm?.checkAndPerformCompaction === "function",
			hasManualCompaction: typeof cm?.manualCompaction === "function",
			// Verify facade delegates
			facadeManualCompaction: typeof orch?.manualCompaction === "function",
		};
	}, CHAT_VIEW_TYPE);

	if ((result as any).error) {
		ctx.fail("CompactionManager wired", `Error: ${(result as any).error}`);
		return;
	}

	const r = result as {
		hasCompactionManager: boolean;
		hasCheckAndPerformCompaction: boolean;
		hasManualCompaction: boolean;
		facadeManualCompaction: boolean;
	};

	const allWired = r.hasCompactionManager && r.hasCheckAndPerformCompaction &&
		r.hasManualCompaction;

	if (allWired) {
		ctx.pass(
			"CompactionManager wired",
			`CompactionManager present: checkAndPerform=${r.hasCheckAndPerformCompaction}, ` +
			`manual=${r.hasManualCompaction}. Facade: manual=${r.facadeManualCompaction}`,
		);
	} else {
		ctx.fail(
			"CompactionManager wired",
			`hasCompactionManager=${r.hasCompactionManager}, checkAndPerform=${r.hasCheckAndPerformCompaction}, ` +
			`manual=${r.hasManualCompaction}`,
		);
	}
}

async function testMessagePipelineFunctions(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 8: MessagePipeline functions are available --");
	const { page } = ctx;

	// MessagePipeline functions are module-level exports, not on the orchestrator.
	// We verify that the orchestrator no longer has the old private methods
	// (toChatMessages, processStream) — these were moved to the pipeline module.
	const result = await page.evaluate((viewType: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const orchMap = (plugin as any)._orchestrators;
		if (!orchMap || orchMap.size === 0) return { error: "no orchestrators" };

		const orch = orchMap.values().next().value;

		return {
			// These private methods should have been REMOVED from the orchestrator
			// after extraction to message-pipeline.ts (B7.2)
			orchHasToChatMessages: typeof (orch as any).toChatMessages === "function",
			orchHasProcessStream: typeof (orch as any).processStream === "function",
			orchHasBgToChatMessages: typeof (orch as any)._bgToChatMessages === "function",
			// The orchestrator should still have the response loop (stays on facade)
			orchHasResponseLoop: typeof (orch as any).responseLoop === "function",
		};
	}, CHAT_VIEW_TYPE);

	if ((result as any).error) {
		ctx.fail("MessagePipeline functions", `Error: ${(result as any).error}`);
		return;
	}

	const r = result as {
		orchHasToChatMessages: boolean;
		orchHasProcessStream: boolean;
		orchHasBgToChatMessages: boolean;
		orchHasResponseLoop: boolean;
	};

	const oldMethodsRemoved = !r.orchHasToChatMessages && !r.orchHasProcessStream && !r.orchHasBgToChatMessages;

	if (oldMethodsRemoved && r.orchHasResponseLoop) {
		ctx.pass(
			"MessagePipeline functions",
			`Old methods removed from orchestrator: toChatMessages=${r.orchHasToChatMessages}, ` +
			`processStream=${r.orchHasProcessStream}, _bgToChatMessages=${r.orchHasBgToChatMessages}. ` +
			`responseLoop retained on facade=${r.orchHasResponseLoop}`,
		);
	} else {
		ctx.fail(
			"MessagePipeline functions",
			`Old methods still on orchestrator: toChatMessages=${r.orchHasToChatMessages}, ` +
			`processStream=${r.orchHasProcessStream}, _bgToChatMessages=${r.orchHasBgToChatMessages}. ` +
			`responseLoop=${r.orchHasResponseLoop}`,
		);
	}
}

async function testFacadeDelegation(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 9: Facade delegation — public orchestrator methods still work --");
	const { page } = ctx;

	const result = await page.evaluate((viewType: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const orchMap = (plugin as any)._orchestrators;
		if (!orchMap || orchMap.size === 0) return { error: "no orchestrators" };

		const orch = orchMap.values().next().value;

		// Test that key facade methods exist and are callable
		const checks: Record<string, boolean> = {};

		// View-related (delegated to ViewRouter)
		checks.setView = typeof orch.setView === "function";
		checks.getView = typeof orch.getView === "function";
		checks.getViewForSession = typeof orch.getViewForSession === "function";

		// Session-related (delegated to SessionManager)
		checks.getActiveSession = typeof orch.getActiveSession === "function";
		checks.getActiveSessions = typeof orch.getActiveSessions === "function";
		checks.hasActiveSession = typeof orch.hasActiveSession === "function";
		checks.onSessionsChanged = typeof orch.onSessionsChanged === "function";

		// Conversation lifecycle (delegated to ConversationLifecycleManager)
		checks.newConversation = typeof orch.newConversation === "function";
		checks.switchConversation = typeof orch.switchConversation === "function";
		checks.switchToConversationById = typeof orch.switchToConversationById === "function";
		checks.forkConversation = typeof orch.forkConversation === "function";

		// Config (delegated to ConfigResolver)
		checks.getEffectiveToolConfig = typeof orch.getEffectiveToolConfig === "function";
		checks.getActiveParsedConfigs = typeof orch.getActiveParsedConfigs === "function";

		// Compaction (delegated to CompactionManager)
		checks.manualCompaction = typeof orch.manualCompaction === "function";

		// Core methods that stay on the facade
		checks.handleUserMessage = typeof orch.handleUserMessage === "function";
		checks.executeWorkflow = typeof orch.executeWorkflow === "function";
		checks.destroy = typeof orch.destroy === "function";
		checks.updateSettings = typeof orch.updateSettings === "function";

		const allPresent = Object.values(checks).every(Boolean);

		return { checks, allPresent };
	}, CHAT_VIEW_TYPE);

	if ((result as any).error) {
		ctx.fail("Facade delegation", `Error: ${(result as any).error}`);
		return;
	}

	const r = result as { checks: Record<string, boolean>; allPresent: boolean };

	if (r.allPresent) {
		ctx.pass(
			"Facade delegation",
			`All ${Object.keys(r.checks).length} facade methods present and callable`,
		);
	} else {
		const missing = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
		ctx.fail(
			"Facade delegation",
			`Missing facade methods: ${missing.join(", ")}`,
		);
	}
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 10: No unexpected error logs from extraction wiring --");
	const { collector } = ctx;

	const relevantSources = [
		"ChatOrchestrator",
		"ViewRouter",
		"SessionManager",
		"ConversationLifecycle",
		"ConfigResolver",
		"HookDispatcher",
		"CompactionManager",
		"MessagePipeline",
	];

	const errorLogs = collector.getStructuredLogs().filter(
		(e) =>
			e.level === "error" &&
			relevantSources.some((src) => e.source.includes(src)) &&
			// Exclude expected errors from provider/network issues
			!e.message.includes("Provider error") &&
			!e.message.includes("AUTH_FAILED") &&
			!e.message.includes("API key not configured") &&
			!e.message.includes("RATE_LIMITED") &&
			!e.message.includes("connection") &&
			!e.message.includes("timeout"),
	);

	if (errorLogs.length === 0) {
		ctx.pass(
			"No unexpected errors",
			`Zero error-level logs from ${relevantSources.join(", ")} during structural tests`,
		);
	} else {
		ctx.fail(
			"No unexpected errors",
			`${errorLogs.length} error(s): ` +
			errorLogs.slice(0, 5).map((e) => `[${e.source}] "${e.message}"`).join("; "),
		);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);

	const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chatContainer) throw new Error("Chat panel not visible — cannot run tests");
	ctx.pass("Chat panel ready", "Plugin loaded and chat container found");

	await safeRun(ctx, "Plugin loaded", () => testPluginLoaded(ctx));
	await safeRun(ctx, "ViewRouter wired", () => testViewRouterWired(ctx));
	await safeRun(ctx, "SessionManager wired", () => testSessionManagerWired(ctx));
	await safeRun(ctx, "ConversationLifecycleManager wired", () => testConversationLifecycleWired(ctx));
	await safeRun(ctx, "ConfigResolver wired", () => testConfigResolverWired(ctx));
	await safeRun(ctx, "HookDispatcher wired", () => testHookDispatcherWired(ctx));
	await safeRun(ctx, "CompactionManager wired", () => testCompactionManagerWired(ctx));
	await safeRun(ctx, "MessagePipeline functions", () => testMessagePipelineFunctions(ctx));
	await safeRun(ctx, "Facade delegation", () => testFacadeDelegation(ctx));

	// Error check (always last)
	await safeRun(ctx, "No unexpected errors", () => testNoUnexpectedErrors(ctx));
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mode: "plan",
});

runTest({
	name: "phase-b-structural",
	settings,
	setupVault: (vaultPath) => writeCleanWorkspace(vaultPath),
}, tests);
