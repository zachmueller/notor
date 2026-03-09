/**
 * Shared dependencies passed to each settings section renderer.
 *
 * Every section function receives this context object instead of
 * accessing `this.plugin` directly, enabling standalone functions
 * rather than class methods.
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import type { App } from "obsidian";
import type NotorPlugin from "../../main";
import type { NotorSettings } from "../types";

/** Shared dependencies passed to each settings section renderer. */
export interface SettingsContext {
	app: App;
	plugin: NotorPlugin;
	settings: NotorSettings;
	saveSettings: () => Promise<void>;
	redisplay: () => void;
}
