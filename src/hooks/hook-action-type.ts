/**
 * Hook action-type aliases (orchestrations → circuits rename).
 *
 * Hooks launch a circuit with `action_type: "run_circuit"` and a `circuit`
 * target (a circuit name or directory). The legacy `run_orchestration` action
 * and its `orchestration_flow` field are accepted forever: a one-time settings
 * migration rewrites stored hooks, and every reader goes through these helpers
 * so a legacy value written later (e.g. by `edit_notor_settings`) still works.
 */

/** Canonical hook action types. */
export type HookActionType = "execute_command" | "run_workflow" | "run_circuit";

/** Every value that may appear in stored settings (canonical + legacy). */
export type StoredHookActionType = HookActionType | "run_orchestration";

/** True for the circuit-launch action under either spelling. */
export function isRunCircuitAction(actionType: string | null | undefined): boolean {
	return actionType === "run_circuit" || actionType === "run_orchestration";
}

/** Canonicalize a stored action type (missing → `execute_command`, legacy → `run_circuit`). */
export function canonicalHookActionType(actionType: string | null | undefined): HookActionType {
	if (isRunCircuitAction(actionType)) return "run_circuit";
	if (actionType === "run_workflow") return "run_workflow";
	return "execute_command";
}

/** The circuit a hook launches: the `circuit` field, else the legacy `orchestration_flow`. */
export function hookCircuitRef(hook: { circuit?: string | null; orchestration_flow?: string | null }): string | null {
	return hook.circuit ?? hook.orchestration_flow ?? null;
}
