// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { WorkflowActivityDropdown } from "./workflow-activity-dropdown";
import type { FlowRunEntry, WorkflowActivityTracker } from "../workflows/workflow-activity-tracker";

// ---------------------------------------------------------------------------
// Minimal polyfill for Obsidian's HTMLElement DOM-builder extensions + the
// `activeDocument` / `activeWindow` globals the dropdown reaches for. Enough to
// exercise renderEntries → renderFlowRunEntry (the Stop-button gate under test).
// ---------------------------------------------------------------------------
beforeAll(() => {
	type CreateOpts = { cls?: string; text?: string; attr?: Record<string, string> };
	function createEl(this: HTMLElement, tag: string, opts?: CreateOpts): HTMLElement {
		const el = document.createElement(tag);
		if (opts?.cls) el.className = opts.cls;
		if (opts?.text) el.textContent = opts.text;
		if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
		this.appendChild(el);
		return el;
	}
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.createEl = createEl;
	proto.createDiv = function (this: HTMLElement, opts?: CreateOpts) {
		return createEl.call(this, "div", opts);
	};
	proto.createSpan = function (this: HTMLElement, opts?: CreateOpts) {
		return createEl.call(this, "span", opts);
	};
	proto.empty = function (this: HTMLElement) {
		this.innerHTML = "";
	};
	proto.setAttr = function (this: HTMLElement, name: string, value: string) {
		this.setAttribute(name, value);
	};
	proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
		for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
	};
	proto.addClass = function (this: HTMLElement, cls: string) {
		this.classList.add(cls);
	};
	proto.removeClass = function (this: HTMLElement, cls: string) {
		this.classList.remove(cls);
	};
	const g = globalThis as unknown as Record<string, unknown>;
	g.createDiv = (opts?: CreateOpts) => createEl.call(document.body, "div", opts);
	g.createSpan = (opts?: CreateOpts) => createEl.call(document.body, "span", opts);
	g.activeDocument = document;
	g.activeWindow = window;
});

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/** A tracker stub exposing only the members the dropdown reads. */
function trackerStub(flowRuns: FlowRunEntry[]): WorkflowActivityTracker {
	return {
		getIndicatorEntries: () => [],
		getFlowRunEntries: () => flowRuns,
		onChange: () => () => {},
	} as unknown as WorkflowActivityTracker;
}

function activeRun(sessionId: string): FlowRunEntry {
	return { type: "flow-run", sessionId, flowName: "F", status: "active", startedAt: "2026-07-03T00:00:00.000Z" };
}

let anchor: HTMLElement;

beforeEach(() => {
	document.body.innerHTML = "";
	anchor = document.createElement("div");
	document.body.appendChild(anchor);
});

function stopButtons(): NodeListOf<Element> {
	return document.querySelectorAll(".notor-flow-run-stop-button");
}

// ---------------------------------------------------------------------------
// Stop-button gating (F1 Fix 1) — the button must only render for a run the
// abort registry can actually stop. A stale / background entry is `active` in
// the indicator but absent from the registry, so its Stop would be a no-op.
// ---------------------------------------------------------------------------

describe("WorkflowActivityDropdown — Stop-button liveness gate", () => {
	it("renders a Stop button for an active run the registry reports live", () => {
		const onStop = vi.fn();
		const dropdown = new WorkflowActivityDropdown(
			trackerStub([activeRun("s-live")]),
			() => {},
			undefined,
			undefined,
			undefined,
			onStop,
			() => true, // isFlowRunLive
		);
		dropdown.open(anchor);
		expect(stopButtons()).toHaveLength(1);

		(stopButtons()[0] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(onStop).toHaveBeenCalledWith("s-live");
		dropdown.destroy();
	});

	it("omits the Stop button for an active run the registry does NOT report live", () => {
		const onStop = vi.fn();
		const dropdown = new WorkflowActivityDropdown(
			trackerStub([activeRun("s-stale")]),
			() => {},
			undefined,
			undefined,
			undefined,
			onStop,
			() => false, // stale / background: no live handle
		);
		dropdown.open(anchor);
		expect(stopButtons()).toHaveLength(0);
		dropdown.destroy();
	});

	it("gates each entry independently — live root shows Stop, stale child does not", () => {
		const live = new Set(["root"]);
		const dropdown = new WorkflowActivityDropdown(
			trackerStub([activeRun("root"), activeRun("child")]),
			() => {},
			undefined,
			undefined,
			undefined,
			() => {},
			(sessionId) => live.has(sessionId),
		);
		dropdown.open(anchor);
		const buttons = stopButtons();
		expect(buttons).toHaveLength(1);
		// The single Stop button belongs to the live root's entry row.
		expect(buttons[0]!.closest(".notor-workflow-activity-entry")!.textContent).toContain("F");
		dropdown.destroy();
	});

	it("falls back to showing Stop when no liveness predicate is wired (back-compat)", () => {
		const dropdown = new WorkflowActivityDropdown(
			trackerStub([activeRun("s1")]),
			() => {},
			undefined,
			undefined,
			undefined,
			() => {},
			// no isFlowRunLive
		);
		dropdown.open(anchor);
		expect(stopButtons()).toHaveLength(1);
		dropdown.destroy();
	});
});
