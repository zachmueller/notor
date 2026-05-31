// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { renderInteractionPrompt, type InteractionRequest } from "./interaction-ui";

// ---------------------------------------------------------------------------
// Minimal polyfill for Obsidian's HTMLElement DOM-builder extensions.
// (createDiv / createEl / createSpan / addClass / removeClass) — enough to
// exercise the renderer.
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
	proto.addClass = function (this: HTMLElement, cls: string) {
		this.classList.add(cls);
	};
	proto.removeClass = function (this: HTMLElement, cls: string) {
		this.classList.remove(cls);
	};
});

function makeCard(): HTMLElement {
	const el = document.createElement("div");
	document.body.appendChild(el);
	return el;
}

describe("renderInteractionPrompt — ask (grouped, auto-submit)", () => {
	it("auto-submits a single-question set on the first chip click", async () => {
		const card = makeCard();
		const request: InteractionRequest = {
			type: "ask",
			id: "q1",
			questions: [{ question: "Pick one?", suggestions: ["Alpha", "Beta"] }],
		};
		const promise = renderInteractionPrompt(card, request);

		const chips = card.querySelectorAll<HTMLButtonElement>(".notor-interaction-chip");
		expect(chips).toHaveLength(2);
		chips[1]!.click();

		const response = await promise;
		expect(response).toEqual({ id: "q1", values: ["Beta"] });
		// Prompt removed itself on resolve.
		expect(card.querySelector(".notor-interaction-prompt")).toBeNull();
	});

	it("keeps all questions visible until every one is answered, then submits", async () => {
		const card = makeCard();
		let settled = false;
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "qb",
			questions: [
				{ question: "Color?", suggestions: ["Red", "Green", "Blue"] },
				{ question: "Notes?" },
			],
		}).then((r) => {
			settled = true;
			return r;
		});

		const groups = card.querySelectorAll(".notor-interaction-question-group");
		expect(groups).toHaveLength(2);

		// Answer Q1 — prompt should remain (Q2 still unanswered).
		const q1Chips = groups[0]!.querySelectorAll<HTMLButtonElement>(".notor-interaction-chip");
		q1Chips[1]!.click(); // Green
		expect(q1Chips[1]!.classList.contains("notor-interaction-chip--chosen")).toBe(true);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(card.querySelector(".notor-interaction-prompt")).not.toBeNull();

		// Re-select Q1 → highlight moves, still not submitted.
		q1Chips[2]!.click(); // Blue
		expect(q1Chips[1]!.classList.contains("notor-interaction-chip--chosen")).toBe(false);
		expect(q1Chips[2]!.classList.contains("notor-interaction-chip--chosen")).toBe(true);
		await Promise.resolve();
		expect(settled).toBe(false);

		// Answer Q2 via free text → now all answered → auto-submit.
		const q2Input = groups[1]!.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		q2Input.value = "  some note  ";
		q2Input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

		const response = await promise;
		expect(response).toEqual({ id: "qb", values: ["Blue", "some note"] });
		expect(card.querySelector(".notor-interaction-prompt")).toBeNull();
	});

	it("commits free text on blur", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "q2",
			questions: [{ question: "Free answer?" }],
		});

		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		expect(input).not.toBeNull();
		input.value = "  my answer  ";
		input.dispatchEvent(new FocusEvent("blur"));

		const response = await promise;
		expect(response).toEqual({ id: "q2", values: ["my answer"] });
	});

	it("does not commit an empty free-text answer", async () => {
		const card = makeCard();
		let settled = false;
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "q3",
			questions: [{ question: "Answer?" }],
		}).then((r) => {
			settled = true;
			return r;
		});

		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		input.value = "   ";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

		await Promise.resolve();
		expect(settled).toBe(false);

		input.value = "real";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		await expect(promise).resolves.toEqual({ id: "q3", values: ["real"] });
	});

	it("hides the free-text input when allowFreeText is false", () => {
		const card = makeCard();
		void renderInteractionPrompt(card, {
			type: "ask",
			id: "q4",
			questions: [{ question: "Chips only?", suggestions: ["Yes"], allowFreeText: false }],
		});
		expect(card.querySelector(".notor-interaction-input")).toBeNull();
		expect(card.querySelectorAll(".notor-interaction-chip")).toHaveLength(1);
	});

	it("rejects and cleans up when aborted while pending", async () => {
		const card = makeCard();
		const controller = new AbortController();
		const promise = renderInteractionPrompt(
			card,
			{ type: "ask", id: "q5", questions: [{ question: "Waiting?" }] },
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
				{ type: "ask", id: "q6", questions: [{ question: "Already aborted?" }] },
				controller.signal,
			),
		).rejects.toThrow("Interaction cancelled by user.");
	});
});
