#!/usr/bin/env npx tsx
/**
 * Templater API Investigation Script
 *
 * Probes the runtime structure of the Templater plugin to discover:
 * 1. The path to the InternalModuleSystem instance
 * 2. How prompt/suggester functions are stored (static_functions map vs static_object)
 * 3. Whether monkey-patching the generated object is feasible
 * 4. The exact method signatures available on the Templater instance
 * 5. How create_new_note_from_template and write_template_to_file work at runtime
 *
 * This is a research script — it does NOT modify templates or create notes.
 * It only reads and logs the internal API surface of Templater v2.20.4.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, writeCleanWorkspace } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEMPLATER_PLUGIN_ID = "templater-obsidian";
const TEMPLATER_SOURCE = "/Users/zmueller/zm/.obsidian/plugins/templater-obsidian";
const TEMPLATES_FOLDER = "templates";

// ---------------------------------------------------------------------------
// Vault setup: install Templater + create a test template
// ---------------------------------------------------------------------------

function setupVault(vaultPath: string): void {
	const obsidianDir = path.join(vaultPath, ".obsidian");
	const pluginsDir = path.join(obsidianDir, "plugins");

	// 1. Copy Templater plugin into test vault
	const templaterDir = path.join(pluginsDir, TEMPLATER_PLUGIN_ID);
	if (!fs.existsSync(templaterDir)) {
		fs.mkdirSync(templaterDir, { recursive: true });
	}
	for (const file of ["main.js", "manifest.json", "styles.css"]) {
		const src = path.join(TEMPLATER_SOURCE, file);
		const dst = path.join(templaterDir, file);
		if (fs.existsSync(src)) {
			fs.copyFileSync(src, dst);
		}
	}

	// Templater settings: minimal config pointing to our test templates folder
	const templaterSettings = {
		command_timeout: 5,
		templates_folder: TEMPLATES_FOLDER,
		templates_pairs: [["", ""]],
		trigger_on_file_creation: false, // don't auto-trigger during test
		auto_jump_to_cursor: false,
		enable_system_commands: false,
		shell_path: "",
		user_scripts_folder: "",
		enable_folder_templates: false,
		folder_templates: [],
		syntax_highlighting: true,
		enabled_templates_hotkeys: [],
		startup_templates: [""],
	};
	fs.writeFileSync(
		path.join(templaterDir, "data.json"),
		JSON.stringify(templaterSettings, null, 2),
	);

	// 2. Enable Templater in community-plugins.json
	const communityPluginsPath = path.join(obsidianDir, "community-plugins.json");
	const existing = fs.existsSync(communityPluginsPath)
		? JSON.parse(fs.readFileSync(communityPluginsPath, "utf-8"))
		: [];
	if (!existing.includes(TEMPLATER_PLUGIN_ID)) {
		existing.push(TEMPLATER_PLUGIN_ID);
	}
	fs.writeFileSync(communityPluginsPath, JSON.stringify(existing));

	// 3. Create test templates folder with sample templates
	const templatesDir = path.join(vaultPath, TEMPLATES_FOLDER);
	fs.mkdirSync(templatesDir, { recursive: true });

	// Simple template (no prompts)
	fs.writeFileSync(
		path.join(templatesDir, "simple-template.md"),
		`---
tags: [test]
---
# Simple Note
Created on <% tp.date.now("YYYY-MM-DD") %>
`,
	);

	// Template with prompt
	fs.writeFileSync(
		path.join(templatesDir, "prompt-template.md"),
		`---
tags: [test]
---
# <% tp.system.prompt("Enter note title") %>
Author: <% tp.system.prompt("Enter author name", "Anonymous") %>
`,
	);

	// Template with suggester
	fs.writeFileSync(
		path.join(templatesDir, "suggester-template.md"),
		`---
type: <% tp.system.suggester(["Meeting", "Project", "Person"], ["meeting", "project", "person"]) %>
---
# Note
Category selected above.
`,
	);

	// Template with both prompt and suggester
	fs.writeFileSync(
		path.join(templatesDir, "mixed-template.md"),
		`---
tags: [test]
---
# <% tp.system.prompt("Title") %>
Type: <% tp.system.suggester(["Alpha", "Beta", "Gamma"], ["a", "b", "g"]) %>
Description: <% tp.system.prompt("Description") %>
`,
	);

	// 4. Write workspace.json with Notor chat panel open
	writeCleanWorkspace(vaultPath);
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

await runTest(
	{
		name: "templater-api-investigation",
		settings: buildDefaultSettings(),
		setupVault,
		cleanupFiles: [TEMPLATES_FOLDER],
	},
	async (ctx: TestContext) => {
		const { page } = ctx;

		// Wait for plugins to load
		await page.waitForTimeout(8000);

		// ---------------------------------------------------------------------------
		// Probe 1: Is Templater loaded?
		// ---------------------------------------------------------------------------
		const templaterLoaded = await page.evaluate(() => {
			const app = (window as any).app;
			const templater = app?.plugins?.plugins?.["templater-obsidian"];
			if (!templater) return { loaded: false, reason: "Plugin not found in app.plugins.plugins" };
			return {
				loaded: true,
				manifest: templater.manifest,
				hasTemplater: !!templater.templater,
				hasSettings: !!templater.settings,
				settingsKeys: templater.settings ? Object.keys(templater.settings) : [],
			};
		});

		console.log("\n=== Probe 1: Templater Plugin Loaded ===");
		console.log(JSON.stringify(templaterLoaded, null, 2));

		if (!templaterLoaded.loaded) {
			ctx.fail("templater-loaded", templaterLoaded.reason ?? "Not loaded");
			return;
		}
		ctx.pass("templater-loaded", `v${templaterLoaded.manifest?.version}`);

		// ---------------------------------------------------------------------------
		// Probe 2: Templater instance structure
		// ---------------------------------------------------------------------------
		const templaterStructure = await page.evaluate(() => {
			const app = (window as any).app;
			const plugin = app.plugins.plugins["templater-obsidian"];
			const templater = plugin.templater;

			const keys = Object.getOwnPropertyNames(templater);
			const desc: Record<string, string> = {};
			for (const key of keys) {
				const val = templater[key];
				if (typeof val === "function") desc[key] = "function(" + val.length + " args)";
				else if (val === null) desc[key] = "null";
				else if (Array.isArray(val)) desc[key] = "Array(" + val.length + ")";
				else if (typeof val === "object") desc[key] = "object(" + Object.keys(val).length + " keys)";
				else desc[key] = String(val);
			}

			return {
				templaterKeys: keys,
				templaterDesc: desc,
				hasParser: !!templater.parser,
				hasFunctionsGenerator: !!templater.functions_generator,
				hasCurrentFunctionsObject: !!templater.current_functions_object,
			};
		});

		console.log("\n=== Probe 2: Templater Instance Structure ===");
		console.log(JSON.stringify(templaterStructure, null, 2));
		ctx.pass("templater-structure", `Keys: ${templaterStructure.templaterKeys.join(", ")}`);

		// ---------------------------------------------------------------------------
		// Probe 3: FunctionsGenerator structure
		// ---------------------------------------------------------------------------
		const functionsGenStructure = await page.evaluate(() => {
			const app = (window as any).app;
			const plugin = app.plugins.plugins["templater-obsidian"];
			const fg = plugin.templater.functions_generator;
			if (!fg) return { found: false };

			return {
				found: true,
				keys: Object.getOwnPropertyNames(fg),
				hasInternalFunctions: !!fg.internal_functions,
				hasUserFunctions: !!fg.user_functions,
				internalFunctionsKeys: fg.internal_functions
					? Object.getOwnPropertyNames(fg.internal_functions)
					: [],
			};
		});

		console.log("\n=== Probe 3: FunctionsGenerator Structure ===");
		console.log(JSON.stringify(functionsGenStructure, null, 2));
		ctx.pass("functions-generator", `Keys: ${functionsGenStructure.keys?.join(", ") ?? "N/A"}`);

		// ---------------------------------------------------------------------------
		// Probe 4: InternalFunctions and modules_array
		// ---------------------------------------------------------------------------
		const internalFunctionsStructure = await page.evaluate(() => {
			const app = (window as any).app;
			const plugin = app.plugins.plugins["templater-obsidian"];
			const intFn = plugin.templater.functions_generator?.internal_functions;
			if (!intFn) return { found: false };

			// Try to access modules_array (it's private, but accessible at runtime)
			const modulesArray = (intFn as any).modules_array;
			const moduleNames = modulesArray
				? modulesArray.map((m: any) => ({
						name: m.name ?? m.getName?.() ?? "unknown",
						type: m.constructor?.name ?? "unknown",
						hasStaticFunctions: m.static_functions instanceof Map,
						staticFunctionsSize: m.static_functions?.size ?? 0,
						hasStaticObject: !!m.static_object,
						staticObjectKeys: m.static_object ? Object.keys(m.static_object) : [],
					}))
				: [];

			return {
				found: true,
				keys: Object.getOwnPropertyNames(intFn),
				hasModulesArray: !!modulesArray,
				modulesArrayLength: modulesArray?.length ?? 0,
				modules: moduleNames,
			};
		});

		console.log("\n=== Probe 4: InternalFunctions & modules_array ===");
		console.log(JSON.stringify(internalFunctionsStructure, null, 2));

		if (internalFunctionsStructure.found && internalFunctionsStructure.hasModulesArray) {
			ctx.pass(
				"modules-array",
				`Found ${internalFunctionsStructure.modulesArrayLength} modules: ${(internalFunctionsStructure.modules as any[]).map((m: any) => m.name).join(", ")}`,
			);
		} else {
			ctx.fail("modules-array", "modules_array not found on InternalFunctions");
		}

		// ---------------------------------------------------------------------------
		// Probe 5: System module deep dive
		// ---------------------------------------------------------------------------
		const systemModuleStructure = await page.evaluate(() => {
			const app = (window as any).app;
			const plugin = app.plugins.plugins["templater-obsidian"];
			const intFn = plugin.templater.functions_generator?.internal_functions;
			const modulesArray = (intFn as any)?.modules_array;
			if (!modulesArray) return { found: false, reason: "No modules_array" };

			const systemModule = modulesArray.find(
				(m: any) => m.name === "system" || m.getName?.() === "system",
			);
			if (!systemModule) return { found: false, reason: "No system module in array" };

			// Examine the static_functions Map
			const staticFnEntries: Record<string, string> = {};
			if (systemModule.static_functions instanceof Map) {
				for (const [key, val] of systemModule.static_functions.entries()) {
					staticFnEntries[key] = typeof val === "function"
						? `function(${val.length} args)`
						: typeof val;
				}
			}

			// Examine the static_object (frozen copy from init())
			const staticObjEntries: Record<string, string> = {};
			if (systemModule.static_object) {
				for (const [key, val] of Object.entries(systemModule.static_object)) {
					staticObjEntries[key] = typeof val === "function"
						? `function(${(val as Function).length} args)`
						: typeof val;
				}
			}

			return {
				found: true,
				moduleName: systemModule.name,
				constructorName: systemModule.constructor?.name,
				ownKeys: Object.getOwnPropertyNames(systemModule),
				protoKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(systemModule)),
				staticFunctionsMap: staticFnEntries,
				staticObject: staticObjEntries,
				hasConfig: !!systemModule.config,
			};
		});

		console.log("\n=== Probe 5: System Module Deep Dive ===");
		console.log(JSON.stringify(systemModuleStructure, null, 2));

		if (systemModuleStructure.found) {
			ctx.pass(
				"system-module",
				`Static functions: ${Object.keys(systemModuleStructure.staticFunctionsMap ?? {}).join(", ")}`,
			);
		} else {
			ctx.fail("system-module", systemModuleStructure.reason ?? "Not found");
		}

		// ---------------------------------------------------------------------------
		// Probe 6: Test monkey-patching feasibility
		// ---------------------------------------------------------------------------
		const monkeyPatchTest = await page.evaluate(`(function() {
			var app = window.app;
			var plugin = app.plugins.plugins["templater-obsidian"];
			var intFn = plugin.templater.functions_generator && plugin.templater.functions_generator.internal_functions;
			var modulesArray = intFn && intFn.modules_array;
			if (!modulesArray) return { feasible: false, reason: "No modules_array" };

			var systemModule = null;
			for (var i = 0; i < modulesArray.length; i++) {
				if (modulesArray[i].name === "system") { systemModule = modulesArray[i]; break; }
			}
			if (!systemModule) return { feasible: false, reason: "No system module" };

			// Test 1: Can we read the current prompt function from static_functions?
			var originalPrompt = systemModule.static_functions && systemModule.static_functions.get("prompt");
			var canReadPrompt = typeof originalPrompt === "function";

			// Test 2: Can we set a new function on the Map?
			var testFn = function() { return "test"; };
			var canWriteMap = false;
			if (systemModule.static_functions instanceof Map) {
				systemModule.static_functions.set("__test_key", testFn);
				canWriteMap = systemModule.static_functions.get("__test_key") === testFn;
				systemModule.static_functions.delete("__test_key");
			}

			// Test 3: Can we modify static_object?
			var canWriteStaticObject = false;
			if (systemModule.static_object) {
				var origVal = systemModule.static_object.prompt;
				systemModule.static_object.prompt = testFn;
				canWriteStaticObject = systemModule.static_object.prompt === testFn;
				systemModule.static_object.prompt = origVal;
			}

			// Test 4: Check if generate_object spreads static_object
			var generateObjectSource = (systemModule.generate_object && systemModule.generate_object.toString) ? systemModule.generate_object.toString() : "";

			return {
				feasible: true,
				canReadPrompt: canReadPrompt,
				canWriteMap: canWriteMap,
				canWriteStaticObject: canWriteStaticObject,
				promptFnArity: originalPrompt ? originalPrompt.length : -1,
				generateObjectSourcePreview: generateObjectSource.slice(0, 500),
			};
		})()`) as any;

		console.log("\n=== Probe 6: Monkey-Patch Feasibility ===");
		console.log(JSON.stringify(monkeyPatchTest, null, 2));

		if (monkeyPatchTest.feasible) {
			ctx.pass(
				"monkey-patch-feasibility",
				`canReadPrompt=${monkeyPatchTest.canReadPrompt}, canWriteMap=${monkeyPatchTest.canWriteMap}, canWriteStaticObject=${monkeyPatchTest.canWriteStaticObject}`,
			);
		} else {
			ctx.fail("monkey-patch-feasibility", monkeyPatchTest.reason ?? "Not feasible");
		}

		// ---------------------------------------------------------------------------
		// Probe 7: Templater's public API methods
		// ---------------------------------------------------------------------------
		const publicApi = await page.evaluate(`(function() {
			var app = window.app;
			var plugin = app.plugins.plugins["templater-obsidian"];
			var templater = plugin.templater;

			var methods = {};
			var proto = Object.getPrototypeOf(templater);
			var protoKeys = Object.getOwnPropertyNames(proto);
			for (var i = 0; i < protoKeys.length; i++) {
				var key = protoKeys[i];
				if (key === "constructor") continue;
				var val = proto[key];
				if (typeof val === "function") {
					methods[key] = "function(" + val.length + " params)";
				}
			}

			return {
				instanceKeys: Object.getOwnPropertyNames(templater),
				protoMethods: methods,
				hasCreateNewNote: typeof templater.create_new_note_from_template === "function",
				hasWriteTemplate: typeof templater.write_template_to_file === "function",
				hasOverwrite: typeof templater.overwrite_file_commands === "function",
				hasAppendTemplate: typeof templater.append_template_to_active_file === "function",
				createNewNoteArity: templater.create_new_note_from_template ? templater.create_new_note_from_template.length : -1,
				writeTemplateArity: templater.write_template_to_file ? templater.write_template_to_file.length : -1,
			};
		})()`) as any;

		console.log("\n=== Probe 7: Templater Public API ===");
		console.log(JSON.stringify(publicApi, null, 2));
		ctx.pass("public-api", `Methods: ${Object.keys(publicApi.protoMethods).join(", ")}`);

		// ---------------------------------------------------------------------------
		// Probe 8: current_functions_object after a template parse
		// ---------------------------------------------------------------------------
		const currentFnObj = await page.evaluate(`(function() {
			var app = window.app;
			var plugin = app.plugins.plugins["templater-obsidian"];
			var templater = plugin.templater;
			var obj = templater.current_functions_object;
			if (!obj) return { populated: false, reason: "current_functions_object is null/undefined" };

			var keys = Object.keys(obj);
			var systemObj = obj.system;
			var systemKeys = systemObj ? Object.keys(systemObj) : [];

			return {
				populated: keys.length > 0,
				topLevelKeys: keys,
				hasSystem: !!systemObj,
				systemKeys: systemKeys,
				systemPromptType: systemObj && systemObj.prompt ? typeof systemObj.prompt : "missing",
				systemSuggesterType: systemObj && systemObj.suggester ? typeof systemObj.suggester : "missing",
			};
		})()`) as any;

		console.log("\n=== Probe 8: current_functions_object ===");
		console.log(JSON.stringify(currentFnObj, null, 2));

		if (currentFnObj.populated) {
			ctx.pass("current-functions-object", `Keys: ${(currentFnObj.topLevelKeys ?? []).join(", ")}`);
		} else {
			ctx.pass("current-functions-object", `Not populated yet (expected — no template parsed): ${currentFnObj.reason}`);
		}

		// ---------------------------------------------------------------------------
		// Probe 9: Template folder detection paths
		// ---------------------------------------------------------------------------
		const folderDetection = await page.evaluate(`(function() {
			var app = window.app;
			var templaterPlugin = app.plugins && app.plugins.plugins && app.plugins.plugins["templater-obsidian"];
			var templaterFolder = templaterPlugin && templaterPlugin.settings && templaterPlugin.settings.templates_folder;

			var coreTemplates = app.internalPlugins && app.internalPlugins.plugins && app.internalPlugins.plugins["templates"];
			var coreTemplatesEnabled = coreTemplates ? !!coreTemplates.enabled : false;
			var coreTemplatesFolder = coreTemplates && coreTemplates.instance && coreTemplates.instance.options && coreTemplates.instance.options.folder;

			var coreTemplatesAlt = app.internalPlugins && app.internalPlugins.getPluginById && app.internalPlugins.getPluginById("templates");
			var altFolder = coreTemplatesAlt && coreTemplatesAlt.instance && coreTemplatesAlt.instance.options && coreTemplatesAlt.instance.options.folder;

			return {
				templater: { found: !!templaterPlugin, folder: templaterFolder || null },
				coreTemplates: {
					found: !!coreTemplates,
					enabled: coreTemplatesEnabled,
					folder: coreTemplatesFolder || null,
					altAccess: !!coreTemplatesAlt,
					altFolder: altFolder || null,
				},
			};
		})()`) as any;

		console.log("\n=== Probe 9: Template Folder Detection ===");
		console.log(JSON.stringify(folderDetection, null, 2));
		ctx.pass("folder-detection", JSON.stringify(folderDetection));

		// ---------------------------------------------------------------------------
		// Probe 10: Verify generate_object flow (simulate what happens during parse)
		// ---------------------------------------------------------------------------
		const generateObjectTest = await page.evaluate(`(async function() {
			var app = window.app;
			var plugin = app.plugins.plugins["templater-obsidian"];
			var fg = plugin.templater.functions_generator;
			if (!fg) return { success: false, reason: "No functions_generator" };

			var testFile = app.vault.getFiles()[0];
			if (!testFile) return { success: false, reason: "No files in vault" };

			var config = plugin.templater.create_running_config(testFile, testFile, 0);

			try {
				var obj = await fg.generate_object(config, 1);
				var keys = Object.keys(obj);
				var systemObj = obj.system;
				var systemKeys = systemObj ? Object.keys(systemObj) : [];

				var promptIsSameAsStatic = false;
				var intFn = fg.internal_functions;
				var modulesArray = intFn && intFn.modules_array;
				if (modulesArray) {
					for (var i = 0; i < modulesArray.length; i++) {
						if (modulesArray[i].name === "system") {
							promptIsSameAsStatic = modulesArray[i].static_object && modulesArray[i].static_object.prompt === (systemObj && systemObj.prompt);
							break;
						}
					}
				}

				return {
					success: true,
					topLevelKeys: keys,
					hasSystem: !!systemObj,
					systemKeys: systemKeys,
					promptType: systemObj && systemObj.prompt ? typeof systemObj.prompt : "undefined",
					suggesterType: systemObj && systemObj.suggester ? typeof systemObj.suggester : "undefined",
					multiSuggesterType: systemObj && systemObj.multi_suggester ? typeof systemObj.multi_suggester : "undefined",
					clipboardType: systemObj && systemObj.clipboard ? typeof systemObj.clipboard : "undefined",
					promptIsSameAsStatic: promptIsSameAsStatic,
				};
			} catch (e) {
				return { success: false, reason: e.message };
			}
		})()`) as any;

		console.log("\n=== Probe 10: generate_object() Flow ===");
		console.log(JSON.stringify(generateObjectTest, null, 2));

		if (generateObjectTest.success) {
			ctx.pass(
				"generate-object-flow",
				`System keys: ${generateObjectTest.systemKeys?.join(", ")} | promptIsSameAsStatic: ${generateObjectTest.promptIsSameAsStatic}`,
			);
		} else {
			ctx.fail("generate-object-flow", generateObjectTest.reason ?? "Failed");
		}

		// ---------------------------------------------------------------------------
		// Summary
		// ---------------------------------------------------------------------------
		console.log("\n=== INVESTIGATION COMPLETE ===");
		console.log("Key findings will be in the results JSON.\n");

		await ctx.screenshot("final-state");
	},
);
