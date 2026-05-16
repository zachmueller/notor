#!/usr/bin/env npx tsx
/**
 * Bases API Discovery Test
 *
 * Probes the Obsidian runtime to discover how to programmatically evaluate
 * Bases queries. This is research — it inspects internal plugin state,
 * registered view types, and attempts to open a .base file to extract
 * the QueryController and BasesQueryResult.
 *
 * Findings are logged as structured results for review.
 *
 * Run with: npx tsx e2e/scripts/bases-api-discovery-test.ts
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import { VAULT_PATH } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Vault setup: create a .base file for testing
// ---------------------------------------------------------------------------

const BASE_FILE_CONTENT = `filters: ""
formulas: {}
properties: {}
views:
  - type: table
    name: "All Notes"
    order:
      - file.name
      - note.tags
`;

const TEST_NOTE_CONTENT = `---
tags: [test, bases-discovery]
status: active
---

# Test Note for Bases

This note exists so the Bases query has something to find.

\`\`\`base
filters: ""
views:
  - type: table
    name: "Embedded View"
    order:
      - file.name
\`\`\`
`;

function setupVault(vaultPath: string): void {
	// Create a .base file
	fs.writeFileSync(
		path.join(vaultPath, "test-query.base"),
		BASE_FILE_CONTENT,
	);
	// Create a note with an embedded base fence
	fs.writeFileSync(
		path.join(vaultPath, "bases-test-note.md"),
		TEST_NOTE_CONTENT,
	);
	console.log("[setup] Created test-query.base and bases-test-note.md");
}

// ---------------------------------------------------------------------------
// Test function
// ---------------------------------------------------------------------------

async function testBasesApiDiscovery(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	// Wait for plugin to fully initialize
	await page.waitForTimeout(8000);

	// ─── Probe 1: Internal plugins registry ───────────────────────────────────

	console.log("\n--- Probe 1: Internal Plugins ---");
	const internalPluginsResult = await page.evaluate(() => {
		const app = (window as any).app;
		if (!app) return { error: "app not found on window" };

		const ip = app.internalPlugins;
		if (!ip) return { error: "app.internalPlugins not found" };

		const pluginKeys = Object.keys(ip.plugins ?? {});
		const basesPlugin = ip.plugins?.["bases"] ?? ip.plugins?.["base"];
		const basesKey = pluginKeys.find(k => k.toLowerCase().includes("base"));

		let instanceInfo: any = null;
		if (basesPlugin) {
			const instance = basesPlugin.instance;
			instanceInfo = {
				enabled: basesPlugin.enabled,
				hasInstance: !!instance,
				constructorName: instance?.constructor?.name,
				protoMethods: instance
					? Object.getOwnPropertyNames(Object.getPrototypeOf(instance))
					: [],
				ownKeys: instance ? Object.keys(instance) : [],
			};
		}

		return {
			allInternalPlugins: pluginKeys,
			basesKey,
			basesPlugin: instanceInfo,
		};
	});

	console.log("Internal plugins result:", JSON.stringify(internalPluginsResult, null, 2));

	if (internalPluginsResult.error) {
		ctx.fail("internal-plugins", internalPluginsResult.error);
	} else {
		const found = !!internalPluginsResult.basesKey;
		if (found) {
			ctx.pass("internal-plugins", `Found bases plugin at key: "${internalPluginsResult.basesKey}"`);
		} else {
			ctx.fail("internal-plugins", `No "bases" key in internalPlugins. Available: ${internalPluginsResult.allInternalPlugins.join(", ")}`);
		}
	}

	// ─── Probe 2: View registry ──────────────────────────────────────────────

	console.log("\n--- Probe 2: View Registry ---");
	const viewRegistryResult = await page.evaluate(() => {
		const app = (window as any).app;
		if (!app) return { error: "app not found" };

		const registry = app.viewRegistry;
		if (!registry) return { error: "app.viewRegistry not found" };

		const viewTypes = Object.keys(registry.viewByType ?? {});
		const basesTypes = viewTypes.filter(t =>
			t.toLowerCase().includes("base")
		);

		// Check what file extensions are registered
		const extToType = registry.typeByExtension ?? {};
		const baseExtType = extToType["base"];

		return {
			allViewTypes: viewTypes,
			basesViewTypes: basesTypes,
			baseFileExtensionType: baseExtType,
			extensionRegistry: Object.entries(extToType)
				.filter(([ext]) => ext.includes("base"))
				.reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {}),
		};
	});

	console.log("View registry result:", JSON.stringify(viewRegistryResult, null, 2));

	if (viewRegistryResult.error) {
		ctx.fail("view-registry", viewRegistryResult.error);
	} else {
		const viewType = viewRegistryResult.baseFileExtensionType;
		if (viewType) {
			ctx.pass("view-registry", `.base files use view type: "${viewType}"`);
		} else {
			ctx.fail("view-registry", `No view type registered for .base extension. Bases types found: ${viewRegistryResult.basesViewTypes.join(", ") || "none"}`);
		}
	}

	// ─── Probe 3: Open .base file and inspect the view ───────────────────────

	console.log("\n--- Probe 3: Open .base File ---");
	const openBaseResult = await page.evaluate(async () => {
		const app = (window as any).app;
		if (!app) return { error: "app not found" };

		// Find our test .base file
		const baseFile = app.vault.getAbstractFileByPath("test-query.base");
		if (!baseFile) return { error: "test-query.base not found in vault" };

		// Open in a new leaf
		const leaf = app.workspace.getLeaf("tab");
		await leaf.openFile(baseFile);

		// Wait a moment for the view to initialize
		await new Promise(r => setTimeout(r, 3000));

		const view = leaf.view;
		if (!view) return { error: "leaf.view is null after opening .base file" };

		const viewType = typeof view.getViewType === "function"
			? view.getViewType()
			: "unknown";
		const constructorName = view.constructor?.name;
		const protoMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(view));
		const ownKeys = Object.keys(view);

		// Check for BasesView properties
		const hasData = "data" in view;
		const hasConfig = "config" in view;
		const hasAllProperties = "allProperties" in view;

		let dataInfo: any = null;
		if (hasData && view.data) {
			const data = view.data;
			dataInfo = {
				constructorName: data.constructor?.name,
				hasDataArray: Array.isArray(data.data),
				dataLength: Array.isArray(data.data) ? data.data.length : null,
				hasProperties: typeof data.properties !== "undefined",
				propertiesList: data.properties ?? null,
				protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(data)),
			};
		}

		let configInfo: any = null;
		if (hasConfig && view.config) {
			const config = view.config;
			configInfo = {
				constructorName: config.constructor?.name,
				name: config.name,
				protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(config)),
				hasGetOrder: typeof config.getOrder === "function",
				hasGetDisplayName: typeof config.getDisplayName === "function",
				order: typeof config.getOrder === "function" ? config.getOrder() : null,
			};
		}

		// Look for QueryController in the view's children/components
		let controllerInfo: any = null;
		const children = (view as any)._children ?? (view as any).children ?? [];
		for (const child of children) {
			if (child?.constructor?.name?.includes("Query") || child?.constructor?.name?.includes("Controller")) {
				controllerInfo = {
					constructorName: child.constructor?.name,
					protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(child)),
					ownKeys: Object.keys(child),
				};
				break;
			}
		}

		// Also check for a controller property directly
		if (!controllerInfo && (view as any).controller) {
			const ctrl = (view as any).controller;
			controllerInfo = {
				constructorName: ctrl.constructor?.name,
				protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(ctrl)),
				ownKeys: Object.keys(ctrl),
			};
		}

		// Check _children more broadly
		const childrenInfo = children.map((c: any) => ({
			constructorName: c?.constructor?.name,
			protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(c)).slice(0, 20),
		}));

		return {
			viewType,
			constructorName,
			protoMethods,
			ownKeys: ownKeys.slice(0, 30),
			hasData,
			hasConfig,
			hasAllProperties,
			dataInfo,
			configInfo,
			controllerInfo,
			childrenInfo,
		};
	});

	console.log("Open .base result:", JSON.stringify(openBaseResult, null, 2));

	if (openBaseResult.error) {
		ctx.fail("open-base-file", openBaseResult.error);
	} else if (openBaseResult.hasData && openBaseResult.dataInfo) {
		ctx.pass("open-base-file", `View "${openBaseResult.constructorName}" has .data (BasesQueryResult) with ${openBaseResult.dataInfo.dataLength ?? 0} entries`);
	} else {
		ctx.fail("open-base-file", `View "${openBaseResult.constructorName}" type="${openBaseResult.viewType}" — .data not found. Keys: ${openBaseResult.ownKeys?.join(", ")}`);
	}

	// ─── Probe 4: Full controller + data extraction (single evaluate) ───────

	console.log("\n--- Probe 4: Full Controller Inspection ---");
	const controllerResultsProbe = await page.evaluate(async () => {
		const app = (window as any).app;
		if (!app) return { error: "app not found" };

		// Open the .base file fresh and extract everything in one go
		const baseFile = app.vault.getAbstractFileByPath("test-query.base");
		if (!baseFile) return { error: "test-query.base not found" };

		const leaf = app.workspace.getLeaf("tab");
		await leaf.openFile(baseFile);

		// Wait for the view to fully initialize and run its query
		await new Promise(r => setTimeout(r, 5000));

		const view = leaf.view;
		if (!view) return { error: "leaf.view is null" };

		const children = view._children ?? [];
		if (children.length === 0) return { error: "view._children empty after 5s wait" };

		const controller = children[0];
		if (!controller) return { error: "controller is null" };

		// --- Query info ---
		let queryInfo: any = null;
		const query = controller.query;
		if (query) {
			queryInfo = {
				type: typeof query,
				constructorName: query.constructor?.name,
				keys: typeof query === "object" ? Object.keys(query) : null,
			};
			if (typeof query === "object") {
				const safeProps: Record<string, any> = {};
				for (const k of Object.keys(query)) {
					const val = query[k];
					if (val === null || val === undefined) safeProps[k] = null;
					else if (typeof val === "string") safeProps[k] = val.slice(0, 100);
					else if (typeof val === "number" || typeof val === "boolean") safeProps[k] = val;
					else if (Array.isArray(val)) safeProps[k] = `[Array(${val.length})]`;
					else safeProps[k] = `[${typeof val}: ${val.constructor?.name}]`;
				}
				queryInfo.safeProps = safeProps;
			}
		}

		// --- Results info ---
		const results = controller.results;
		let resultsInfo: any = { raw: null };
		if (results) {
			if (Array.isArray(results)) {
				resultsInfo = {
					type: "array",
					length: results.length,
					firstItemConstructor: results[0]?.constructor?.name,
					firstItemKeys: results[0] ? Object.keys(results[0]).slice(0, 15) : null,
				};
			} else if (typeof results === "object") {
				resultsInfo = {
					type: "object",
					constructorName: results.constructor?.name,
					keys: Object.keys(results).slice(0, 20),
					protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(results)).slice(0, 20),
					hasData: "data" in results,
					hasProperties: "properties" in results,
				};
				if (results.data && Array.isArray(results.data)) {
					resultsInfo.dataLength = results.data.length;
					if (results.data[0]) {
						resultsInfo.firstEntry = {
							constructorName: results.data[0].constructor?.name,
							hasFile: "file" in results.data[0],
							filePath: results.data[0].file?.path,
							hasGetValue: typeof results.data[0].getValue === "function",
						};
					}
				}
				if (typeof results.properties !== "undefined") {
					const p = results.properties;
					resultsInfo.propertiesList = Array.isArray(p) ? p : String(p).slice(0, 200);
				}
			}
		} else {
			resultsInfo.raw = "null/undefined";
		}

		// --- BasesView child of controller ---
		const basesView = controller.view;
		let basesViewInfo: any = null;
		if (basesView) {
			basesViewInfo = {
				constructorName: basesView.constructor?.name,
				protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(basesView)).slice(0, 25),
				hasData: "data" in basesView,
				hasConfig: "config" in basesView,
				hasAllProperties: "allProperties" in basesView,
				type: basesView.type,
			};
			if (basesView.data) {
				const d = basesView.data;
				basesViewInfo.data = {
					constructorName: d.constructor?.name,
					hasDataArray: Array.isArray(d.data),
					dataLength: Array.isArray(d.data) ? d.data.length : null,
					protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(d)),
				};
				if (typeof d.properties !== "undefined") {
					basesViewInfo.data.properties = d.properties;
				}
				// Extract sample rows
				if (Array.isArray(d.data) && d.data.length > 0) {
					const props = d.properties ?? [];
					basesViewInfo.sampleRows = d.data.slice(0, 3).map((entry: any) => {
						const row: Record<string, string> = { _file: entry.file?.path ?? "?" };
						for (const p of props) {
							try {
								const v = entry.getValue(p);
								row[p] = v ? v.toString() : "(null)";
							} catch (e: any) { row[p] = `(err: ${e.message})`; }
						}
						return row;
					});
				}
			}
			if (basesView.config) {
				const c = basesView.config;
				basesViewInfo.config = {
					name: c.name,
					hasGetDisplayName: typeof c.getDisplayName === "function",
					hasGetOrder: typeof c.getOrder === "function",
					order: typeof c.getOrder === "function" ? c.getOrder() : null,
				};
				// Get display names for properties
				if (basesView.data?.properties && typeof c.getDisplayName === "function") {
					basesViewInfo.displayNames = {};
					for (const p of basesView.data.properties) {
						try { basesViewInfo.displayNames[p] = c.getDisplayName(p); }
						catch { basesViewInfo.displayNames[p] = p; }
					}
				}
			}
			if (basesView.allProperties) {
				basesViewInfo.allPropertiesList = basesView.allProperties;
			}
		}

		// --- Try runQuery if results are empty ---
		let ranQuery = false;
		if (!results || (resultsInfo.dataLength === 0)) {
			if (typeof controller.runQuery === "function") {
				try {
					await controller.runQuery();
					await new Promise(r => setTimeout(r, 2000));
					ranQuery = true;

					// Re-check basesView.data after runQuery
					if (basesView?.data) {
						const d = basesView.data;
						basesViewInfo = basesViewInfo ?? {};
						basesViewInfo.afterRunQuery = {
							dataLength: Array.isArray(d.data) ? d.data.length : null,
							properties: d.properties ?? null,
						};
					}
				} catch (e: any) {
					resultsInfo.runQueryError = e.message;
				}
			}
		}

		return {
			controllerConstructor: controller.constructor?.name,
			queryInfo,
			resultsInfo,
			viewName: controller.viewName,
			basesViewInfo,
			relevantProperties: controller.relevantProperties
				? (Array.isArray(controller.relevantProperties) ? controller.relevantProperties : "non-array")
				: null,
			ranQuery,
		};
	});

	console.log("Controller results:", JSON.stringify(controllerResultsProbe, null, 2));

	if (controllerResultsProbe.error) {
		ctx.fail("controller-results", controllerResultsProbe.error);
	} else if (controllerResultsProbe.resultsInfo?.hasData) {
		ctx.pass("controller-results", `QueryController.results has .data with ${controllerResultsProbe.resultsInfo.dataInfo?.length ?? 0} entries`);
	} else {
		ctx.pass("controller-results", `QueryController inspected. results type: ${controllerResultsProbe.resultsInfo?.type ?? "null"}`);
	}

	// ─── Probe 5: setQuery API surface (uses same leaf from Probe 4) ────────

	console.log("\n--- Probe 5: setQuery + getViewConfig ---");
	const setQueryResult = await page.evaluate(async () => {
		const app = (window as any).app;
		if (!app) return { error: "app not found" };

		// Find the bases leaf opened in probe 3
		const leaves = app.workspace.getLeavesOfType("bases");
		if (leaves.length === 0) return { error: "no bases leaves open" };

		// Use the most recently opened leaf
		const leaf = leaves[leaves.length - 1];
		const view = leaf.view;
		const children = view._children ?? [];
		const controller = children[0];

		if (!controller) return { error: "no controller on bases view" };

		const info: any = {
			hasSetQuery: typeof controller.setQuery === "function",
			setQueryArity: controller.setQuery?.length,
			hasSetQueryAndView: typeof controller.setQueryAndView === "function",
			setQueryAndViewArity: controller.setQueryAndView?.length,
			hasBuildBasesContext: typeof controller.buildBasesContext === "function",
			buildBasesContextArity: controller.buildBasesContext?.length,
			hasRunQuery: typeof controller.runQuery === "function",
			runQueryArity: controller.runQuery?.length,
			hasGetProperties: typeof controller.getProperties === "function",
			hasGetViewConfig: typeof controller.getViewConfig === "function",
		};

		// Check getViewConfig
		if (typeof controller.getViewConfig === "function") {
			try {
				const vc = controller.getViewConfig();
				info.viewConfig = vc ? {
					constructorName: vc.constructor?.name,
					name: vc.name,
					protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(vc)),
					hasGetOrder: typeof vc.getOrder === "function",
					hasGetDisplayName: typeof vc.getDisplayName === "function",
					order: typeof vc.getOrder === "function" ? vc.getOrder() : null,
				} : null;
			} catch (e: any) { info.viewConfigError = e.message; }
		}

		// Check getProperties
		if (typeof controller.getProperties === "function") {
			try {
				const props = controller.getProperties();
				info.properties = props;
			} catch (e: any) { info.propertiesError = e.message; }
		}

		// Check ctx (BasesContext?)
		if (controller.ctx) {
			const ctx = controller.ctx;
			info.ctx = {
				constructorName: ctx.constructor?.name,
				keys: Object.keys(ctx).slice(0, 15),
				protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(ctx)).slice(0, 20),
			};
		}

		return info;
	});

	console.log("setQuery result:", JSON.stringify(setQueryResult, null, 2));

	if (setQueryResult.error) {
		ctx.fail("set-query", setQueryResult.error);
	} else {
		ctx.pass("set-query", `setQuery(arity=${setQueryResult.setQueryArity}), runQuery(arity=${setQueryResult.runQueryArity}), getViewConfig: ${!!setQueryResult.viewConfig}`);
	}

	// ─── Probe 7: Check if we can create a controller programmatically ───────

	console.log("\n--- Probe 7: Plugin getViewFactory ---");
	const factoryResult = await page.evaluate(async () => {
		const app = (window as any).app;
		if (!app) return { error: "app not found" };

		const basesPlugin = app.internalPlugins.plugins["bases"]?.instance;
		if (!basesPlugin) return { error: "bases plugin instance not found" };

		// Check getViewFactory
		let factoryInfo: any = {};
		if (typeof basesPlugin.getViewFactory === "function") {
			try {
				const factory = basesPlugin.getViewFactory("table");
				factoryInfo.tableFactory = {
					exists: !!factory,
					type: typeof factory,
					arity: factory?.length,
				};
			} catch (e: any) {
				factoryInfo.tableFactoryError = e.message;
			}
		}

		// Check getRegistrations
		if (typeof basesPlugin.getRegistrations === "function") {
			try {
				const registrations = basesPlugin.getRegistrations();
				factoryInfo.registrations = registrations ? Object.keys(registrations) : null;
			} catch (e: any) {
				factoryInfo.registrationsError = e.message;
			}
		}

		// Check getRegistration
		if (typeof basesPlugin.getRegistration === "function") {
			try {
				const reg = basesPlugin.getRegistration("table");
				factoryInfo.tableRegistration = reg ? {
					name: reg.name,
					icon: reg.icon,
					hasFactory: typeof reg.factory === "function",
					factoryArity: reg.factory?.length,
					keys: Object.keys(reg),
				} : null;
			} catch (e: any) {
				factoryInfo.tableRegistrationError = e.message;
			}
		}

		// Check registrations own property
		if (basesPlugin.registrations) {
			const regs = basesPlugin.registrations;
			factoryInfo.registrationsOwn = {
				type: typeof regs,
				isMap: regs instanceof Map,
				keys: regs instanceof Map ? [...regs.keys()] : Object.keys(regs),
			};
		}

		return factoryInfo;
	});

	console.log("Factory result:", JSON.stringify(factoryResult, null, 2));

	if (factoryResult.error) {
		ctx.fail("view-factory", factoryResult.error);
	} else {
		ctx.pass("view-factory", `Registrations: ${JSON.stringify(factoryResult.registrationsOwn?.keys ?? factoryResult.registrations)}`);
	}

	// Take final screenshot
	await ctx.screenshot("bases-api-discovery");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

runTest(
	{
		name: "bases-api-discovery",
		skipBuild: process.argv.includes("--skip-build"),
		setupVault,
		cleanupFiles: ["test-query.base", "bases-test-note.md"],
	},
	testBasesApiDiscovery,
);
