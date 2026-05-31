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
			 * visible and editable until every one is answered, then the prompt
			 * auto-submits with one response. A single-question array auto-submits
			 * on its first answer.
			 */
			questions: Array<{
				/** The question text shown to the user. */
				question: string;
				/** Optional suggested answers, rendered as clickable chips. */
				suggestions?: string[];
				/** When true (default), a free-text input is offered alongside chips. */
				allowFreeText?: boolean;
			}>;
	  };

/** The user's answers to an `InteractionRequest`. */
export type InteractionResponse = {
	/** Matches the `id` of the originating request. */
	id: string;
	/** The answers, index-aligned with `request.questions`. */
	values: string[];
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
 * with its text, optional suggestion chips, and optional free-text input — and
 * keeps them all visible and editable. Answering a question marks it (chip gets
 * `--chosen`); the user can change earlier answers freely. Once every question
 * is answered the prompt auto-submits with one response. A single-question set
 * therefore submits on its first answer.
 */
const askRenderer: InteractionRenderer = {
	render(el, request, resolve) {
		if (request.type !== "ask") {
			// Defensive — registry dispatch guarantees the type.
			resolve({ id: request.id, values: [] });
			return () => {};
		}

		const questions = request.questions;
		const values: string[] = new Array(questions.length).fill("");
		const answered: boolean[] = new Array(questions.length).fill(false);

		const promptEl = el.createDiv({ cls: "notor-interaction-prompt" });

		// Resolve only once all questions have a committed answer.
		const maybeSubmit = () => {
			if (answered.every(Boolean)) {
				resolve({ id: request.id, values: values.slice() });
			}
		};

		let firstInput: HTMLInputElement | null = null;

		questions.forEach((q, i) => {
			const group = promptEl.createDiv({ cls: "notor-interaction-question-group" });
			group.createSpan({ cls: "notor-interaction-question", text: q.question });

			const allowFreeText = q.allowFreeText !== false;
			let chipEls: HTMLButtonElement[] = [];
			let input: HTMLInputElement | null = null;

			const clearChosen = () => {
				for (const c of chipEls) c.removeClass("notor-interaction-chip--chosen");
			};

			// Suggested-answer chips
			if (q.suggestions && q.suggestions.length > 0) {
				const chipsEl = group.createDiv({ cls: "notor-interaction-chips" });
				for (const suggestion of q.suggestions) {
					const chip = chipsEl.createEl("button", {
						cls: "notor-interaction-chip",
						text: suggestion,
					});
					chip.addEventListener("click", () => {
						values[i] = suggestion;
						answered[i] = true;
						clearChosen();
						chip.addClass("notor-interaction-chip--chosen");
						if (input) input.value = "";
						maybeSubmit();
					});
					chipEls.push(chip);
				}
			}

			// Free-text input — commits on Enter or blur (non-empty). Typing alone
			// updates the value but does not mark the question answered, so a set
			// never auto-submits mid-keystroke.
			if (allowFreeText) {
				const inputRow = group.createDiv({ cls: "notor-interaction-input-row" });
				input = inputRow.createEl("input", {
					cls: "notor-interaction-input",
					type: "text",
				});
				input.placeholder = "Type your answer…";
				if (!firstInput) firstInput = input;

				const commit = () => {
					const value = input!.value.trim();
					if (value.length === 0) return;
					values[i] = value;
					answered[i] = true;
					clearChosen();
					maybeSubmit();
				};

				input.addEventListener("input", () => {
					// Live-track the typed value without committing (Enter/blur commits).
					values[i] = input!.value.trim();
				});
				input.addEventListener("keydown", (e: KeyboardEvent) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
					}
				});
				input.addEventListener("blur", commit);
			}
		});

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
