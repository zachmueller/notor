/**
 * Notice shown when Notor falls back to the 128K default context window
 * for a model it doesn't recognize.
 *
 * Deduplication (once per model per session) lives in the model-limits
 * registry; this helper only renders the Notice.
 */

import { Notice, Platform } from "obsidian";
import type NotorPlugin from "../main";
import { MODEL_CONTEXT_LIMITS_SUBSECTION } from "../settings/sections/model-context-limits";

/**
 * Tell the user Notor is assuming a 128K window for a model, and on desktop
 * let a right-click open Settings → Notor → Reference → Model context limits.
 */
export function showUnknownContextWindowNotice(plugin: NotorPlugin, modelId: string): void {
	const message =
		`Notor doesn't know the context window for "${modelId}", so it assumes 128K tokens and may compact early. ` +
		"Add an override in Settings → Notor → Reference → Model context limits." +
		(Platform.isDesktop ? "\n(right-click to open the setting)" : "");

	const notice = new Notice(message, 10000);

	if (Platform.isDesktop) {
		notice.messageEl.oncontextmenu = () => {
			const appSetting = (plugin.app as import("obsidian").App & {
				setting?: { open: () => void; openTabById: (id: string) => void };
			}).setting;
			appSetting?.open();
			appSetting?.openTabById("notor");
			setTimeout(() => {
				plugin.scrollSettingsToGroup("Reference", MODEL_CONTEXT_LIMITS_SUBSECTION);
			}, 100);
		};
	}
}
