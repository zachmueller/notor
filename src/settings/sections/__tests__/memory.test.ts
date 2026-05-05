// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Obsidian mock
// ---------------------------------------------------------------------------

class MockToggle {
	currentValue = false;
	changeHandler?: (v: boolean) => void;
	setValue(v: boolean): this {
		this.currentValue = v;
		return this;
	}
	onChange(cb: (v: boolean) => void): this {
		this.changeHandler = cb;
		return this;
	}
}

let toggleInstances: MockToggle[] = [];
const mockNoticeMessages: string[] = [];

vi.mock("obsidian", () => ({
	Setting: class {
		setName() { return this; }
		setDesc() { return this; }
		setHeading() { return this; }
		addToggle(cb: (toggle: MockToggle) => void) {
			const toggle = new MockToggle();
			cb(toggle);
			toggleInstances.push(toggle);
			return this;
		}
		addText(cb: (text: { setPlaceholder: () => typeof text; setValue: () => typeof text; onChange: () => typeof text }) => void) {
			const text = {
				setPlaceholder() { return text; },
				setValue() { return text; },
				onChange() { return text; },
			};
			cb(text);
			return this;
		}
		addDropdown(cb: (dd: { addOption: () => unknown; setValue: () => unknown; onChange: () => unknown }) => void) {
			const dd = {
				addOption() { return dd; },
				setValue() { return dd; },
				onChange() { return dd; },
			};
			cb(dd);
			return this;
		}
	},
	Notice: class {
		constructor(message: string) {
			mockNoticeMessages.push(message);
		}
	},
	normalizePath: (p: string) => p,
}));

// Mock preset-resolver
const mockResolvePreset = vi.fn();
vi.mock("../../../presets/preset-resolver", () => ({
	resolvePreset: (...args: unknown[]) => mockResolvePreset(...args),
}));

import { renderMemorySection } from "../memory";
import { DEFAULT_AUTO_APPROVE, createDefaultSettings } from "../../defaults";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContainer(): HTMLElement {
	const el = document.createElement("div");
	(el as any).createEl = (_tag: string, _opts?: Record<string, unknown>) => document.createElement("p");
	return el;
}

function createCtx(settingsOverrides: Record<string, unknown> = {}) {
	const settings = {
		...createDefaultSettings(".obsidian"),
		...settingsOverrides,
	};

	const mockManager = {
		reload: vi.fn().mockResolvedValue({ toolCount: 0, automationCount: 0, blockCount: 0, errors: [] }),
	};

	return {
		app: {
			vault: {
				getAbstractFileByPath: vi.fn().mockReturnValue(null),
				createFolder: vi.fn().mockResolvedValue(undefined),
			},
		} as never,
		plugin: {
			getExtensionManager: () => mockManager,
		} as never,
		settings: settings as never,
		saveSettings: vi.fn().mockResolvedValue(undefined),
		redisplay: vi.fn(),
		_manager: mockManager,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	toggleInstances = [];
	mockNoticeMessages.length = 0;
	mockResolvePreset.mockReturnValue({ presetName: "tiny", providerId: "local", modelId: "test" });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory settings — toggle propagation", () => {
	it("memory_enabled: true propagates capture_memory → enabled: true", async () => {
		const ctx = createCtx({ memory_enabled: false });
		const container = createMockContainer();
		renderMemorySection(container, ctx as never);

		const toggle = toggleInstances[0]!;
		await toggle.changeHandler!(true);

		expect((ctx.settings as Record<string, unknown>).memory_enabled).toBe(true);
		expect((ctx.settings as Record<string, Record<string, boolean>>).tool_enabled["capture_memory"]).toBe(true);
	});

	it("memory_enabled: false propagates capture_memory → enabled: false", async () => {
		const ctx = createCtx({ memory_enabled: true });
		const container = createMockContainer();
		renderMemorySection(container, ctx as never);

		const toggle = toggleInstances[0]!;
		await toggle.changeHandler!(false);

		expect((ctx.settings as Record<string, unknown>).memory_enabled).toBe(false);
		expect((ctx.settings as Record<string, Record<string, boolean>>).tool_enabled["capture_memory"]).toBe(false);
	});
});

describe("memory settings — DEFAULT_AUTO_APPROVE", () => {
	it("DEFAULT_AUTO_APPROVE includes capture_memory: true", () => {
		expect(DEFAULT_AUTO_APPROVE["capture_memory"]).toBe(true);
	});
});

describe("memory settings — defaults", () => {
	it("createDefaultSettings has memory_enabled: false and memory_folder: 'memory'", () => {
		const defaults = createDefaultSettings(".obsidian");
		expect(defaults.memory_enabled).toBe(false);
		expect(defaults.memory_folder).toBe("memory");
	});
});

describe("memory settings — auto_approve user override persists across toggles", () => {
	it("user override of auto_approve is not mutated during toggle", async () => {
		const ctx = createCtx({
			memory_enabled: false,
			auto_approve: { ...DEFAULT_AUTO_APPROVE, capture_memory: false },
		});
		const container = createMockContainer();
		renderMemorySection(container, ctx as never);

		const toggle = toggleInstances[0]!;
		await toggle.changeHandler!(true);

		// auto_approve should NOT have been mutated
		expect((ctx.settings as Record<string, Record<string, boolean>>).auto_approve["capture_memory"]).toBe(false);
	});
});

describe("memory settings — preset validation", () => {
	it("missing preset → toggle stays false + Notice", async () => {
		mockResolvePreset.mockReturnValue(null);

		const ctx = createCtx({ memory_enabled: false });
		const container = createMockContainer();
		renderMemorySection(container, ctx as never);

		const toggle = toggleInstances[0]!;
		await toggle.changeHandler!(true);

		expect((ctx.settings as Record<string, unknown>).memory_enabled).toBe(false);
		expect(mockNoticeMessages).toHaveLength(1);
		expect(mockNoticeMessages[0]).toContain("Cannot enable memory");
	});

	it("preset validation passes when both tiny and large presets exist", async () => {
		mockResolvePreset.mockReturnValue({ presetName: "test", providerId: "local", modelId: "m" });

		const ctx = createCtx({ memory_enabled: false });
		const container = createMockContainer();
		renderMemorySection(container, ctx as never);

		const toggle = toggleInstances[0]!;
		await toggle.changeHandler!(true);

		expect((ctx.settings as Record<string, unknown>).memory_enabled).toBe(true);
		expect(mockNoticeMessages).toHaveLength(0);
	});

	it("Notice names the missing preset and scaffolds that use it", async () => {
		mockResolvePreset.mockImplementation((name: string) => {
			if (name === "tiny") return { presetName: "tiny", providerId: "local", modelId: "m" };
			return null; // large is missing
		});

		const ctx = createCtx({ memory_enabled: false });
		const container = createMockContainer();
		renderMemorySection(container, ctx as never);

		const toggle = toggleInstances[0]!;
		await toggle.changeHandler!(true);

		expect((ctx.settings as Record<string, unknown>).memory_enabled).toBe(false);
		expect(mockNoticeMessages[0]).toContain("large");
		expect(mockNoticeMessages[0]).toContain("memory-dream");
	});
});
