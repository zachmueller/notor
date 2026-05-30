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
			/** Stable id used to correlate the response (one per question). */
			id: string;
			/** The question text shown to the user. */
			question: string;
			/** Optional suggested answers, rendered as clickable chips. */
			suggestions?: string[];
			/** When true (default), a free-text input is offered alongside chips. */
			allowFreeText?: boolean;
	  };

/** The user's answer to a single `InteractionRequest`. */
export type InteractionResponse = {
	/** Matches the `id` of the originating request. */
	id: string;
	/** The user's answer — a chosen suggestion or free-text input. */
	value: string;
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

/** Built-in `ask` renderer: question text, suggestion chips, optional free-text. */
const askRenderer: InteractionRenderer = {
	render(el, request, resolve) {
		if (request.type !== "ask") {
			// Defensive — registry dispatch guarantees the type.
			resolve({ id: request.id, value: "" });
			return () => {};
		}

		const promptEl = el.createDiv({ cls: "notor-interaction-prompt" });
		promptEl.createSpan({ cls: "notor-interaction-question", text: request.question });

		const allowFreeText = request.allowFreeText !== false;

		// Suggested-answer chips
		if (request.suggestions && request.suggestions.length > 0) {
			const chipsEl = promptEl.createDiv({ cls: "notor-interaction-chips" });
			for (const suggestion of request.suggestions) {
				const chip = chipsEl.createEl("button", {
					cls: "notor-interaction-chip",
					text: suggestion,
				});
				chip.addEventListener("click", () => {
					resolve({ id: request.id, value: suggestion });
				});
			}
		}

		// Free-text input + submit
		if (allowFreeText) {
			const inputRow = promptEl.createDiv({ cls: "notor-interaction-input-row" });
			const input = inputRow.createEl("input", {
				cls: "notor-interaction-input",
				type: "text",
			});
			input.placeholder = "Type your answer…";

			const submit = () => {
				const value = input.value.trim();
				if (value.length === 0) return;
				resolve({ id: request.id, value });
			};

			input.addEventListener("keydown", (e: KeyboardEvent) => {
				if (e.key === "Enter") {
					e.preventDefault();
					submit();
				}
			});

			const submitBtn = inputRow.createEl("button", {
				cls: "notor-interaction-submit",
				text: "Send",
			});
			submitBtn.addEventListener("click", submit);

			// Focus the input so the user can type immediately.
			window.setTimeout(() => input.focus(), 0);
		}

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
