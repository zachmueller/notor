/**
 * Notor settings module barrel.
 *
 * Re-exports the complete public API for the settings module.
 * External consumers should import from this barrel (via `"../settings"`
 * or `"./settings"`) rather than from internal sub-modules.
 *
 * @see specs/03a-settings-refactor/tasks.md — S-001, S-002
 */

// Types
export type { ModelPricing, Hook, HookEvent, HookConfig, NotorSettings } from "./types";

// Defaults
export { createDefaultSettings, DEFAULT_MODEL_PRESETS } from "./defaults";

// Constants (re-exported for internal use; not part of the original public API
// but available for consumers that need them)
export { AWS_REGIONS, TOOL_DISPLAY_NAMES } from "./constants";

// Helpers (re-exported for internal use)
export { getProvider, updateProvider, validateCronExpressionBasic } from "./helpers";

// Settings tab (UI class)
export { NotorSettingTab } from "./settings-tab";
