// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SettingsFieldSchema } from "../../../extensions/types";

// ---------------------------------------------------------------------------
// Obsidian mock — fluent Setting / Notice / SecretComponent
// ---------------------------------------------------------------------------

/** Tracks all Setting instances created during a test. */
let settingInstances: MockSetting[] = [];

class MockSetting {
	nameText = "";
	descText = "";
	buttons: MockButton[] = [];
	texts: MockText[] = [];
	dropdowns: MockDropdown[] = [];

	setName(name: string): this {
		this.nameText = name;
		return this;
	}
	setDesc(desc: string): this {
		this.descText = desc;
		return this;
	}
	setHeading(): this {
		return this;
	}
	addButton(cb: (btn: MockButton) => void): this {
		const btn = new MockButton();
		cb(btn);
		this.buttons.push(btn);
		return this;
	}
	addText(cb: (text: MockText) => void): this {
		const text = new MockText();
		cb(text);
		this.texts.push(text);
		return this;
	}
	addDropdown(cb: (dropdown: MockDropdown) => void): this {
		const dropdown = new MockDropdown();
		cb(dropdown);
		this.dropdowns.push(dropdown);
		return this;
	}
	addToggle(cb: (toggle: MockToggle) => void): this {
		const toggle = new MockToggle();
		cb(toggle);
		return this;
	}
	addComponent(cb: (el: HTMLElement) => unknown): this {
		cb(document.createElement("div"));
		return this;
	}
}

class MockButton {
	text = "";
	isWarning = false;
	clickHandler?: () => void;

	setButtonText(text: string): this {
		this.text = text;
		return this;
	}
	setWarning(): this {
		this.isWarning = true;
		return this;
	}
	onClick(cb: () => void): this {
		this.clickHandler = cb;
		return this;
	}
}

class MockText {
	placeholderText = "";
	currentValue = "";
	changeHandler?: (v: string) => void;

	setPlaceholder(text: string): this {
		this.placeholderText = text;
		return this;
	}
	setValue(v: string): this {
		this.currentValue = v;
		return this;
	}
	onChange(cb: (v: string) => void): this {
		this.changeHandler = cb;
		return this;
	}
}

class MockDropdown {
	options: Record<string, string> = {};
	currentValue = "";
	changeHandler?: (v: string) => void;

	addOption(value: string, display: string): this {
		this.options[value] = display;
		return this;
	}
	setValue(v: string): this {
		this.currentValue = v;
		return this;
	}
	onChange(cb: (v: string) => void): this {
		this.changeHandler = cb;
		return this;
	}
}

class MockToggle {
	currentValue = false;
	setValue(v: boolean): this {
		this.currentValue = v;
		return this;
	}
	onChange(_cb: (v: boolean) => void): this {
		return this;
	}
}

const mockNoticeMessages: string[] = [];

vi.mock("obsidian", () => ({
	Setting: class {
		private inst: MockSetting;
		constructor(_containerEl: HTMLElement) {
			this.inst = new MockSetting();
			settingInstances.push(this.inst);
		}
		setName(name: string) { this.inst.setName(name); return this; }
		setDesc(desc: string) { this.inst.setDesc(desc); return this; }
		setHeading() { this.inst.setHeading(); return this; }
		addButton(cb: (btn: MockButton) => void) { this.inst.addButton(cb); return this; }
		addText(cb: (text: MockText) => void) { this.inst.addText(cb); return this; }
		addDropdown(cb: (dropdown: MockDropdown) => void) { this.inst.addDropdown(cb); return this; }
		addToggle(cb: (toggle: MockToggle) => void) { this.inst.addToggle(cb); return this; }
		addComponent(cb: (el: HTMLElement) => unknown) { this.inst.addComponent(cb); return this; }
	},
	Notice: class {
		constructor(message: string) {
			mockNoticeMessages.push(message);
		}
	},
	SecretComponent: class {
		setValue() { return this; }
		onChange() { return this; }
	},
	Modal: class {
		constructor() {}
		open() {}
		close() {}
	},
	normalizePath: (p: string) => p,
}));

// Import after mocks are set up
import { renderField, type FieldTarget } from "../field-renderer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCtx(extensionSettings: Record<string, unknown> = {}): {
	ctx: Parameters<typeof renderField>[1];
	saveSpy: ReturnType<typeof vi.fn>;
	redisplaySpy: ReturnType<typeof vi.fn>;
} {
	const saveSpy = vi.fn().mockResolvedValue(undefined);
	const redisplaySpy = vi.fn();
	const settings = {
		user_extension_settings: { test_ext: extensionSettings } as Record<string, Record<string, unknown>>,
		user_shared_settings: {} as Record<string, unknown>,
	};
	return {
		ctx: {
			app: {} as never,
			plugin: {} as never,
			settings: settings as never,
			saveSettings: saveSpy,
			redisplay: redisplaySpy,
		},
		saveSpy,
		redisplaySpy,
	};
}

const target: FieldTarget = { kind: "extension", extensionName: "test_ext" };

function makeField(overrides: Partial<SettingsFieldSchema> = {}): SettingsFieldSchema {
	return {
		key: "my_list",
		name: "My List",
		type: "string[]",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	settingInstances = [];
	mockNoticeMessages.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("string[] renderer — reorder buttons", () => {
	it("swaps entry with previous on up-button click", async () => {
		const { ctx, saveSpy, redisplaySpy } = createCtx({ my_list: ["a", "b", "c"] });
		const container = document.createElement("div");

		renderField(container, ctx, makeField(), target);

		// Settings: [0] = header "My List", [1] = "a", [2] = "b", [3] = "c", [4] = add row
		// "b" is at index 2. It should have an up button.
		const bSetting = settingInstances[2]!;
		expect(bSetting.nameText).toBe("b");
		// First button on "b" should be "▲"
		const upBtn = bSetting.buttons.find((b) => b.text === "\u25B2");
		expect(upBtn).toBeDefined();

		await upBtn!.clickHandler!();

		expect(saveSpy).toHaveBeenCalled();
		// The list should now be ["b", "a", "c"]
		const savedList = ctx.settings.user_extension_settings["test_ext"]!["my_list"];
		expect(savedList).toEqual(["b", "a", "c"]);
		expect(redisplaySpy).toHaveBeenCalled();
	});

	it("swaps entry with next on down-button click", async () => {
		const { ctx, saveSpy, redisplaySpy } = createCtx({ my_list: ["a", "b", "c"] });
		const container = document.createElement("div");

		renderField(container, ctx, makeField(), target);

		// "b" is at settingInstances[2]
		const bSetting = settingInstances[2]!;
		const downBtn = bSetting.buttons.find((b) => b.text === "\u25BC");
		expect(downBtn).toBeDefined();

		await downBtn!.clickHandler!();

		expect(saveSpy).toHaveBeenCalled();
		const savedList = ctx.settings.user_extension_settings["test_ext"]!["my_list"];
		expect(savedList).toEqual(["a", "c", "b"]);
		expect(redisplaySpy).toHaveBeenCalled();
	});

	it("hides up button on first entry and down button on last entry", () => {
		const { ctx } = createCtx({ my_list: ["a", "b", "c"] });
		const container = document.createElement("div");

		renderField(container, ctx, makeField(), target);

		// "a" (index 0) — should have no ▲ button
		const aSetting = settingInstances[1]!;
		expect(aSetting.nameText).toBe("a");
		expect(aSetting.buttons.find((b) => b.text === "\u25B2")).toBeUndefined();
		// "a" should have ▼
		expect(aSetting.buttons.find((b) => b.text === "\u25BC")).toBeDefined();

		// "c" (last) — should have no ▼ button
		const cSetting = settingInstances[3]!;
		expect(cSetting.nameText).toBe("c");
		expect(cSetting.buttons.find((b) => b.text === "\u25BC")).toBeUndefined();
		// "c" should have ▲
		expect(cSetting.buttons.find((b) => b.text === "\u25B2")).toBeDefined();
	});
});

describe("string[] renderer — dropdown mode (field.options)", () => {
	it("renders dropdown with unused options when field.options is present", () => {
		const { ctx } = createCtx({ my_list: ["a"] });
		const container = document.createElement("div");

		renderField(
			container,
			ctx,
			makeField({ options: ["a", "b", "c"] }),
			target,
		);

		// Last setting should be the Add row with a dropdown
		const addRow = settingInstances[settingInstances.length - 1]!;
		expect(addRow.nameText).toContain("Add to");
		expect(addRow.dropdowns).toHaveLength(1);
		expect(addRow.texts).toHaveLength(0);

		// Dropdown should only contain unused options "b" and "c"
		const dropdown = addRow.dropdowns[0]!;
		expect(Object.keys(dropdown.options)).toEqual(["b", "c"]);
	});

	it("hides Add row when all options are already in the list", () => {
		const { ctx } = createCtx({ my_list: ["a", "b", "c"] });
		const container = document.createElement("div");

		renderField(
			container,
			ctx,
			makeField({ options: ["a", "b", "c"] }),
			target,
		);

		// Should be: header + 3 entries = 4 settings. No Add row.
		// Verify no setting has "Add to" name
		const addRows = settingInstances.filter((s) => s.nameText.includes("Add to"));
		expect(addRows).toHaveLength(0);
	});

	it("adds selected option from dropdown on click", async () => {
		const { ctx, saveSpy, redisplaySpy } = createCtx({ my_list: ["a"] });
		const container = document.createElement("div");

		renderField(
			container,
			ctx,
			makeField({ options: ["a", "b", "c"] }),
			target,
		);

		const addRow = settingInstances[settingInstances.length - 1]!;
		const dropdown = addRow.dropdowns[0]!;

		// Change selection to "c"
		dropdown.changeHandler!("c");

		// Click Add
		const addBtn = addRow.buttons.find((b) => b.text === "Add");
		expect(addBtn).toBeDefined();
		await addBtn!.clickHandler!();

		expect(saveSpy).toHaveBeenCalled();
		const savedList = ctx.settings.user_extension_settings["test_ext"]!["my_list"];
		expect(savedList).toEqual(["a", "c"]);
		expect(redisplaySpy).toHaveBeenCalled();
	});
});

describe("string[] renderer — free-text fallback", () => {
	it("renders text input when field.options is absent", () => {
		const { ctx } = createCtx({ my_list: ["x"] });
		const container = document.createElement("div");

		renderField(container, ctx, makeField(), target);

		const addRow = settingInstances[settingInstances.length - 1]!;
		expect(addRow.nameText).toContain("Add to");
		expect(addRow.texts).toHaveLength(1);
		expect(addRow.dropdowns).toHaveLength(0);
	});

	it("shows notice when adding empty value in free-text mode", async () => {
		const { ctx, saveSpy } = createCtx({ my_list: [] });
		const container = document.createElement("div");

		renderField(container, ctx, makeField(), target);

		const addRow = settingInstances[settingInstances.length - 1]!;
		const addBtn = addRow.buttons.find((b) => b.text === "Add");
		await addBtn!.clickHandler!();

		expect(mockNoticeMessages).toHaveLength(1);
		expect(mockNoticeMessages[0]).toContain("Enter a value");
		expect(saveSpy).not.toHaveBeenCalled();
	});

	it("adds typed value in free-text mode", async () => {
		const { ctx, saveSpy, redisplaySpy } = createCtx({ my_list: ["x"] });
		const container = document.createElement("div");

		renderField(container, ctx, makeField(), target);

		const addRow = settingInstances[settingInstances.length - 1]!;
		// Simulate typing
		addRow.texts[0]!.changeHandler!("new-entry");

		const addBtn = addRow.buttons.find((b) => b.text === "Add");
		await addBtn!.clickHandler!();

		expect(saveSpy).toHaveBeenCalled();
		const savedList = ctx.settings.user_extension_settings["test_ext"]!["my_list"];
		expect(savedList).toEqual(["x", "new-entry"]);
		expect(redisplaySpy).toHaveBeenCalled();
	});
});
