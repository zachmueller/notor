import { Notice } from "obsidian";
import type { App } from "obsidian";
import type { NotorSettings } from "./types";
import { DEFAULT_MODEL_PRESETS } from "./defaults";
import { slugifySecretId } from "../extensions/settings-schema";
import { getSecret, setSecret, clearSecret } from "../utils/secrets";

export interface MigrationDeps {
	settings: NotorSettings;
	app: App;
	saveSettings: () => Promise<void>;
	loadData: () => Promise<unknown>;
	saveData: (data: unknown) => Promise<void>;
}

export async function runAllMigrations(deps: MigrationDeps): Promise<void> {
	await migrateToolSettingsToExtensions(deps);
	await migrateModelPresets(deps);
	await migrateAutomationSettings(deps);
	await migrateProviderInstances(deps);
	await migrateWebSearchMultiProvider(deps);
}

/**
 * One-time migration of old NotorSettings tool fields into the extension
 * settings system (per-extension + shared). See spec D-2.
 *
 * Detection: per-tool-group check — migrate only if the extension settings
 * key is absent (undefined) AND the old field exists in loaded data.
 *
 * Atomicity: two-phase write.
 *   Phase 1: copy values into extension settings + saveSettings()
 *   Phase 2: delete old fields from settings object + saveSettings()
 * If the plugin crashes between phases, next boot sees old fields still
 * present but extension settings already populated — detection skips
 * already-migrated groups.
 */
async function migrateToolSettingsToExtensions(deps: MigrationDeps): Promise<void> {
	const { settings, saveSettings, loadData, saveData } = deps;
	let migrated = false;

	// fetch_webpage
	if (
		settings.user_extension_settings["fetch_webpage"] === undefined &&
		settings.fetch_webpage_timeout !== undefined
	) {
		settings.user_extension_settings["fetch_webpage"] = {
			fetch_webpage_timeout: settings.fetch_webpage_timeout,
			fetch_webpage_max_download_mb: settings.fetch_webpage_max_download_mb,
			fetch_webpage_max_output_chars: settings.fetch_webpage_max_output_chars,
		};
		migrated = true;
	}

	// web_search (fields removed from NotorSettings — cast through raw data)
	const rawWs = settings as unknown as Record<string, unknown>;
	if (
		settings.user_extension_settings["web_search"] === undefined &&
		rawWs.web_search_timeout !== undefined
	) {
		settings.user_extension_settings["web_search"] = {
			web_search_timeout: rawWs.web_search_timeout as number,
			web_search_default_num_results: rawWs.web_search_default_num_results as number,
		};
		migrated = true;
	}

	// execute_command
	if (
		settings.user_extension_settings["execute_command"] === undefined &&
		settings.execute_command_timeout !== undefined
	) {
		settings.user_extension_settings["execute_command"] = {
			execute_command_allowed_paths: settings.execute_command_allowed_paths,
			execute_command_timeout: settings.execute_command_timeout,
			execute_command_max_output_chars: settings.execute_command_max_output_chars,
		};
		migrated = true;
	}

	// read_file
	if (
		settings.user_extension_settings["read_file"] === undefined &&
		settings.image_max_dimension !== undefined
	) {
		settings.user_extension_settings["read_file"] = {
			image_max_dimension: settings.image_max_dimension,
			image_compression_quality: settings.image_compression_quality,
			pdf_prefer_native: settings.pdf_prefer_native,
			pdf_text_max_chars: settings.pdf_text_max_chars,
			pdf_native_max_size_mb: settings.pdf_native_max_size_mb,
		};
		migrated = true;
	}

	// write_docx
	if (
		settings.user_extension_settings["write_docx"] === undefined &&
		settings.write_docx_default_output_dir !== undefined
	) {
		settings.user_extension_settings["write_docx"] = {
			write_docx_default_output_dir: settings.write_docx_default_output_dir,
			write_docx_default_template_path: settings.write_docx_default_template_path,
		};
		migrated = true;
	}

	// --- Shared settings ---

	// domain_denylist
	if (
		settings.user_shared_settings["domain_denylist"] === undefined &&
		settings.domain_denylist !== undefined
	) {
		settings.user_shared_settings["domain_denylist"] = settings.domain_denylist;
		migrated = true;
	}

	// read_file_allowed_paths
	if (
		settings.user_shared_settings["read_file_allowed_paths"] === undefined &&
		settings.read_file_allowed_paths !== undefined
	) {
		settings.user_shared_settings["read_file_allowed_paths"] = settings.read_file_allowed_paths;
		migrated = true;
	}

	if (!migrated) return;

	// Phase 1: persist the copied extension settings
	await saveSettings();

	// Phase 2: strip old fields from persisted data only.
	const oldFields = [
		"fetch_webpage_timeout",
		"fetch_webpage_max_download_mb",
		"fetch_webpage_max_output_chars",
		"domain_denylist",
		"web_search_timeout",
		"web_search_default_num_results",
		"execute_command_timeout",
		"execute_command_max_output_chars",
		"execute_command_allowed_paths",
		"image_max_dimension",
		"image_compression_quality",
		"pdf_native_max_size_mb",
		"pdf_text_max_chars",
		"pdf_prefer_native",
		"read_file_allowed_paths",
		"write_docx_default_output_dir",
		"write_docx_default_template_path",
	];

	const rawData = (await loadData()) as Record<string, unknown> | null;
	if (rawData) {
		for (const field of oldFields) {
			delete rawData[field];
		}
		await saveData(rawData);
	}

	new Notice("Tool settings have been migrated to Extensions in Settings.", 5000);
}

/**
 * One-time migration: initialize model presets for existing installs.
 *
 * If `model_presets` is absent (pre-preset install), initializes with
 * default presets and auto-configures the `medium` preset from the
 * current active provider + model, so existing users can continue
 * chatting immediately.
 */
async function migrateModelPresets(deps: MigrationDeps): Promise<void> {
	const { settings, saveSettings } = deps;
	if (settings.model_presets?.length > 0) return;

	settings.model_presets = DEFAULT_MODEL_PRESETS.map((p) => ({ ...p }));
	settings.default_preset = "medium";
	settings.automation_enabled["title-generation"] = false;
	if (!settings.user_extension_settings["Title Generation"]) {
		settings.user_extension_settings["Title Generation"] = {};
	}
	settings.user_extension_settings["Title Generation"]["preset"] = "small";

	const activeId = settings.active_provider;
	const activeConfig = settings.providers.find((p) => p.id === activeId || p.type === activeId);
	if (activeId && activeConfig?.model_id) {
		const medium = settings.model_presets.find((p) => p.name === "medium");
		if (medium) {
			medium.provider_id = activeConfig.id;
			medium.model_id = activeConfig.model_id;
			medium.use_extended_context = activeConfig.use_extended_context ?? false;
		}
	}

	await saveSettings();
}

/**
 * Migrate legacy `title_generation_enabled` / `title_generation_preset`
 * into the generic `automation_enabled` / `user_extension_settings` system.
 */
async function migrateAutomationSettings(deps: MigrationDeps): Promise<void> {
	const { settings, saveSettings } = deps;
	if (settings.automation_enabled["title-generation"] !== undefined) return;

	const legacyEnabled = (settings as unknown as Record<string, unknown>).title_generation_enabled;
	if (legacyEnabled === undefined) return;

	settings.automation_enabled["title-generation"] =
		settings.title_generation_enabled ?? false;

	const extKey = "Title Generation";
	const legacyPreset = settings.title_generation_preset;
	if (legacyPreset) {
		if (!settings.user_extension_settings[extKey]) {
			settings.user_extension_settings[extKey] = {};
		}
		settings.user_extension_settings[extKey]["preset"] = legacyPreset;
	}

	const raw = settings as unknown as Record<string, unknown>;
	delete raw.title_generation_enabled;
	delete raw.title_generation_preset;

	await saveSettings();
}

/**
 * Migrate providers to multi-instance format by assigning unique IDs.
 *
 * Detection: first provider in array lacks an `id` field.
 * Action: assign `id = type` for each existing provider (preserves
 * secret keys and conversation header references). Also migrates
 * ModelPreset.provider_type → provider_id.
 */
async function migrateProviderInstances(deps: MigrationDeps): Promise<void> {
	const { settings, saveSettings } = deps;
	const firstProvider = settings.providers[0];
	if (!firstProvider || firstProvider.id) return;

	for (const provider of settings.providers) {
		if (!provider.id) {
			provider.id = provider.type;
		}
	}

	for (const preset of settings.model_presets ?? []) {
		const raw = preset as unknown as Record<string, unknown>;
		if (raw.provider_type && !preset.provider_id) {
			preset.provider_id = raw.provider_type as string;
		}
		delete raw.provider_type;
	}

	await saveSettings();
}

/**
 * One-time migration: move multi-provider web search settings from the
 * built-in `web_search` extension into `multi_engine_web_search`.
 *
 * Detection: `web_search` settings contain a provider key like
 * `web_search_tavily_enabled` — this field no longer exists in the
 * simplified built-in scaffold.
 */
async function migrateWebSearchMultiProvider(deps: MigrationDeps): Promise<void> {
	const { settings, app, saveSettings } = deps;
	const wsSettings = settings.user_extension_settings["web_search"] as
		| Record<string, string | number | boolean | string[]>
		| undefined;

	if (!wsSettings || wsSettings.web_search_tavily_enabled === undefined) return;

	if (settings.user_extension_settings["multi_engine_web_search"]) return;

	const multiProviderKeys = [
		"web_search_round_robin",
		"web_search_provider_priority",
		"web_search_max_fallback_providers",
		"web_search_duckduckgo_enabled",
		"web_search_duckduckgo_delay_ms",
		"web_search_tavily_enabled",
		"web_search_tavily_api_key",
		"web_search_tavily_delay_ms",
		"web_search_brave_enabled",
		"web_search_brave_api_key",
		"web_search_brave_delay_ms",
		"web_search_serpapi_enabled",
		"web_search_serpapi_api_key",
		"web_search_serpapi_delay_ms",
	];

	const migrated: Record<string, string | number | boolean | string[]> = {};
	for (const key of multiProviderKeys) {
		if (key in wsSettings && wsSettings[key] !== undefined) {
			migrated[key] = wsSettings[key]!;
			delete wsSettings[key];
		}
	}

	delete wsSettings["web_search_duckduckgo_enabled"];

	settings.user_extension_settings["multi_engine_web_search"] = migrated;

	const secretKeys = ["web_search_tavily_api_key", "web_search_brave_api_key", "web_search_serpapi_api_key"];
	for (const key of secretKeys) {
		const oldId = slugifySecretId("notor-ext", "web_search", key);
		const newId = slugifySecretId("notor-ext", "multi_engine_web_search", key);
		const value = getSecret(app, oldId);
		if (value) {
			setSecret(app, newId, value);
			clearSecret(app, oldId);
		}
	}

	await saveSettings();
	new Notice(
		"Multi-provider web search settings have been moved to the 'Multi-Engine Web Search' extension tool.",
		8000,
	);
}
