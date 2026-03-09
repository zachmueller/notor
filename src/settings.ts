/**
 * Backward-compatibility shim for `src/settings`.
 *
 * All content has been moved to `src/settings/` sub-modules.
 * This file re-exports everything through the barrel so that
 * existing consumer imports (`from "../settings"` / `from "./settings"`)
 * continue to resolve without changes.
 *
 * Will be removed in S-006 once all consumers are verified.
 *
 * @see specs/03a-settings-refactor/tasks.md — S-001
 */
export * from "./settings/index";
