// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { insertToolbarChipAfter } from "./toolbar-chips";

/** Mirror of the ChatInput toolbar: [left group: mode toggle + badge] [buttons]. */
function buildToolbar(): { toolbar: HTMLElement; leftGroup: HTMLElement; modeToggle: HTMLElement; buttons: HTMLElement } {
	const toolbar = document.createElement("div");
	toolbar.className = "notor-input-toolbar";
	const leftGroup = toolbar.appendChild(document.createElement("div"));
	leftGroup.className = "notor-input-toolbar-left";
	const modeToggle = leftGroup.appendChild(document.createElement("button"));
	modeToggle.className = "notor-mode-toggle";
	leftGroup.appendChild(document.createElement("span")).className = "notor-auto-accept-badge";
	const buttons = toolbar.appendChild(document.createElement("div"));
	buttons.className = "notor-input-buttons";
	return { toolbar, leftGroup, modeToggle, buttons };
}

/** Create a chip appended to the toolbar, as `createDiv` does before placement. */
function appendChip(toolbar: HTMLElement, cls: string): HTMLElement {
	const el = toolbar.appendChild(document.createElement("div"));
	el.className = cls;
	return el;
}

describe("insertToolbarChipAfter", () => {
	let t: ReturnType<typeof buildToolbar>;
	beforeEach(() => { t = buildToolbar(); });

	it("places a chip after the group containing a nested anchor", () => {
		const persona = appendChip(t.toolbar, "persona");
		expect(() => insertToolbarChipAfter(t.toolbar, persona, t.modeToggle)).not.toThrow();
		expect(Array.from(t.toolbar.children)).toEqual([t.leftGroup, persona, t.buttons]);
	});

	it("places a chip after a direct-child anchor", () => {
		const persona = appendChip(t.toolbar, "persona");
		insertToolbarChipAfter(t.toolbar, persona, t.modeToggle);
		const workflow = appendChip(t.toolbar, "workflow");
		insertToolbarChipAfter(t.toolbar, workflow, persona);
		expect(Array.from(t.toolbar.children)).toEqual([t.leftGroup, persona, workflow, t.buttons]);
	});

	it("falls back to the mode toggle when the persona chip is absent", () => {
		const workflow = appendChip(t.toolbar, "workflow");
		insertToolbarChipAfter(t.toolbar, workflow, t.toolbar.querySelector(".notor-mode-toggle"));
		expect(Array.from(t.toolbar.children)).toEqual([t.leftGroup, workflow, t.buttons]);
	});

	it("appends when there is no anchor", () => {
		const chip = document.createElement("div");
		insertToolbarChipAfter(t.toolbar, chip, null);
		expect(t.toolbar.lastElementChild).toBe(chip);
	});

	it("appends when the anchor is outside the toolbar", () => {
		const chip = document.createElement("div");
		insertToolbarChipAfter(t.toolbar, chip, document.createElement("span"));
		expect(t.toolbar.lastElementChild).toBe(chip);
	});
});
