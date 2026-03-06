/**
 * Notor plugin entry point — lifecycle only.
 *
 * Keeps main.ts minimal per AGENTS.md conventions. All feature logic
 * is delegated to separate modules.
 */

import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, NotorSettings, NotorSettingTab } from "./settings";
import { logger } from "./utils/logger";

const log = logger("Main");

export default class NotorPlugin extends Plugin {
	settings: NotorSettings;

	async onload() {
		log.info("Plugin loading", { version: this.manifest.version });

		await this.loadSettings();
		log.debug("Settings loaded", { settings: this.settings });

		// Register the settings tab
		this.addSettingTab(new NotorSettingTab(this.app, this));

		log.info("Plugin loaded");
	}

	onunload() {
		log.info("Plugin unloading");
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}