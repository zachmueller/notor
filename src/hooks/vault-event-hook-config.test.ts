/**
 * Unit tests for `addVaultEventHook` — focused on the `run_circuit` action type
 * (legacy `run_orchestration`), the hook-UI gap closure for scheduling circuits.
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

describe("addVaultEventHook — run_circuit (legacy run_orchestration accepted)", () => {
	it("creates a scheduled run_circuit hook with circuit set", () => {
		const config = emptyConfig();
		const hook = addVaultEventHook(
			config,
			"on_schedule",
			"run_circuit",
			"code-assist",
			"Nightly code assist",
			"0 2 * * *",
		);

		expect(hook.action_type).toBe("run_circuit");
		expect(hook.circuit).toBe("code-assist");
		expect(hook.orchestration_flow).toBeUndefined();
		expect(hook.command).toBeNull();
		expect(hook.workflow_path).toBeNull();
		expect(hook.schedule).toBe("0 2 * * *");
		expect(config.on_schedule).toHaveLength(1);
		expect(config.on_schedule[0]).toBe(hook);
	});

	it("normalizes a legacy run_orchestration request to run_circuit + circuit", () => {
		const config = emptyConfig();
		const hook = addVaultEventHook(
			config,
			"on_tag_change",
			"run_orchestration",
			"notor/orchestrations/review",
		);

		expect(hook.action_type).toBe("run_circuit");
		expect(hook.circuit).toBe("notor/orchestrations/review");
		expect(hook.schedule).toBeNull();
		expect(config.on_tag_change).toHaveLength(1);
	});

	it.each(["run_circuit", "run_orchestration"] as const)("rejects a %s hook with an empty circuit reference", (action) => {
		const config = emptyConfig();
		expect(() => addVaultEventHook(config, "on_tag_change", action, "   ")).toThrow(/run_circuit/);
	});

	it("leaves circuit null for non-circuit action types", () => {
		const config = emptyConfig();
		const cmd = addVaultEventHook(config, "on_save", "execute_command", "echo hi");
		const wf = addVaultEventHook(config, "on_save", "run_workflow", "daily/review.md");

		expect(cmd.circuit).toBeNull();
		expect(wf.circuit).toBeNull();
	});
});
