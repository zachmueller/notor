/**
 * Execution chain tracker — infinite loop prevention for vault event hooks.
 *
 * Each background workflow execution carries an `ExecutionChain` that records
 * which vault event hook types have already fired in the current chain. When a
 * tool call within the workflow would trigger a hook whose event type is already
 * in the chain, the re-trigger is skipped with a Notice to the user.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-006
 */

import { Notice } from "obsidian";
import type { ExecutionChain } from "../types";
import { logger } from "../utils/logger";

const log = logger("ExecutionChainTracker");

// ---------------------------------------------------------------------------
// ExecutionChainTracker
// ---------------------------------------------------------------------------

/**
 * Factory and inspector for `ExecutionChain` objects.
 *
 * Stateless — all methods operate on the chain value passed in. The
 * chain itself is carried through the background workflow execution
 * pipeline and passed to hook dispatch points.
 */
export class ExecutionChainTracker {
	// ---------------------------------------------------------------------------
	// Chain lifecycle
	// ---------------------------------------------------------------------------

	/**
	 * Create a new execution chain seeded with the initial triggering hook event.
	 *
	 * @param sourceHookEvent - The vault event type that initiated this chain
	 *   (e.g. `"on_save"`, `"on_note_open"`).
	 * @returns A fresh `ExecutionChain` with one entry in `sourceHooks`.
	 */
	createChain(sourceHookEvent: string): ExecutionChain {
		log.debug("Creating execution chain", { sourceHookEvent });
		return {
			sourceHooks: new Set([sourceHookEvent]),
			modifiedNotePaths: new Set(),
		};
	}

	/**
	 * Return a new chain that includes the given hook event in its `sourceHooks`
	 * set, without mutating the original chain.
	 *
	 * @param chain      - Existing chain to extend.
	 * @param hookEvent  - Additional hook event type to record.
	 * @returns A new `ExecutionChain` with the extended set.
	 */
	extendChain(chain: ExecutionChain, hookEvent: string): ExecutionChain {
		return {
			sourceHooks: new Set([...chain.sourceHooks, hookEvent]),
			modifiedNotePaths: new Set(chain.modifiedNotePaths),
		};
	}

	// ---------------------------------------------------------------------------
	// Loop detection
	// ---------------------------------------------------------------------------

	/**
	 * Check whether the given hook event should be skipped to prevent a loop.
	 *
	 * Returns `true` (skip) if `hookEvent` is already present in `chain.sourceHooks`.
	 * Returns `false` if `chain` is `null` (no chain context — not hook-triggered)
	 * or if the event has not been seen yet.
	 *
	 * When a loop is detected, surfaces a `Notice` to the user.
	 *
	 * @param chain     - Active execution chain, or `null` outside hook context.
	 * @param hookEvent - The vault event type about to fire.
	 * @returns `true` to skip; `false` to allow.
	 */
	shouldSkipHook(chain: ExecutionChain | null, hookEvent: string): boolean {
		if (chain === null) {
			// Not inside a hook-initiated workflow — no loop risk.
			return false;
		}

		if (chain.sourceHooks.has(hookEvent)) {
			const msg = `Hook cycle detected; skipping '${hookEvent}' to prevent infinite loop.`;
			log.warn(msg, { sourceHooks: [...chain.sourceHooks] });
			new Notice(msg);
			return true;
		}

		return false;
	}

	// ---------------------------------------------------------------------------
	// Note-path suppression (create-loop prevention)
	// ---------------------------------------------------------------------------

	/**
	 * Record a note path as having been created or modified by the current
	 * hook-initiated workflow, so that subsequent `on-note-create` or
	 * `on-save` events for that path are suppressed.
	 *
	 * Mutates `chain.modifiedNotePaths` in place.
	 *
	 * @param chain    - Active execution chain.
	 * @param notePath - Vault-relative path of the note to suppress.
	 */
	suppressNotePath(chain: ExecutionChain, notePath: string): void {
		chain.modifiedNotePaths.add(notePath);
		log.debug("Note path suppressed in chain", { notePath });
	}

	/**
	 * Check whether a note path has been suppressed in the current chain.
	 *
	 * Returns `false` when `chain` is `null` (not inside a hook workflow).
	 *
	 * @param chain    - Active execution chain, or `null`.
	 * @param notePath - Vault-relative path to check.
	 * @returns `true` if the path is suppressed; `false` otherwise.
	 */
	isNotePathSuppressed(chain: ExecutionChain | null, notePath: string): boolean {
		if (chain === null) return false;
		return chain.modifiedNotePaths.has(notePath);
	}
}
