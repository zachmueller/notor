#!/usr/bin/env npx tsx
/**
 * Orchestration unload-abort E2E Test (F1 — task 03)
 *
 * Proves the integration wiring that unit tests cannot: that the plugin's
 * `onunload` teardown actually aborts every live orchestration run via the
 * registry's `abortAll()`. The recovery-side decision logic (liveness predicate,
 * no-double-spawn, offered-resume) is covered by unit tests
 * (recovery-liveness.test.ts, recovery-boot.test.ts); this drive covers the
 * remaining seam — the registry is real, and disabling the plugin fires the real
 * `onunload` path.
 *
 * Scenario (no Bedrock needed — deterministic):
 *   1. Register a run handle (a real AbortController) on the live registry, as a
 *      launched flow would, and capture the controller.
 *   2. Disable the plugin (fires onunload → abortAll).
 *   3. Assert the captured controller's signal is aborted.
 *   4. Re-enable the plugin; assert the fresh instance's registry has no live runs
 *      (a stale handle did not survive teardown into a phantom second runner).
 *
 * Run with:
 *   npx tsx e2e/scripts/orchestration-unload-abort-test.ts
 *
 * @see specs/ZZ-misc/arch-review-july-2026/tasks/03-run-lifecycle.md
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, writeCleanWorkspace } from "../lib/test-helpers";

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(3_000);

	console.log("\nTest 1: onunload aborts a registered orchestration run");
	// Register a handle on the live registry and stash the controller on window so
	// we can inspect its signal after the plugin is torn down.
	const registered = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };
		const registry = plugin.getOrchestrationRunRegistry?.();
		if (!registry) return { error: "no run registry accessor" };
		const controller = new AbortController();
		(window as any).__e2eAbortController = controller;
		registry.register({
			sessionId: "e2e-unload-abort",
			flowName: "E2E Unload Abort",
			controller,
			lastProgressAt: Date.now(),
		});
		return {
			registeredActive: registry.listActive().some((h: any) => h.sessionId === "e2e-unload-abort"),
			abortedBefore: controller.signal.aborted,
		};
	});

	if ("error" in registered) {
		ctx.fail("register run handle", `harness error: ${registered.error}`);
		return;
	}
	if (registered.registeredActive && !registered.abortedBefore) {
		ctx.pass("run handle registered", "handle is listActive() and not yet aborted");
	} else {
		ctx.fail("run handle registered", `unexpected pre-state: ${JSON.stringify(registered)}`);
		return;
	}

	// Disable the plugin → onunload → abortAll().
	const disabled = await page.evaluate(async () => {
		const app = (window as any).app;
		if (!app?.plugins?.disablePlugin) return { error: "disablePlugin unavailable" };
		await app.plugins.disablePlugin("notor");
		const controller = (window as any).__e2eAbortController as AbortController | undefined;
		return { abortedAfterUnload: controller?.signal.aborted ?? null };
	});

	if ("error" in disabled) {
		ctx.fail("plugin unload aborts run", `harness error: ${disabled.error}`);
	} else if (disabled.abortedAfterUnload === true) {
		ctx.pass("plugin unload aborts run", "the registered run's AbortController fired on onunload (abortAll)");
	} else {
		ctx.fail("plugin unload aborts run", `controller was not aborted after disablePlugin: ${JSON.stringify(disabled)}`);
	}

	console.log("\nTest 2: re-enable starts with a clean registry (no phantom runner)");
	const reenabled = await page.evaluate(async () => {
		const app = (window as any).app;
		if (!app?.plugins?.enablePlugin) return { error: "enablePlugin unavailable" };
		await app.plugins.enablePlugin("notor");
		// Give the fresh instance a moment to construct.
		await new Promise((r) => setTimeout(r, 2_000));
		const plugin = app.plugins.plugins?.["notor"];
		const registry = plugin?.getOrchestrationRunRegistry?.();
		return {
			pluginPresent: plugin != null,
			liveRuns: registry ? registry.listActive().length : -1,
		};
	});

	if ("error" in reenabled) {
		ctx.fail("clean registry after re-enable", `harness error: ${reenabled.error}`);
	} else if (reenabled.pluginPresent && reenabled.liveRuns === 0) {
		ctx.pass("clean registry after re-enable", "the re-enabled instance has 0 live runs (no stale handle survived teardown)");
	} else {
		ctx.fail("clean registry after re-enable", `expected plugin present + 0 live runs; got ${JSON.stringify(reenabled)}`);
	}
}

runTest(
	{
		name: "orchestration-unload-abort",
		settings: buildDefaultSettings({ orchestration_enabled: true }),
		setupVault: (vaultPath: string) => {
			writeCleanWorkspace(vaultPath);
		},
	},
	tests,
);
