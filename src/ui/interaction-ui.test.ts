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

describe("renderInteractionPrompt — ask (grouped, explicit submit)", () => {
	it("requires an explicit Submit after selecting a single-question option", async () => {
		const card = makeCard();
		let settled = false;
		const request: InteractionRequest = {
			type: "ask",
			id: "q1",
			questions: [{ question: "Pick one?", suggestions: ["Alpha", "Beta"] }],
		};
		const promise = renderInteractionPrompt(card, request).then((r) => {
			settled = true;
			return r;
		});

		// Submit exists and is disabled before any answer.
		const submit = card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!;
		expect(submit).not.toBeNull();
		expect(submit.disabled).toBe(true);

		const options = card.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		expect(options).toHaveLength(2);
		options[1]!.click();

		// Selecting alone does not submit; it enables Submit.
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(card.querySelector(".notor-interaction-prompt")).not.toBeNull();
		expect(options[1]!.classList.contains("notor-interaction-option--selected")).toBe(true);
		expect(submit.disabled).toBe(false);

		submit.click();
		const response = await promise;
		expect(response).toEqual({ id: "q1", values: ["Beta"] });
		// Prompt removed itself on resolve.
		expect(card.querySelector(".notor-interaction-prompt")).toBeNull();
	});

	it("keeps Submit disabled until every question is answered, then submits", async () => {
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
		const submit = card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!;
		expect(submit.disabled).toBe(true);

		// Answer Q1 — Submit stays disabled (Q2 still unanswered).
		const q1Options = groups[0]!.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		q1Options[1]!.click(); // Green
		expect(q1Options[1]!.classList.contains("notor-interaction-option--selected")).toBe(true);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(submit.disabled).toBe(true);

		// Re-select Q1 → highlight moves, still not complete.
		q1Options[2]!.click(); // Blue
		expect(q1Options[1]!.classList.contains("notor-interaction-option--selected")).toBe(false);
		expect(q1Options[2]!.classList.contains("notor-interaction-option--selected")).toBe(true);
		expect(submit.disabled).toBe(true);

		// Answer Q2 via free text → now all answered → Submit enables.
		const q2Input = groups[1]!.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		q2Input.value = "  some note  ";
		q2Input.dispatchEvent(new Event("input"));
		expect(submit.disabled).toBe(false);
		expect(settled).toBe(false);

		submit.click();
		const response = await promise;
		expect(response).toEqual({ id: "qb", values: ["Blue", "some note"] });
		expect(card.querySelector(".notor-interaction-prompt")).toBeNull();
	});

	it("submits free text on Enter when the prompt is complete", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "q2",
			questions: [{ question: "Free answer?" }],
		});

		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		expect(input).not.toBeNull();
		input.value = "  my answer  ";
		input.dispatchEvent(new Event("input"));
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

		const response = await promise;
		expect(response).toEqual({ id: "q2", values: ["my answer"] });
	});

	it("keeps Submit disabled for empty free text and enables once non-empty", async () => {
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
		const submit = card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!;
		input.value = "   ";
		input.dispatchEvent(new Event("input"));
		expect(submit.disabled).toBe(true);

		// Enter on an incomplete prompt is a no-op.
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		await Promise.resolve();
		expect(settled).toBe(false);

		input.value = "real";
		input.dispatchEvent(new Event("input"));
		expect(submit.disabled).toBe(false);
		submit.click();
		await expect(promise).resolves.toEqual({ id: "q3", values: ["real"] });
	});

	it("typing free text clears a selected option for that question", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "q7",
			questions: [{ question: "One?", suggestions: ["Alpha", "Beta"] }],
		});

		const options = card.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		options[0]!.click();
		expect(options[0]!.classList.contains("notor-interaction-option--selected")).toBe(true);

		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		input.value = "typed instead";
		input.dispatchEvent(new Event("input"));
		expect(options[0]!.classList.contains("notor-interaction-option--selected")).toBe(false);

		const submit = card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!;
		submit.click();
		await expect(promise).resolves.toEqual({ id: "q7", values: ["typed instead"] });
	});

	it("hides the free-text input when allowFreeText is false and gates Submit on selection", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "q4",
			questions: [{ question: "Options only?", suggestions: ["Yes"], allowFreeText: false }],
		});
		expect(card.querySelector(".notor-interaction-input")).toBeNull();
		const options = card.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		expect(options).toHaveLength(1);

		const submit = card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!;
		expect(submit.disabled).toBe(true);
		options[0]!.click();
		expect(submit.disabled).toBe(false);
		submit.click();
		await expect(promise).resolves.toEqual({ id: "q4", values: ["Yes"] });
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
