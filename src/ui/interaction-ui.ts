/**
 * Interaction UI — inline user-interaction prompts for the tool loop.
 *
 * Generalizes the approve/reject pattern in `approval-ui.ts` into a
 * customizable interaction-primitive framework. The AI (via the built-in
 * `ask_user` tool) or extension code (via `utils.ask`) can suspend the tool
 * loop and render a question with suggested-answer chips and/or a free-text
 * input, then resume with the user's answer as the tool result.
 *
 * The framework is a discriminated union of `InteractionRequest` types plus an
 * internal renderer registry keyed by `type`. Only the built-in `ask` type
 * ships today; new types are a localized addition to `INTERACTION_RENDERERS`.
 * Registration is intentionally NOT exposed to user extensions yet — that
 * public API (and an opt-in auto-answer seam) is deferred to a later PR.
 *
 * @see ai/notor/ideas — "Ask follow-up question tool with customizable user
 *   interaction primitives"
 * @see src/ui/approval-ui.ts — the binary approve/reject pattern this generalizes
 */

/**
 * A request to interact with the user, suspending the tool loop until answered.
 *
 * Discriminated on `type`. New interaction kinds (confirm, choose, form, …) add
 * a member here plus a matching entry in `INTERACTION_RENDERERS`.
 */
export type InteractionRequest =
	| {
			type: "ask";
			/** Stable id used to correlate the response. */
			id: string;
			/**
			 * The questions to ask, rendered together as one prompt. All stay
			 * visible and editable; each is answered by selecting a suggested option
			 * or typing free text. A single Submit button at the bottom is enabled
			 * only once every question has an answer, and submits all answers as one
			 * response. Nothing auto-submits — even a single-question prompt requires
			 * an explicit Submit.
			 */
			questions: Array<{
				/** The question text shown to the user. */
				question: string;
				/** Optional suggested answers, rendered as full-width clickable options. */
				suggestions?: string[];
				/** When true (default), a free-text input is offered alongside chips. */
				allowFreeText?: boolean;
				/**
				 * When true, options render as checkboxes: the user can select several
				 * at once and free text is appended as an additional selection rather
				 * than being mutually exclusive with the options. Default false
				 * (single-select, radio-style).
				 */
				multiSelect?: boolean;
			}>;
	  };

/** The user's answers to an `InteractionRequest`. */
export type InteractionResponse = {
	/** Matches the `id` of the originating request. */
	id: string;
	/**
	 * The answers, index-aligned with `request.questions`. A single-select
	 * question yields a `string`; a `multiSelect` question yields a `string[]`.
	 */
	values: Array<string | string[]>;
};

/**
 * A renderer for one interaction `type`. Appends UI into the tool-call card,
 * resolves with the user's response, and returns a cleanup function that
 * removes the UI (called automatically on resolve and on abort).
 */
interface InteractionRenderer {
	render(
		el: HTMLElement,
		request: InteractionRequest,
		resolve: (response: InteractionResponse) => void,
	): () => void;
}

/**
 * Built-in `ask` renderer: renders every question in the set together — each
 * with its text, optional suggested-answer options (full-width stacked buttons),
 * and optional free-text input — and keeps them all visible and editable.
 *
 * Single-select (default): selecting an option marks it (`--selected`) and clears
 * that question's free text; typing free text clears that question's selected
 * option. The answer is a single string.
 *
 * Multi-select (`multiSelect: true`): options toggle as checkboxes (`--checked`)
 * and accumulate; free text is appended as an additional selection rather than
 * clearing the options. The answer is a `string[]`.
 *
 * A single Submit button at the bottom stays disabled until every question has a
 * non-empty answer, then resolves with all answers. Pressing Enter in a free-text
 * field submits the whole prompt when it is complete.
 */
const askRenderer: InteractionRenderer = {
	render(el, request, resolve) {
		if (request.type !== "ask") {
			// Defensive — registry dispatch guarantees the type.
			resolve({ id: request.id, values: [] });
			return () => {};
		}

		const questions = request.questions;
		// Single-select questions hold a string; multi-select hold a string[].
		const values: Array<string | string[]> = questions.map((q) =>
			q.multiSelect === true ? [] : "",
		);
		// A question is "required" if it offers any way to answer it (options or
		// free text). A question with neither can never be answered, so it must not
		// gate Submit — otherwise the prompt would deadlock. The shipped `ask_user`
		// tool always sets allowFreeText, so this only guards extension-built asks.
		const required: boolean[] = questions.map(
			(q) => (q.suggestions?.length ?? 0) > 0 || q.allowFreeText !== false,
		);

		const promptEl = el.createDiv({ cls: "notor-interaction-prompt" });

		// A question is answered iff it has a non-empty value. `values` is the single
		// source of truth — option clicks and typing both write to it. Multi-select
		// answers are arrays (≥1 selection); single-select answers are non-empty
		// trimmed strings.
		const isComplete = () =>
			values.every((v, i) =>
				!required[i] || (Array.isArray(v) ? v.length > 0 : v.trim().length > 0),
			);

		let submitBtn: HTMLButtonElement;

		// Reflect completeness on the Submit button. Recomputed on every mutation.
		const refreshSubmit = () => {
			const disabled = !isComplete();
			submitBtn.disabled = disabled;
			submitBtn.classList.toggle("notor-interaction-submit--disabled", disabled);
		};

		// Resolve with all answers — only when every question is answered. Deep-copy
		// multi-select arrays so the resolved response never aliases the live
		// per-question state captured in the closures below.
		const submit = () => {
			if (!isComplete()) return;
			resolve({
				id: request.id,
				values: values.map((v) => (Array.isArray(v) ? v.slice() : v)),
			});
		};

		let firstInput: HTMLInputElement | null = null;

		questions.forEach((q, i) => {
			const group = promptEl.createDiv({ cls: "notor-interaction-question-group" });
			group.createSpan({ cls: "notor-interaction-question", text: q.question });

			const allowFreeText = q.allowFreeText !== false;
			const multiSelect = q.multiSelect === true;
			const options: HTMLButtonElement[] = [];
			let input: HTMLInputElement | null = null;

			const clearSelected = () => {
				for (const o of options) o.removeClass("notor-interaction-option--selected");
			};

			// Multi-select state: the checked option set is the membership truth.
			// `values[i]` is recomputed from it (plus any free text) on every change.
			const checked = new Set<string>();
			const recomputeMulti = () => {
				const ft = input ? input.value.trim() : "";
				const selected = [...checked]; // preserves option-click order
				// Append free text as a trailing selection, deduped against options.
				values[i] = ft && !checked.has(ft) ? [...selected, ft] : selected;
			};

			// Suggested-answer options — full-width stacked buttons.
			if (q.suggestions && q.suggestions.length > 0) {
				const optionsEl = group.createDiv({ cls: "notor-interaction-options" });
				for (const suggestion of q.suggestions) {
					const opt = optionsEl.createEl("button", {
						cls: "notor-interaction-option",
						text: suggestion,
					});
					if (multiSelect) {
						// Toggle membership; accumulate. Does not touch free text.
						opt.addEventListener("click", () => {
							if (checked.has(suggestion)) {
								checked.delete(suggestion);
								opt.removeClass("notor-interaction-option--checked");
							} else {
								checked.add(suggestion);
								opt.addClass("notor-interaction-option--checked");
							}
							recomputeMulti();
							refreshSubmit();
						});
					} else {
						// Single-select: clicking selects exactly one and clears free text.
						opt.addEventListener("click", () => {
							values[i] = suggestion;
							clearSelected();
							opt.addClass("notor-interaction-option--selected");
							if (input) input.value = "";
							refreshSubmit();
						});
					}
					options.push(opt);
				}
			}

			// Free-text input — typing live-tracks the value (no commit step). In
			// single-select a non-empty entry clears the selected option (mutually
			// exclusive); in multi-select it is appended as an extra selection.
			if (allowFreeText) {
				const inputRow = group.createDiv({ cls: "notor-interaction-input-row" });
				input = inputRow.createEl("input", {
					cls: "notor-interaction-input",
					type: "text",
				});
				input.placeholder = "Type your answer…";
				if (!firstInput) firstInput = input;

				input.addEventListener("input", () => {
					if (multiSelect) {
						recomputeMulti();
					} else {
						const v = input!.value.trim();
						values[i] = v;
						if (v.length > 0) clearSelected();
					}
					refreshSubmit();
				});
				input.addEventListener("keydown", (e: KeyboardEvent) => {
					// Enter submits the whole prompt, but only when it's complete.
					if (e.key === "Enter") {
						e.preventDefault();
						submit();
					}
				});
			}
		});

		// Single Submit for the whole prompt, disabled until every question is answered.
		submitBtn = promptEl.createEl("button", {
			cls: "notor-interaction-submit",
			text: "Submit",
		});
		submitBtn.addEventListener("click", submit);
		refreshSubmit();

		// Focus the first input so the user can type immediately.
		if (firstInput) window.setTimeout(() => firstInput!.focus(), 0);

		return () => promptEl.remove();
	},
};

/**
 * Internal registry mapping each interaction `type` to its renderer.
 *
 * Module-internal by design — the extensibility seam exists (adding a type is
 * a one-line change) but registration is not yet exposed to user extensions.
 */
const INTERACTION_RENDERERS: Record<InteractionRequest["type"], InteractionRenderer> = {
	ask: askRenderer,
};

/**
 * Render an interaction prompt inside a tool-call card and await the response.
 *
 * Resolves when the user answers. The prompt removes itself from the DOM on
 * resolve. Aborting via `abortSignal` rejects the promise so the tool loop can
 * unwind cleanly — mirroring the approval UI's abort behavior.
 *
 * @param toolCallEl - The tool-call card element to append the prompt into
 * @param request - The interaction to render
 * @param abortSignal - Optional signal; aborting rejects the returned promise
 * @returns Promise resolving to the user's response
 */
export function renderInteractionPrompt(
	toolCallEl: HTMLElement,
	request: InteractionRequest,
	abortSignal?: AbortSignal,
): Promise<InteractionResponse> {
	const renderer = INTERACTION_RENDERERS[request.type];
	return new Promise<InteractionResponse>((resolve, reject) => {
		let settled = false;
		let cleanup = () => {};

		const finish = (response: InteractionResponse) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(response);
		};

		cleanup = renderer.render(toolCallEl, request, finish);

		if (abortSignal) {
			if (abortSignal.aborted) {
				settled = true;
				cleanup();
				reject(new Error("Interaction cancelled by user."));
				return;
			}
			abortSignal.addEventListener(
				"abort",
				() => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(new Error("Interaction cancelled by user."));
				},
				{ once: true },
			);
		}
	});
}
