import { describe, it, expect, vi } from "vitest";
import type { App } from "obsidian";
import { migrateOrchestrationToCircuits, type MigrationDeps } from "./migrations";
import type { NotorSettings } from "./types";

function depsFor(partial: Record<string, unknown>, saved: Record<string, unknown> = {}): { deps: MigrationDeps; settings: NotorSettings; save: ReturnType<typeof vi.fn> } {
	const settings = {
		auto_approve: {},
		tool_enabled: {},
		user_extension_settings: {},
		...partial,
	} as unknown as NotorSettings;
	const save = vi.fn(async () => {});
	const deps: MigrationDeps = {
		settings,
		app: {} as App,
		saveSettings: save,
		loadData: async () => saved,
		saveData: async () => {},
	};
	return { deps, settings, save };
}

describe("migrateOrchestrationToCircuits — tool-keyed maps", () => {
	it("moves legacy tool keys to canonical names in every tool-keyed map", async () => {
		const { deps, settings, save } = depsFor({
			auto_approve: { run_flow: true, orchestration_task_close: true, read_note: true },
			tool_enabled: { orchestration_task_list: false },
			user_extension_settings: { orchestration_task_ensure: { foo: 1 } },
		});
		await migrateOrchestrationToCircuits(deps);
		expect(settings.auto_approve).toEqual({ run_circuit: true, circuit_task_close: true, read_note: true });
		expect(settings.tool_enabled).toEqual({ circuit_task_list: false });
		expect(settings.user_extension_settings).toEqual({ circuit_task_ensure: { foo: 1 } });
		expect(save).toHaveBeenCalledTimes(1);
	});

	it("keeps an existing canonical value over the legacy one", async () => {
		const { deps, settings } = depsFor({ auto_approve: { run_flow: true, run_circuit: false } });
		await migrateOrchestrationToCircuits(deps);
		expect(settings.auto_approve).toEqual({ run_circuit: false });
	});

	it("is a no-op (no save) when nothing legacy is present, and idempotent", async () => {
		const { deps, save } = depsFor({ auto_approve: { read_note: true, run_circuit: true } });
		await migrateOrchestrationToCircuits(deps);
		await migrateOrchestrationToCircuits(deps);
		expect(save).not.toHaveBeenCalled();
	});
});

describe("migrateOrchestrationToCircuits — settings keys and hooks", () => {
	it("carries legacy settings values over the merged defaults", async () => {
		// After loadSettings: defaults supplied circuits_* = false, saved data had the legacy keys.
		const saved = {
			orchestration_enabled: true,
			orchestration_write_failure_notes: true,
			orchestration_open_notes_in_editor: true,
		};
		const { deps, settings, save } = depsFor(
			{ ...saved, circuits_enabled: false, circuits_write_failure_notes: false, circuits_open_notes_in_editor: false },
			saved,
		);
		await migrateOrchestrationToCircuits(deps);
		const raw = settings as unknown as Record<string, unknown>;
		expect(raw.circuits_enabled).toBe(true);
		expect(raw.circuits_write_failure_notes).toBe(true);
		expect(raw.circuits_open_notes_in_editor).toBe(true);
		expect(raw.orchestration_enabled).toBeUndefined();
		expect(save).toHaveBeenCalledTimes(1);
	});

	it("carries the legacy value even when an earlier migration already persisted the default", async () => {
		// Regression: earlier migrations call saveSettings(), which writes the
		// merged default circuits_enabled: false into data.json before this runs.
		const persisted = { orchestration_enabled: true, circuits_enabled: false };
		const { deps, settings } = depsFor({ ...persisted }, persisted);
		await migrateOrchestrationToCircuits(deps);
		const raw = settings as unknown as Record<string, unknown>;
		expect(raw.circuits_enabled).toBe(true);
		expect(raw.orchestration_enabled).toBeUndefined();
	});

	it("rewrites run_orchestration hooks in both lifecycle and vault-event configs", async () => {
		const { deps, settings } = depsFor({
			hooks: {
				pre_send: [{ id: "a", action_type: "run_orchestration", orchestration_flow: "Review" }],
				after_completion: [{ id: "b", action_type: "execute_command", command: "echo" }],
			},
			vault_event_hooks: {
				on_note_open: [{ id: "c", action_type: "run_orchestration", orchestration_flow: "notor/orchestrations/review" }],
				on_schedule: [{ id: "d", action_type: "run_circuit", circuit: "New", orchestration_flow: "Old" }],
			},
		});
		await migrateOrchestrationToCircuits(deps);
		const hooks = (settings as unknown as { hooks: Record<string, unknown[]> }).hooks;
		const vault = (settings as unknown as { vault_event_hooks: Record<string, unknown[]> }).vault_event_hooks;
		expect(hooks.pre_send![0]).toEqual({ id: "a", action_type: "run_circuit", circuit: "Review" });
		expect(hooks.after_completion![0]).toEqual({ id: "b", action_type: "execute_command", command: "echo" });
		expect(vault.on_note_open![0]).toEqual({ id: "c", action_type: "run_circuit", circuit: "notor/orchestrations/review" });
		expect(vault.on_schedule![0]).toEqual({ id: "d", action_type: "run_circuit", circuit: "New" });
	});
});
