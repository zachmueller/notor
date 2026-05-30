// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { renderInteractionPrompt, type InteractionRequest } from "./interaction-ui";

// ---------------------------------------------------------------------------
// Minimal polyfill for Obsidian's HTMLElement DOM-builder extensions.
// (createDiv / createEl / createSpan) — enough to exercise the renderer.
// ---------------------------------------------------------------------------
beforeAll(() => {
	type CreateOpts = { cls?: string; text?: string; type?: string };
	function createEl(this: HTMLElement, tag: string, opts?: CreateOpts): HTMLElement {
		const el = document.createElement(tag);
		if (opts?.cls) el.className = opts.cls;
		if (opts?.text) el.textContent = opts.text;
		if (opts?.type) el.setAttribute("type", opts.type);
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
});

function makeCard(): HTMLElement {
	const el = document.createElement("div");
	document.body.appendChild(el);
	return el;
}

describe("renderInteractionPrompt — ask", () => {
	it("resolves with the clicked suggestion chip", async () => {
		const card = makeCard();
		const request: InteractionRequest = {
			type: "ask",
			id: "q1",
			question: "Pick one?",
			suggestions: ["Alpha", "Beta"],
		};
		const promise = renderInteractionPrompt(card, request);

		const chips = card.querySelectorAll<HTMLButtonElement>(".notor-interaction-chip");
		expect(chips).toHaveLength(2);
		chips[1]!.click();

		const response = await promise;
		expect(response).toEqual({ id: "q1", value: "Beta" });
		// Prompt removed itself on resolve.
		expect(card.querySelector(".notor-interaction-prompt")).toBeNull();
	});

	it("resolves with free-text input on submit click", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "q2",
			question: "Free answer?",
		});

		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		expect(input).not.toBeNull();
		input.value = "  my answer  ";
		card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!.click();

		const response = await promise;
		expect(response).toEqual({ id: "q2", value: "my answer" });
	});

	it("ignores empty free-text submissions", async () => {
		const card = makeCard();
		let settled = false;
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "q3",
			question: "Answer?",
		}).then((r) => {
			settled = true;
			return r;
		});

		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		input.value = "   ";
		card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!.click();

		// Give microtasks a chance; promise must still be pending.
		await Promise.resolve();
		expect(settled).toBe(false);

		// A real answer resolves it.
		input.value = "real";
		card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!.click();
		await expect(promise).resolves.toEqual({ id: "q3", value: "real" });
	});

	it("hides the free-text input when allowFreeText is false", () => {
		const card = makeCard();
		void renderInteractionPrompt(card, {
			type: "ask",
			id: "q4",
			question: "Chips only?",
			suggestions: ["Yes"],
			allowFreeText: false,
		});
		expect(card.querySelector(".notor-interaction-input")).toBeNull();
		expect(card.querySelectorAll(".notor-interaction-chip")).toHaveLength(1);
	});

	it("rejects and cleans up when aborted while pending", async () => {
		const card = makeCard();
		const controller = new AbortController();
		const promise = renderInteractionPrompt(
			card,
			{ type: "ask", id: "q5", question: "Waiting?" },
			controller.signal,
		);
		controller.abort();
		await expect(promise).rejects.toThrow("Interaction cancelled by user.");
		expect(card.querySelector(".notor-interaction-prompt")).toBeNull();
	});

	it("rejects immediately if the abort signal is already aborted", async () => {
		const card = makeCard();
		const controller = new AbortController();
		controller.abort();
		await expect(
			renderInteractionPrompt(
				card,
				{ type: "ask", id: "q6", question: "Already aborted?" },
				controller.signal,
			),
		).rejects.toThrow("Interaction cancelled by user.");
	});
});
