/**
 * VaultEventListenerManager — the tag shadow cache is built only when the
 * on-tag-change listener actually starts (setOnTagChangeListenerStart).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/logger", () => {
	const noop = () => undefined;
	return { logger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});

import { VaultEventListenerManager } from "./vault-event-listener-manager";

function emptyHooks() {
	return { on_note_open: [], on_note_create: [], on_save: [], on_manual_save: [], on_tag_change: [], on_schedule: [], on_daily_start: [] };
}

function setup(tagHookEnabled: { value: boolean }) {
	const order: string[] = [];
	const metadataOn = vi.fn(() => { order.push("listen"); return { id: "ref" }; });
	const plugin = {
		app: {
			metadataCache: { on: metadataOn, offref: vi.fn() },
			vault: { on: vi.fn(() => ({})), offref: vi.fn() },
			workspace: { on: vi.fn(() => ({})), offref: vi.fn() },
		},
		registerEvent: vi.fn(),
	};
	const settings = () => ({
		vault_event_hooks: {
			...emptyHooks(),
			on_tag_change: tagHookEnabled.value ? [{ enabled: true }] : [],
		},
	});
	const manager = new VaultEventListenerManager(plugin as never, settings as never, () => []);
	manager.setEventHandler("on_tag_change", { type: "on_tag_change", handler: vi.fn() });
	const onStart = vi.fn(() => order.push("start"));
	manager.setOnTagChangeListenerStart(onStart);
	return { manager, onStart, metadataOn, order };
}

describe("VaultEventListenerManager — tag-change listener start hook", () => {
	it("never fires when no on-tag-change source exists", () => {
		const { manager, onStart, metadataOn } = setup({ value: false });
		manager.evaluateListeners();
		manager.evaluateListeners();
		expect(onStart).not.toHaveBeenCalled();
		expect(metadataOn).not.toHaveBeenCalled();
	});

	it("fires once per registration, before the listener starts receiving events", () => {
		const enabled = { value: true };
		const { manager, onStart, order } = setup(enabled);
		manager.evaluateListeners();
		manager.evaluateListeners(); // already active: no re-registration
		expect(onStart).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["start", "listen"]);

		enabled.value = false;
		manager.evaluateListeners(); // unregistered
		enabled.value = true;
		manager.evaluateListeners(); // re-registered: cache rebuilt again
		expect(onStart).toHaveBeenCalledTimes(2);
	});
});
