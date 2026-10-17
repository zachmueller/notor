/**
 * Vault-schema aliases for circuits.
 *
 * "Circuit" is the current name for what older notes call an "orchestration
 * flow". Both spellings are accepted silently and indefinitely: existing
 * `notor-type: orchestration-flow` definitions with `notor-flow-*` keys keep
 * working with no edits. When a note carries both the new and the legacy key,
 * the new key wins.
 *
 * Only the keys whose names mention "flow" have a circuit spelling. Generic
 * keys (`notor-starting-event`, `notor-steps`, `notor-max-*`, every
 * `notor-step-*`, ...) are shared by both vocabularies and have no alias.
 */

/** Directory names under `{notor_dir}/` that hold circuit definitions, in precedence order. */
export const CIRCUIT_ROOT_DIR_NAMES = ["circuits", "orchestrations"] as const;

/** `notor-type` values accepted on a circuit's `definition.md`. */
export const CIRCUIT_DEFINITION_TYPES = ["circuit", "orchestration-flow"] as const;

/** `notor-type` values accepted on a step note. */
export const CIRCUIT_STEP_TYPES = ["circuit-step", "orchestration-step"] as const;

/** Pairs of `[newKey, legacyKey]` for definition frontmatter. */
export const CIRCUIT_KEY_ALIASES = {
	name: ["notor-circuit-name", "notor-flow-name"],
	description: ["notor-circuit-description", "notor-flow-description"],
	invocable: ["notor-circuit-invocable", "notor-flow-invocable"],
	inputs: ["notor-circuit-inputs", "notor-flow-inputs"],
	returns: ["notor-circuit-returns", "notor-flow-returns"],
	onComplete: ["notor-on-complete-circuit", "notor-on-complete-flow"],
	allowConcurrent: ["notor-circuit-allow-concurrent", "notor-flow-allow-concurrent"],
} as const satisfies Record<string, readonly [string, string]>;

export type CircuitAliasedField = keyof typeof CIRCUIT_KEY_ALIASES;

/** True when `value` is a circuit-definition discriminator (new or legacy). */
export function isCircuitDefinitionType(value: unknown): boolean {
	return (CIRCUIT_DEFINITION_TYPES as readonly unknown[]).includes(value);
}

/** True when `value` is a step-note discriminator (new or legacy). */
export function isCircuitStepType(value: unknown): boolean {
	return (CIRCUIT_STEP_TYPES as readonly unknown[]).includes(value);
}

/**
 * Read an aliased definition field. The new key wins whenever it is present
 * (not `undefined`); otherwise the legacy key is read.
 */
export function readAliasedKey(fm: Record<string, unknown>, field: CircuitAliasedField): unknown {
	const [newKey, legacyKey] = CIRCUIT_KEY_ALIASES[field];
	return fm[newKey] !== undefined ? fm[newKey] : fm[legacyKey];
}

/** Human-readable key label for error messages: `'new' (or legacy 'old')`. */
export function describeAliasedKey(field: CircuitAliasedField): string {
	const [newKey, legacyKey] = CIRCUIT_KEY_ALIASES[field];
	return `'${newKey}' (or legacy '${legacyKey}')`;
}
