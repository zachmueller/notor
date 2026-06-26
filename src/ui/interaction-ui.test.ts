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
	proto.toggleClass = function (this: HTMLElement, cls: string, on: boolean) {
		this.classList.toggle(cls, on);
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

	it("highlights the free-text input as active while it holds the chosen answer", async () => {
		const card = makeCard();
		renderInteractionPrompt(card, {
			type: "ask",
			id: "qa",
			questions: [{ question: "One?", suggestions: ["Alpha", "Beta"] }],
		});

		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		input.value = "hi";
		input.dispatchEvent(new Event("input"));
		expect(input.classList.contains("notor-interaction-input--active")).toBe(true);
		expect(input.classList.contains("notor-interaction-input--inactive")).toBe(false);
	});

	it("retains typed text but greys it out (inactive) when an option is selected", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "qb2",
			questions: [{ question: "One?", suggestions: ["Alpha", "Beta"] }],
		});

		const options = card.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;

		// Type, then select an option: the text is retained (not wiped) and greyed.
		input.value = "typed";
		input.dispatchEvent(new Event("input"));
		options[0]!.click();
		expect(input.value).toBe("typed"); // not erased
		expect(input.classList.contains("notor-interaction-input--inactive")).toBe(true);
		expect(input.classList.contains("notor-interaction-input--active")).toBe(false);
		expect(options[0]!.classList.contains("notor-interaction-option--selected")).toBe(true);

		// Submitting sends the option, not the greyed text.
		card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!.click();
		await expect(promise).resolves.toEqual({ id: "qb2", values: ["Alpha"] });
	});

	it("re-activates the input and clears the option when typing resumes", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "qc",
			questions: [{ question: "One?", suggestions: ["Alpha", "Beta"] }],
		});

		const options = card.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;

		input.value = "typed";
		input.dispatchEvent(new Event("input"));
		options[0]!.click(); // greys the input
		input.value = "typed more";
		input.dispatchEvent(new Event("input")); // re-activates

		expect(options[0]!.classList.contains("notor-interaction-option--selected")).toBe(false);
		expect(input.classList.contains("notor-interaction-input--active")).toBe(true);
		expect(input.classList.contains("notor-interaction-input--inactive")).toBe(false);

		card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!.click();
		await expect(promise).resolves.toEqual({ id: "qc", values: ["typed more"] });
	});

	it("Enter submits the selected option, not the retained greyed text", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "qd",
			questions: [{ question: "One?", suggestions: ["Alpha", "Beta"] }],
		});

		const options = card.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		input.value = "typed";
		input.dispatchEvent(new Event("input"));
		options[1]!.click(); // Beta selected; "typed" retained but inactive
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

		await expect(promise).resolves.toEqual({ id: "qd", values: ["Beta"] });
	});

	it("clears both input-state classes when the field is emptied", async () => {
		const card = makeCard();
		renderInteractionPrompt(card, {
			type: "ask",
			id: "qe",
			questions: [{ question: "One?", suggestions: ["Alpha"] }],
		});

		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		input.value = "typed";
		input.dispatchEvent(new Event("input"));
		expect(input.classList.contains("notor-interaction-input--active")).toBe(true);
		input.value = "";
		input.dispatchEvent(new Event("input"));
		expect(input.classList.contains("notor-interaction-input--active")).toBe(false);
		expect(input.classList.contains("notor-interaction-input--inactive")).toBe(false);
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

describe("renderInteractionPrompt — ask (multi-select)", () => {
	it("tags only multi-select question groups with the --multi modifier class", async () => {
		const card = makeCard();
		renderInteractionPrompt(card, {
			type: "ask",
			id: "mg",
			questions: [
				{ question: "Single?", suggestions: ["A", "B"] },
				{ question: "Multi?", suggestions: ["C", "D"], multiSelect: true },
			],
		});

		const groups = card.querySelectorAll<HTMLDivElement>(".notor-interaction-question-group");
		// The stylesheet keys checkbox vs radio glyphs off this class, so the
		// single-select group must stay clean and only the multi-select group tagged.
		expect(groups[0]!.classList.contains("notor-interaction-question-group--multi")).toBe(false);
		expect(groups[1]!.classList.contains("notor-interaction-question-group--multi")).toBe(true);
	});

	it("accumulates checked options as an array in click order", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "m1",
			questions: [
				{ question: "Pick several?", suggestions: ["A", "B", "C"], multiSelect: true },
			],
		});

		const options = card.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		options[0]!.click(); // A
		options[2]!.click(); // C
		expect(options[0]!.classList.contains("notor-interaction-option--checked")).toBe(true);
		expect(options[1]!.classList.contains("notor-interaction-option--checked")).toBe(false);
		expect(options[2]!.classList.contains("notor-interaction-option--checked")).toBe(true);
		// Multi-select uses --checked, not the single-select --selected.
		expect(options[0]!.classList.contains("notor-interaction-option--selected")).toBe(false);

		const submit = card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!;
		submit.click();
		const response = await promise;
		expect(response).toEqual({ id: "m1", values: [["A", "C"]] });
		expect(Array.isArray(response.values[0])).toBe(true);
	});

	it("toggles an option off on second click", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "m2",
			questions: [{ question: "Toggle?", suggestions: ["A", "B"], multiSelect: true }],
		});

		const options = card.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		options[0]!.click(); // on
		options[1]!.click(); // on
		options[0]!.click(); // off
		expect(options[0]!.classList.contains("notor-interaction-option--checked")).toBe(false);
		expect(options[1]!.classList.contains("notor-interaction-option--checked")).toBe(true);

		card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!.click();
		await expect(promise).resolves.toEqual({ id: "m2", values: [["B"]] });
	});

	it("appends free text as a trailing selection after the checked options", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "m3",
			questions: [{ question: "Pick + note?", suggestions: ["A", "B"], multiSelect: true }],
		});

		const options = card.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		options[0]!.click(); // A
		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		input.value = "extra";
		input.dispatchEvent(new Event("input"));

		// Checking an option does NOT clear the free text in multi-select mode.
		expect(input.value).toBe("extra");
		expect(options[0]!.classList.contains("notor-interaction-option--checked")).toBe(true);

		card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!.click();
		await expect(promise).resolves.toEqual({ id: "m3", values: [["A", "extra"]] });
	});

	it("drops the free-text element when the input is cleared", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "m3b",
			questions: [{ question: "Pick + note?", suggestions: ["A", "B"], multiSelect: true }],
		});

		const options = card.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		options[0]!.click(); // A
		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		input.value = "extra";
		input.dispatchEvent(new Event("input"));
		// Clear the free text back to empty — the trailing element is dropped.
		input.value = "";
		input.dispatchEvent(new Event("input"));

		card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!.click();
		await expect(promise).resolves.toEqual({ id: "m3b", values: [["A"]] });
	});

	it("dedupes free text that matches an already-checked option", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "m4",
			questions: [{ question: "Dedupe?", suggestions: ["Alpha", "Beta"], multiSelect: true }],
		});

		const options = card.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		options[0]!.click(); // Alpha
		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		input.value = "Alpha";
		input.dispatchEvent(new Event("input"));

		card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!.click();
		await expect(promise).resolves.toEqual({ id: "m4", values: [["Alpha"]] });
	});

	it("keeps Submit disabled until at least one selection, then enables", async () => {
		const card = makeCard();
		let settled = false;
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "m5",
			questions: [{ question: "Need one?", suggestions: ["A", "B"], multiSelect: true }],
		}).then((r) => {
			settled = true;
			return r;
		});

		const submit = card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!;
		expect(submit.disabled).toBe(true);
		await Promise.resolve();
		expect(settled).toBe(false);

		const options = card.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		options[0]!.click();
		expect(submit.disabled).toBe(false);

		// Toggling the only selection back off re-disables Submit.
		options[0]!.click();
		expect(submit.disabled).toBe(true);
		options[1]!.click();
		expect(submit.disabled).toBe(false);

		submit.click();
		await expect(promise).resolves.toEqual({ id: "m5", values: [["B"]] });
	});

	it("supports free-text-only multi-select (no options checked)", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "m6",
			questions: [{ question: "Type only?", suggestions: ["A", "B"], multiSelect: true }],
		});

		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		input.value = "typed";
		input.dispatchEvent(new Event("input"));
		card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!.click();
		await expect(promise).resolves.toEqual({ id: "m6", values: [["typed"]] });
	});

	it("multi-select with no suggestions returns an array-wrapped free-text answer", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "m7",
			questions: [{ question: "No options?", multiSelect: true }],
		});

		expect(card.querySelectorAll(".notor-interaction-option")).toHaveLength(0);
		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		input.value = "  free  ";
		input.dispatchEvent(new Event("input"));
		card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!.click();
		await expect(promise).resolves.toEqual({ id: "m7", values: [["free"]] });
	});

	it("mixes single-select, multi-select, and free-text questions in one prompt", async () => {
		const card = makeCard();
		const promise = renderInteractionPrompt(card, {
			type: "ask",
			id: "mix",
			questions: [
				{ question: "Single?", suggestions: ["s0", "s1"] },
				{ question: "Many?", suggestions: ["m1a", "m1b", "m1c"], multiSelect: true },
				{ question: "Notes?" },
			],
		});

		const groups = card.querySelectorAll(".notor-interaction-question-group");
		const q0 = groups[0]!.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		q0[0]!.click(); // single → "s0"

		const q1 = groups[1]!.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		q1[0]!.click(); // m1a
		q1[1]!.click(); // m1b

		const q2Input = groups[2]!.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		q2Input.value = "f2";
		q2Input.dispatchEvent(new Event("input"));

		card.querySelector<HTMLButtonElement>(".notor-interaction-submit")!.click();
		await expect(promise).resolves.toEqual({
			id: "mix",
			values: ["s0", ["m1a", "m1b"], "f2"],
		});
	});

	it("marks multi-select free text active but never inactive", async () => {
		const card = makeCard();
		renderInteractionPrompt(card, {
			type: "ask",
			id: "m8",
			questions: [{ question: "Pick + note?", suggestions: ["A", "B"], multiSelect: true }],
		});

		const options = card.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		const input = card.querySelector<HTMLInputElement>(".notor-interaction-input")!;

		input.value = "extra";
		input.dispatchEvent(new Event("input"));
		expect(input.classList.contains("notor-interaction-input--active")).toBe(true);
		expect(input.classList.contains("notor-interaction-input--inactive")).toBe(false);

		// Checking an option leaves the text an active selection — still --active.
		options[0]!.click();
		expect(input.classList.contains("notor-interaction-input--active")).toBe(true);
		expect(input.classList.contains("notor-interaction-input--inactive")).toBe(false);

		// Clearing the field removes the active highlight.
		input.value = "";
		input.dispatchEvent(new Event("input"));
		expect(input.classList.contains("notor-interaction-input--active")).toBe(false);
		expect(input.classList.contains("notor-interaction-input--inactive")).toBe(false);
	});
});
