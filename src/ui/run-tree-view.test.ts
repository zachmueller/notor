// @vitest-environment jsdom
/**
 * CircuitRunTreeView — startup and live-update cost:
 *  - setState doesn't wait for the history scan (Obsidian waits on setState while
 *    restoring the workspace); a loading state shows meanwhile;
 *  - a slower, older build never overwrites a newer one;
 *  - live activity updates are coalesced to one rebuild per interval, and
 *    deferred while the view is hidden.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/logger", () => {
	const noop = () => undefined;
	return { logger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});

vi.mock("obsidian", () => {
	class ItemView {
		app: unknown;
		containerEl: HTMLElement;
		constructor(public leaf: { app: unknown }) {
			this.app = leaf.app;
			this.containerEl = document.createElement("div");
			this.containerEl.appendChild(document.createElement("div"));
			this.containerEl.appendChild(document.createElement("div"));
		}
		registerEvent(): void {}
		async setState(): Promise<void> {}
	}
	return {
		ItemView,
		normalizePath: (p: string) => p.replace(/\/+$/, ""),
		setIcon: () => undefined,
	};
});

import { CircuitRunTreeView, LIVE_REBUILD_INTERVAL_MS } from "./run-tree-view";

beforeAll(() => {
	type Opts = { cls?: string; text?: string };
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	function createEl(this: HTMLElement, tag: string, opts?: Opts): HTMLElement {
		const el = document.createElement(tag);
		if (opts?.cls) el.className = opts.cls;
		if (opts?.text) el.textContent = opts.text;
		this.appendChild(el);
		return el;
	}
	proto.createEl = createEl;
	proto.createDiv = function (this: HTMLElement, o?: Opts) { return createEl.call(this, "div", o); };
	proto.createSpan = function (this: HTMLElement, o?: Opts) { return createEl.call(this, "span", o); };
	proto.empty = function (this: HTMLElement) { this.replaceChildren(); };
	proto.addClass = function (this: HTMLElement, c: string) { this.classList.add(c); };
	proto.removeClass = function (this: HTMLElement, c: string) { this.classList.remove(c); };
});

const HISTORY = ".obsidian/plugins/notor/history";

function stepHeader(id: string, sessionId: string, title: string): string {
	return JSON.stringify({
		_type: "orchestration_step_conversation", id, title,
		orchestration_session_id: sessionId, orchestration_step_name: "plan", orchestration_iteration: 1,
		orchestration_edges: [],
	}) + "\n" + "{}\n";
}

function setup() {
	const files: Record<string, string> = {
		[`${HISTORY}/orchestration_step_c1.jsonl`]: stepHeader("c1", "sess-1", "Step one"),
		[`${HISTORY}/orchestration_step_c2.jsonl`]: stepHeader("c2", "sess-2", "Step two"),
	};
	let release: (() => void) | null = null;
	const gate = { blocked: false };
	const list = vi.fn(async () => {
		if (gate.blocked) await new Promise<void>((r) => { release = r; });
		return { files: Object.keys(files), folders: [] };
	});
	const adapter = {
		exists: vi.fn(async () => true),
		list,
		read: vi.fn(async (p: string) => files[p] ?? ""),
	};
	const listeners: Array<() => void> = [];
	const app = { vault: { adapter }, workspace: { on: vi.fn(() => ({})) } };
	const plugin = {
		app,
		settings: { history_path: `${HISTORY}/`, notor_dir: "notor" },
		getWorkflowActivityTracker: () => ({
			onChange: (cb: () => void) => { listeners.push(cb); return () => undefined; },
		}),
		getCircuitDataRootName: () => "circuits",
	};
	const view = new CircuitRunTreeView({ app } as never, plugin as never);
	const shown = { value: true };
	(view.containerEl as unknown as { isShown: () => boolean }).isShown = () => shown.value;
	const text = () => view.containerEl.textContent ?? "";
	const fire = () => listeners.forEach((cb) => cb());
	return { view, list, gate, release: () => release?.(), shown, text, fire };
}

const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("CircuitRunTreeView", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("returns from setState before the scan finishes and shows a loading state", async () => {
		const { view, gate, release, text } = setup();
		await view.onOpen();
		gate.blocked = true;
		await view.setState({ rootSessionId: "sess-1" }, {} as never); // resolves while the scan is blocked
		await flush();
		expect(text()).toContain("Loading run tree…");

		release();
		await flush();
		expect(text()).toContain("Step one");
		expect(text()).not.toContain("Loading run tree…");
	});

	it("never lets an older, slower build overwrite a newer one", async () => {
		const { view, gate, release, text } = setup();
		await view.onOpen();
		gate.blocked = true;
		await view.setState({ rootSessionId: "sess-1" }, {} as never); // blocked scan for sess-1
		gate.blocked = false;
		await view.setState({ rootSessionId: "sess-2" }, {} as never); // fast scan for sess-2
		await flush();
		expect(text()).toContain("Step two");

		release(); // the stale sess-1 build finishes last
		await flush();
		expect(text()).toContain("Step two");
		expect(text()).not.toContain("Step one");
	});

	it("coalesces live updates into one rebuild per interval", async () => {
		const { view, list, fire } = setup();
		await view.onOpen();
		await view.setState({ rootSessionId: "sess-1" }, {} as never);
		await flush();
		const before = list.mock.calls.length;

		for (let i = 0; i < 5; i++) fire();
		await flush();
		expect(list.mock.calls.length).toBe(before);

		await vi.advanceTimersByTimeAsync(LIVE_REBUILD_INTERVAL_MS);
		await flush();
		expect(list.mock.calls.length).toBe(before + 1);
	});

	it("defers live rebuilds while hidden and rebuilds once when shown again", async () => {
		const { view, list, fire, shown } = setup();
		await view.onOpen();
		await view.setState({ rootSessionId: "sess-1" }, {} as never);
		await flush();
		const before = list.mock.calls.length;

		shown.value = false;
		fire();
		fire();
		await vi.advanceTimersByTimeAsync(LIVE_REBUILD_INTERVAL_MS * 3);
		expect(list.mock.calls.length).toBe(before);

		shown.value = true;
		view.onResize();
		view.onResize();
		await flush();
		expect(list.mock.calls.length).toBe(before + 1);
	});
});
