/**
 * Unit tests for `addVaultEventHook` — focused on the `run_orchestration` action
 * type (the hook-UI gap closure for directly scheduling orchestrations).
 */

import { describe, it, expect } from "vitest";
import type { VaultEventHookConfig } from "../types";
import { addVaultEventHook } from "./vault-event-hook-config";

function emptyConfig(): VaultEventHookConfig {
	return {
		on_note_open: [],
		on_note_create: [],
		on_save: [],
		on_manual_save: [],
		on_tag_change: [],
		on_schedule: [],
	};
}

describe("addVaultEventHook — run_orchestration", () => {
	it("creates a scheduled run_orchestration hook with orchestration_flow set", () => {
		const config = emptyConfig();
		const hook = addVaultEventHook(
			config,
			"on_schedule",
			"run_orchestration",
			"code-assist",
			"Nightly code assist",
			"0 2 * * *",
		);

		expect(hook.action_type).toBe("run_orchestration");
		expect(hook.orchestration_flow).toBe("code-assist");
		expect(hook.command).toBeNull();
		expect(hook.workflow_path).toBeNull();
		expect(hook.schedule).toBe("0 2 * * *");
		expect(config.on_schedule).toHaveLength(1);
		expect(config.on_schedule[0]).toBe(hook);
	});

	it("creates an event-driven run_orchestration hook (no schedule required)", () => {
		const config = emptyConfig();
		const hook = addVaultEventHook(
			config,
			"on_tag_change",
			"run_orchestration",
			"notor/orchestrations/review",
		);

		expect(hook.action_type).toBe("run_orchestration");
		expect(hook.orchestration_flow).toBe("notor/orchestrations/review");
		expect(hook.schedule).toBeNull();
		expect(config.on_tag_change).toHaveLength(1);
	});

	it("rejects a run_orchestration hook with an empty flow reference", () => {
		const config = emptyConfig();
		expect(() =>
			addVaultEventHook(config, "on_tag_change", "run_orchestration", "   "),
		).toThrow(/run_orchestration/);
	});

	it("leaves orchestration_flow null for non-orchestration action types", () => {
		const config = emptyConfig();
		const cmd = addVaultEventHook(config, "on_save", "execute_command", "echo hi");
		const wf = addVaultEventHook(config, "on_save", "run_workflow", "daily/review.md");

		expect(cmd.orchestration_flow).toBeNull();
		expect(wf.orchestration_flow).toBeNull();
	});
});
