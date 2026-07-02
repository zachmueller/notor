#!/usr/bin/env npx tsx
/**
 * Extension runtime-hardening E2E Test (F5 — task 05)
 *
 * Drives the two F5 behaviors that unit tests can only approximate, in a live
 * Obsidian instance, WITHOUT needing an LLM turn (deterministic + cheap):
 *
 *   1. Runtime API handshake (F5 Phase 1): a tool declaring `notor-min-api: 99`
 *      (newer than this build's RUNTIME_API_VERSION) is REFUSED — it produces a
 *      user extension error naming both versions, does NOT register as a tool,
 *      and the plugin surfaces a persistent error Notice.
 *   2. Execution timeout (F5 Phase 2): a tool whose body hangs
 *      (`await new Promise(()=>{})`) errors after the configured timeout with a
 *      structured ToolResult (success:false, timeout message) instead of wedging —
 *      exercised through the REGISTERED UserToolAdapter.execute() path.
 *
 * Both assertions call the real ExtensionManager / registered adapter through the
 * live plugin, so they cover the production wiring end-to-end (parser refusal →
 * reload errors → Notice; adapter.execute → withTimeout → structured error).
 *
 * Prerequisites:
 *   - Obsidian at /Applications/Obsidian.app (or OBSIDIAN_PATH). No Bedrock needed.
 *
 * Run with:
 *   npx tsx e2e/scripts/runtime-hardening-test.ts
 *
 * @see specs/ZZ-misc/arch-review-july-2026/tasks/05-extension-runtime-hardening.md
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, writeCleanWorkspace } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Tool fixtures
// ---------------------------------------------------------------------------

/** A read tool requiring a runtime API newer than any real build → must be refused. */
const FUTURE_API_TOOL_MD = `---
notor-type: tool
notor-tool-name: e2e_future_api
notor-description: "A tool requiring a future runtime API version"
notor-mode: read
notor-min-api: 99
---

# Future API Tool

\`\`\`yaml
params:
  query:
    type: string
    description: "Ignored"
\`\`\`

\`\`\`js
return "should never run: " + params.query;
\`\`\`
`;

/** A read tool that hangs forever → must be cut off by the execution timeout. */
const HANGING_TOOL_MD = `---
notor-type: tool
notor-tool-name: e2e_hang
notor-description: "A tool that never resolves"
notor-mode: read
---

# Hanging Tool

\`\`\`yaml
params:
  query:
    type: string
    description: "Ignored"
\`\`\`

\`\`\`js
await new Promise(() => {});
return "unreachable";
\`\`\`
`;

function setupVault(vaultPath: string): void {
	// Deferred views (Obsidian 1.12): pin a chat leaf so .notor-chat-container mounts.
	writeCleanWorkspace(vaultPath);
	const toolsDir = path.join(vaultPath, "notor", "tools");
	if (fs.existsSync(toolsDir)) fs.rmSync(toolsDir, { recursive: true, force: true });
	fs.mkdirSync(toolsDir, { recursive: true });
	fs.writeFileSync(path.join(toolsDir, "future-api.md"), FUTURE_API_TOOL_MD);
	fs.writeFileSync(path.join(toolsDir, "hang.md"), HANGING_TOOL_MD);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	// Let the plugin finish its initial extension reload.
	await page.waitForTimeout(4_000);

	// -- Test 1: notor-min-api: 99 refused, not registered, Notice shown --------
	console.log("\nTest 1: notor-min-api handshake refuses a future-API tool");
	const refusal = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };
		const mgr = plugin.getExtensionManager();
		// Reload to get a deterministic error set (also re-registers valid tools).
		const result = await mgr.reload(false);
		const errors = (result.errors ?? []).map((e: any) => ({ filePath: e.filePath, message: e.message }));
		const toolNames: string[] = mgr.getTools().map((t: any) => t.name);
		const dispatcher = plugin.getToolDispatcher?.();
		const registered: string[] = dispatcher?.getRegisteredToolNames?.() ?? [];
		return {
			errors,
			futureRegistered: toolNames.includes("e2e_future_api") || registered.includes("e2e_future_api"),
			hangRegistered: toolNames.includes("e2e_hang") || registered.includes("e2e_hang"),
			noticePresent: plugin._extensionStaleNotice != null,
		};
	});

	if ("error" in refusal) {
		ctx.fail("min-api refusal", `harness error: ${refusal.error}`);
	} else {
		const futureErr = refusal.errors.find((e) => e.filePath.endsWith("future-api.md"));
		if (futureErr && /v99/.test(futureErr.message) && /v1\b/.test(futureErr.message)) {
			ctx.pass("min-api error surfaced", `error names both versions: "${futureErr.message}"`);
		} else {
			ctx.fail("min-api error surfaced", `expected a future-api.md error naming v99 + v1; got ${JSON.stringify(refusal.errors)}`);
		}

		if (!refusal.futureRegistered) {
			ctx.pass("future-API tool not registered", "e2e_future_api is absent from the tool registry");
		} else {
			ctx.fail("future-API tool not registered", "e2e_future_api was registered despite the version gate");
		}

		if (refusal.noticePresent) {
			ctx.pass("persistent error Notice shown", "_extensionStaleNotice is set after the failed reload");
		} else {
			ctx.fail("persistent error Notice shown", "_extensionStaleNotice was not set after a failed extension reload");
		}
	}

	// -- Test 2: hanging tool times out instead of wedging ----------------------
	console.log("\nTest 2: a hanging tool errors after the execution timeout");
	const timeout = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };
		const mgr = plugin.getExtensionManager();
		// Reach the registered adapter (private map on the dispatcher) so we drive
		// the exact production execute() → withTimeout() path.
		const dispatcher = plugin.getToolDispatcher?.();
		const adapter = dispatcher?.tools?.get?.("e2e_hang");
		if (!adapter) return { error: "e2e_hang adapter not registered" };

		// Configure a short timeout so the test resolves quickly.
		const prev = plugin.settings.extension_execution_timeout_seconds;
		plugin.settings.extension_execution_timeout_seconds = 1;
		const start = Date.now();
		let res: any;
		try {
			res = await adapter.execute({ query: "hi" }, {});
		} catch (e) {
			res = { threw: true, error: (e as any)?.message ?? String(e) };
		} finally {
			plugin.settings.extension_execution_timeout_seconds = prev;
		}
		return { elapsedMs: Date.now() - start, res };
	});

	if ("error" in timeout) {
		ctx.fail("hanging tool timeout", `harness error: ${timeout.error}`);
	} else {
		const r = timeout.res;
		const timedOut =
			r && r.success === false && typeof r.error === "string" && /timeout|await boundary/i.test(r.error);
		if (timedOut && timeout.elapsedMs < 10_000) {
			ctx.pass("hanging tool timed out", `structured error after ${timeout.elapsedMs}ms: "${r.error}"`);
		} else {
			ctx.fail("hanging tool timed out", `expected a timeout error under 10s; got elapsed=${timeout.elapsedMs}ms res=${JSON.stringify(r)}`);
		}
	}
}

runTest(
	{
		name: "runtime-hardening",
		settings: buildDefaultSettings(),
		setupVault,
	},
	tests,
);
