/**
 * Required-parameter presence check, run before approval resolution.
 *
 * A tool call that omits a required parameter cannot succeed, yet without this
 * check it still travels the full approval pipeline and blocks the run loop on a
 * human prompt. It is worst under path-scoped auto-approve: with no `path`
 * argument, `evaluatePathApproval()` skips every descriptor and returns
 * `"none"`, so the user's `auto_approve_paths` never get a chance to match and a
 * write tool falls back to "ask the user" — for a call that was always going to
 * fail. Catching it here turns that interruption into an immediate, legible
 * error the model can self-correct from.
 *
 * Two deliberate constraints:
 *
 * 1. **Presence only, never types.** MCP `required[]` comes from an untrusted
 *    third-party schema, and scaffolds already type-check their own arguments.
 *    A false positive here would be worse than the status quo, so this reads
 *    nothing but `required` — no `type`, no `enum`, no nested `required`.
 * 2. **A free correction.** A validation failure must never draw down a retry or
 *    loop-guard budget. Today that holds by construction: it returns through
 *    `evaluateToolPolicy()`'s `allowed: false` path, which never touches
 *    `decrementAggregate()` (`src/run-loop/budget.ts`). If a per-tool-error or
 *    consecutive-failure counter is ever added, exempt these.
 *
 * @see src/chat/tool-policy.ts — step 3.5, the single call site
 */

import type { JSONSchema } from "../tools/tool";

/** Outcome of a required-parameter check. */
export interface ParamValidationResult {
	/** Names of required params that were absent, `undefined`, or `null`. */
	missing: string[];
}

/**
 * Report which of a schema's required parameters the call omitted.
 *
 * A parameter counts as missing when its key is absent, or its value is
 * `undefined` or `null`. Blank strings are **present**: `write_note` accepts
 * `content: ""` to create an empty note, and treating `""` as missing would
 * break that. A blank `path` still reaches the tool and fails there, as before.
 *
 * @param schema     - The tool's `input_schema`; `undefined` for tools that
 *                     declare none (nothing to validate against → no missing).
 * @param parameters - The tool call arguments from the LLM.
 */
export function validateRequiredParams(
	schema: JSONSchema | undefined,
	parameters: Record<string, unknown>,
): ParamValidationResult {
	// MCP servers supply their own schemas, so `required` may be absent or
	// malformed — treat anything but an array of names as "nothing required".
	const required = schema?.required;
	if (!Array.isArray(required)) return { missing: [] };

	const missing: string[] = [];
	for (const name of required) {
		if (typeof name !== "string") continue;
		const value = parameters[name];
		if (!(name in parameters) || value === undefined || value === null) {
			missing.push(name);
		}
	}

	return { missing };
}
