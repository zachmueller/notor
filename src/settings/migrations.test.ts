import { describe, it, expect, vi } from "vitest";
import type { App } from "obsidian";
import { migrateOrchestrationToCircuits, type MigrationDeps } from "./migrations";
import type { NotorSettings } from "./types";

function depsFor(partial: Record<string, unknown>): { deps: MigrationDeps; settings: NotorSettings; save: ReturnType<typeof vi.fn> } {
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
		loadData: async () => ({}),
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
