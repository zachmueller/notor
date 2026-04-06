/**
 * Settings migration unit tests (Phase 8.3)
 *
 * Tests the one-time migration of old NotorSettings tool fields into the
 * extension settings system (per-extension + shared). See spec D-2.
 *
 * Since `migrateToolSettingsToExtensions()` is a private method on the plugin
 * class, we test it indirectly by calling `loadSettings()` on a mock plugin
 * that simulates the Obsidian Plugin base class persistence methods.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock obsidian — must be before imports
const mockNoticeInstances: Array<{ message: string }> = [];
vi.mock("obsidian", () => ({
	Plugin: class {},
	Notice: class {
		constructor(message: string) {
			mockNoticeInstances.push({ message });
		}
	},
}));

// Mock logger
vi.mock("../../utils/logger", () => ({
	logger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulates the old settings fields that exist pre-migration. */
function createOldSettings() {
	return {
		// fetch_webpage group
		fetch_webpage_timeout: 15,
		fetch_webpage_max_download_mb: 5,
		fetch_webpage_max_output_chars: 50000,
		// web_search group
		web_search_timeout: 10,
		web_search_default_num_results: 5,
		// execute_command group
		execute_command_timeout: 30,
		execute_command_max_output_chars: 100000,
		execute_command_allowed_paths: ["/usr/local/bin"],
		// read_file group
		image_max_dimension: 2000,
		image_compression_quality: 0.85,
		pdf_prefer_native: true,
		pdf_text_max_chars: 50000,
		pdf_native_max_size_mb: 10,
		// write_docx group
		write_docx_default_output_dir: "exports",
		write_docx_default_template_path: "templates/default.docx",
		// shared settings
		domain_denylist: ["evil.com"],
		read_file_allowed_paths: ["/tmp"],
		// Extension settings (empty = not yet migrated)
		user_extension_settings: {} as Record<string, Record<string, unknown>>,
		user_shared_settings: {} as Record<string, unknown>,
		// Other settings that must survive
		auto_approve: {},
		notor_dir: "notor/",
	};
}

/**
 * Creates a minimal plugin-like object that has the same loadSettings()
 * and migrateToolSettingsToExtensions() behavior as the real plugin.
 *
 * We replicate the two key methods from main.ts rather than importing
 * the full plugin class (which has heavy Obsidian dependencies).
 */
function createMockPlugin(persistedData: Record<string, unknown>) {
	let savedData: Record<string, unknown> = { ...persistedData };
	const settings: Record<string, unknown> = {};

	const plugin = {
		settings,

		// Simulates Obsidian's Plugin.loadData()
		loadData: vi.fn(async () => ({ ...savedData })),

		// Simulates Obsidian's Plugin.saveData()
		saveData: vi.fn(async (data: Record<string, unknown>) => {
			savedData = { ...data };
		}),

		// Simulates plugin.saveSettings()
		saveSettings: vi.fn(async () => {
			savedData = { ...settings } as Record<string, unknown>;
		}),

		// The actual migration method (copied from main.ts logic)
		async migrateToolSettingsToExtensions(): Promise<void> {
			const s = plugin.settings as any;
			let migrated = false;

			// fetch_webpage
			if (s.user_extension_settings["fetch_webpage"] === undefined && s.fetch_webpage_timeout !== undefined) {
				s.user_extension_settings["fetch_webpage"] = {
					fetch_webpage_timeout: s.fetch_webpage_timeout,
					fetch_webpage_max_download_mb: s.fetch_webpage_max_download_mb,
					fetch_webpage_max_output_chars: s.fetch_webpage_max_output_chars,
				};
				migrated = true;
			}

			// web_search
			if (s.user_extension_settings["web_search"] === undefined && s.web_search_timeout !== undefined) {
				s.user_extension_settings["web_search"] = {
					web_search_timeout: s.web_search_timeout,
					web_search_default_num_results: s.web_search_default_num_results,
				};
				migrated = true;
			}

			// execute_command
			if (s.user_extension_settings["execute_command"] === undefined && s.execute_command_timeout !== undefined) {
				s.user_extension_settings["execute_command"] = {
					execute_command_allowed_paths: s.execute_command_allowed_paths,
					execute_command_timeout: s.execute_command_timeout,
					execute_command_max_output_chars: s.execute_command_max_output_chars,
				};
				migrated = true;
			}

			// read_file
			if (s.user_extension_settings["read_file"] === undefined && s.image_max_dimension !== undefined) {
				s.user_extension_settings["read_file"] = {
					image_max_dimension: s.image_max_dimension,
					image_compression_quality: s.image_compression_quality,
					pdf_prefer_native: s.pdf_prefer_native,
					pdf_text_max_chars: s.pdf_text_max_chars,
					pdf_native_max_size_mb: s.pdf_native_max_size_mb,
				};
				migrated = true;
			}

			// write_docx
			if (s.user_extension_settings["write_docx"] === undefined && s.write_docx_default_output_dir !== undefined) {
				s.user_extension_settings["write_docx"] = {
					write_docx_default_output_dir: s.write_docx_default_output_dir,
					write_docx_default_template_path: s.write_docx_default_template_path,
				};
				migrated = true;
			}

			// Shared settings
			if (s.user_shared_settings["domain_denylist"] === undefined && s.domain_denylist !== undefined) {
				s.user_shared_settings["domain_denylist"] = s.domain_denylist;
				migrated = true;
			}
			if (s.user_shared_settings["read_file_allowed_paths"] === undefined && s.read_file_allowed_paths !== undefined) {
				s.user_shared_settings["read_file_allowed_paths"] = s.read_file_allowed_paths;
				migrated = true;
			}

			if (!migrated) return;

			// Phase 1: persist extension settings
			await plugin.saveSettings();

			// Phase 2: strip old fields from persisted data
			const oldFields = [
				"fetch_webpage_timeout", "fetch_webpage_max_download_mb", "fetch_webpage_max_output_chars",
				"domain_denylist", "web_search_timeout", "web_search_default_num_results",
				"execute_command_timeout", "execute_command_max_output_chars", "execute_command_allowed_paths",
				"image_max_dimension", "image_compression_quality", "pdf_native_max_size_mb",
				"pdf_text_max_chars", "pdf_prefer_native", "read_file_allowed_paths",
				"write_docx_default_output_dir", "write_docx_default_template_path",
			];

			const rawData = (await plugin.loadData()) as Record<string, unknown> | null;
			if (rawData) {
				for (const field of oldFields) {
					delete rawData[field];
				}
				await plugin.saveData(rawData);
			}

			new (await import("obsidian")).Notice("Tool settings have been migrated to Extensions in Settings.");
		},

		/** Simulates loadSettings() from main.ts */
		async loadSettings(): Promise<void> {
			const loaded = await plugin.loadData();
			Object.assign(plugin.settings, loaded);
			await plugin.migrateToolSettingsToExtensions();
		},

		/** Returns the currently persisted data (for assertions). */
		getPersistedData: () => savedData,
	};

	return plugin;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.clearAllMocks();
	mockNoticeInstances.length = 0;
});

describe("migrateToolSettingsToExtensions", () => {
	it("copies old fields into user_extension_settings and user_shared_settings", async () => {
		const oldSettings = createOldSettings();
		const plugin = createMockPlugin(oldSettings);
		await plugin.loadSettings();

		const s = plugin.settings as any;

		// Per-extension settings
		expect(s.user_extension_settings["fetch_webpage"]).toEqual({
			fetch_webpage_timeout: 15,
			fetch_webpage_max_download_mb: 5,
			fetch_webpage_max_output_chars: 50000,
		});
		expect(s.user_extension_settings["web_search"]).toEqual({
			web_search_timeout: 10,
			web_search_default_num_results: 5,
		});
		expect(s.user_extension_settings["execute_command"]).toEqual({
			execute_command_allowed_paths: ["/usr/local/bin"],
			execute_command_timeout: 30,
			execute_command_max_output_chars: 100000,
		});
		expect(s.user_extension_settings["read_file"]).toEqual({
			image_max_dimension: 2000,
			image_compression_quality: 0.85,
			pdf_prefer_native: true,
			pdf_text_max_chars: 50000,
			pdf_native_max_size_mb: 10,
		});
		expect(s.user_extension_settings["write_docx"]).toEqual({
			write_docx_default_output_dir: "exports",
			write_docx_default_template_path: "templates/default.docx",
		});

		// Shared settings
		expect(s.user_shared_settings["domain_denylist"]).toEqual(["evil.com"]);
		expect(s.user_shared_settings["read_file_allowed_paths"]).toEqual(["/tmp"]);
	});

	it("deletes old fields from persisted data after successful copy", async () => {
		const oldSettings = createOldSettings();
		const plugin = createMockPlugin(oldSettings);
		await plugin.loadSettings();

		const persisted = plugin.getPersistedData();

		// Old fields should be removed from persisted data
		expect(persisted).not.toHaveProperty("fetch_webpage_timeout");
		expect(persisted).not.toHaveProperty("fetch_webpage_max_download_mb");
		expect(persisted).not.toHaveProperty("fetch_webpage_max_output_chars");
		expect(persisted).not.toHaveProperty("web_search_timeout");
		expect(persisted).not.toHaveProperty("web_search_default_num_results");
		expect(persisted).not.toHaveProperty("execute_command_timeout");
		expect(persisted).not.toHaveProperty("execute_command_max_output_chars");
		expect(persisted).not.toHaveProperty("execute_command_allowed_paths");
		expect(persisted).not.toHaveProperty("image_max_dimension");
		expect(persisted).not.toHaveProperty("image_compression_quality");
		expect(persisted).not.toHaveProperty("pdf_prefer_native");
		expect(persisted).not.toHaveProperty("pdf_text_max_chars");
		expect(persisted).not.toHaveProperty("pdf_native_max_size_mb");
		expect(persisted).not.toHaveProperty("domain_denylist");
		expect(persisted).not.toHaveProperty("read_file_allowed_paths");
		expect(persisted).not.toHaveProperty("write_docx_default_output_dir");
		expect(persisted).not.toHaveProperty("write_docx_default_template_path");

		// Extension settings should be in persisted data
		expect(persisted).toHaveProperty("user_extension_settings");
		expect(persisted).toHaveProperty("user_shared_settings");
	});

	it("skips groups where user_extension_settings[toolName] already exists", async () => {
		const oldSettings = createOldSettings();
		// Pre-populate fetch_webpage extension settings (already migrated)
		oldSettings.user_extension_settings["fetch_webpage"] = {
			fetch_webpage_timeout: 99, // custom value
			fetch_webpage_max_download_mb: 1,
			fetch_webpage_max_output_chars: 10000,
		};

		const plugin = createMockPlugin(oldSettings);
		await plugin.loadSettings();

		const s = plugin.settings as any;

		// fetch_webpage should NOT have been overwritten — custom value preserved
		expect(s.user_extension_settings["fetch_webpage"]).toEqual({
			fetch_webpage_timeout: 99,
			fetch_webpage_max_download_mb: 1,
			fetch_webpage_max_output_chars: 10000,
		});

		// Other groups should still have been migrated
		expect(s.user_extension_settings["web_search"]).toBeDefined();
		expect(s.user_extension_settings["execute_command"]).toBeDefined();
		expect(s.user_extension_settings["read_file"]).toBeDefined();
		expect(s.user_extension_settings["write_docx"]).toBeDefined();
	});

	it("crash between phase 1 and phase 2 does not cause re-migration on next boot", async () => {
		const oldSettings = createOldSettings();
		const plugin = createMockPlugin(oldSettings);

		// Simulate crash: saveData throws after saveSettings succeeds (phase 1 done, phase 2 fails)
		let saveSettingsCallCount = 0;
		plugin.saveSettings.mockImplementation(async () => {
			saveSettingsCallCount++;
			// Phase 1 succeeds — persist the extension settings into saved data
			const currentData = await plugin.loadData();
			const s = plugin.settings as any;
			(currentData as any).user_extension_settings = { ...s.user_extension_settings };
			(currentData as any).user_shared_settings = { ...s.user_shared_settings };
			await plugin.saveData(currentData as Record<string, unknown>);
		});

		// First call to saveData in phase 2 will throw (simulating crash)
		const originalSaveData = plugin.saveData.getMockImplementation()!;
		let saveDataCallCount = 0;
		plugin.saveData.mockImplementation(async (data: Record<string, unknown>) => {
			saveDataCallCount++;
			if (saveDataCallCount === 2) {
				// Second saveData call is phase 2 cleanup — simulate crash
				throw new Error("Simulated crash");
			}
			return originalSaveData(data);
		});

		// First boot — migration runs, phase 2 fails
		try {
			await plugin.loadSettings();
		} catch {
			// Expected — phase 2 threw
		}

		// Extension settings should be persisted (phase 1 succeeded)
		const persistedAfterCrash = plugin.getPersistedData() as any;
		expect(persistedAfterCrash.user_extension_settings["fetch_webpage"]).toBeDefined();

		// Old fields still present (phase 2 didn't run)
		expect(persistedAfterCrash).toHaveProperty("fetch_webpage_timeout");

		// Second boot — new plugin instance, loads the persisted data
		const plugin2 = createMockPlugin(persistedAfterCrash);
		await plugin2.loadSettings();

		const s2 = plugin2.settings as any;

		// fetch_webpage should NOT be re-migrated — extension settings already exist
		// The values should match what was saved in phase 1
		expect(s2.user_extension_settings["fetch_webpage"]).toEqual({
			fetch_webpage_timeout: 15,
			fetch_webpage_max_download_mb: 5,
			fetch_webpage_max_output_chars: 50000,
		});
	});

	it("shows Notice on successful migration", async () => {
		const oldSettings = createOldSettings();
		const plugin = createMockPlugin(oldSettings);
		await plugin.loadSettings();

		const migrationNotice = mockNoticeInstances.find(n =>
			n.message.includes("migrated to Extensions"),
		);
		expect(migrationNotice).toBeDefined();
	});

	it("does not migrate or show Notice when no old fields exist", async () => {
		const freshSettings = {
			user_extension_settings: {},
			user_shared_settings: {},
			auto_approve: {},
			notor_dir: "notor/",
		};
		const plugin = createMockPlugin(freshSettings);
		await plugin.loadSettings();

		// saveSettings should not have been called (no migration)
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(mockNoticeInstances).toHaveLength(0);
	});
});
