#!/usr/bin/env npx tsx
/**
 * Templates Integration E2E Test
 *
 * Validates the list_templates and apply_template tool scaffolds:
 *   - Feature group gating (tools excluded when templates_enabled = false)
 *   - Tool registration when feature group is enabled
 *   - list_templates: folder detection, file listing, prompt/suggester regex scanning
 *   - apply_template: monkey-patch execution, prompt interception, suggester interception
 *   - apply_template: core Templates fallback ({{date}}, {{time}}, {{title}} substitution)
 *   - Error handling: missing template, exhausted queues, unused answers
 *
 * Scenarios:
 *   1. Feature group disabled → tools not registered
 *   2. Feature group enabled → tools registered
 *   3. list_templates returns template folder info and file list
 *   4. list_templates detects prompt/suggester patterns in templates
 *   5. apply_template with Templater: prompt interception works
 *   6. apply_template with Templater: suggester interception works
 *   7. apply_template with Templater: mixed prompt + suggester
 *   8. apply_template error: template not found
 *   9. apply_template: unused answers produce warning
 *  10. Core Templates fallback: {{date}}/{{time}}/{{title}} substitution
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
// Vault setup
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

	// Templater settings
	const templaterSettings = {
		command_timeout: 5,
		templates_folder: TEMPLATES_FOLDER,
		templates_pairs: [["", ""]],
		trigger_on_file_creation: false,
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

	// 3. Create test templates
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

	// Template with prompts
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

	// Core-only template (no Templater syntax)
	fs.writeFileSync(
		path.join(templatesDir, "core-template.md"),
		`---
created: "{{date}}"
---
# {{title}}
Created at {{time}}.
`,
	);

	// 4. Write workspace.json
	writeCleanWorkspace(vaultPath);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testFeatureGroupDisabled(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Feature group disabled → tools not registered");
	const { page } = ctx;

	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Notor plugin not found" };

		const registry = plugin.getToolRegistry();
		return {
			hasListTemplates: registry.has("list_templates"),
			hasApplyTemplate: registry.has("apply_template"),
			templatesEnabled: plugin.settings.templates_enabled,
		};
	});

	if ("error" in result) {
		ctx.fail("feature-group-disabled", result.error);
		return;
	}

	if (result.templatesEnabled) {
		ctx.fail("feature-group-disabled", "templates_enabled should be false by default");
		return;
	}

	if (result.hasListTemplates || result.hasApplyTemplate) {
		ctx.fail("feature-group-disabled", `Tools registered despite disabled feature group: list=${result.hasListTemplates}, apply=${result.hasApplyTemplate}`);
	} else {
		ctx.pass("feature-group-disabled", "Neither template tool registered when feature group is disabled");
	}
}

async function testFeatureGroupEnabled(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Feature group enabled → tools registered");
	const { page } = ctx;

	// Enable the feature group and reload extensions
	const enableResult = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Notor plugin not found" };

		plugin.settings.templates_enabled = true;
		await plugin.saveSettings();

		const manager = plugin.getExtensionManager();
		await manager.reload(false);

		const registry = plugin.getToolRegistry();
		return {
			hasListTemplates: registry.has("list_templates"),
			hasApplyTemplate: registry.has("apply_template"),
		};
	});

	if ("error" in enableResult) {
		ctx.fail("feature-group-enabled", enableResult.error);
		return;
	}

	if (enableResult.hasListTemplates && enableResult.hasApplyTemplate) {
		ctx.pass("feature-group-enabled", "Both template tools registered after enabling feature group");
	} else {
		ctx.fail("feature-group-enabled", `Missing tools after enable: list=${enableResult.hasListTemplates}, apply=${enableResult.hasApplyTemplate}`);
	}
}

async function testListTemplatesBasic(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: list_templates returns template folder info and file list");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Notor plugin not found" };

		const registry = plugin.getToolRegistry();
		const tool = registry.get("list_templates");
		if (!tool) return { error: "list_templates tool not registered" };
		try {
			const toolResult = await tool.execute({ detect_prompts: false });
			return { success: true, result: toolResult.success ? toolResult.result : toolResult.error };
		} catch (err: any) {
			return { error: err.message };
		}
	});

	if ("error" in result) {
		ctx.fail("list-templates-basic", `Tool execution failed: ${result.error}`);
		return;
	}

	try {
		const parsed = JSON.parse(result.result as string);
		if (parsed.engine !== "templater") {
			ctx.fail("list-templates-basic", `Expected engine 'templater', got '${parsed.engine}'`);
			return;
		}
		if (parsed.template_folder !== TEMPLATES_FOLDER) {
			ctx.fail("list-templates-basic", `Expected folder '${TEMPLATES_FOLDER}', got '${parsed.template_folder}'`);
			return;
		}
		if (!Array.isArray(parsed.templates) || parsed.templates.length < 4) {
			ctx.fail("list-templates-basic", `Expected at least 4 templates, got ${parsed.templates?.length ?? 0}`);
			return;
		}

		const names = parsed.templates.map((t: any) => t.name);
		const hasExpected = ["simple-template", "prompt-template", "suggester-template", "mixed-template"]
			.every((n) => names.includes(n));

		if (hasExpected) {
			ctx.pass("list-templates-basic", `Found ${parsed.templates.length} templates in '${parsed.template_folder}' (engine: ${parsed.engine})`);
		} else {
			ctx.fail("list-templates-basic", `Missing expected templates. Got: ${names.join(", ")}`);
		}
	} catch (err: any) {
		ctx.fail("list-templates-basic", `Failed to parse result: ${err.message}`);
	}
}

async function testListTemplatesPromptDetection(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: list_templates detects prompt/suggester patterns");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Notor plugin not found" };

		const registry = plugin.getToolRegistry();
		const tool = registry.get("list_templates");
		if (!tool) return { error: "list_templates tool not registered" };
		try {
			const toolResult = await tool.execute({ detect_prompts: true });
			return { success: true, result: toolResult.success ? toolResult.result : toolResult.error };
		} catch (err: any) {
			return { error: err.message };
		}
	});

	if ("error" in result) {
		ctx.fail("list-templates-prompt-detection", `Tool execution failed: ${result.error}`);
		return;
	}

	try {
		const parsed = JSON.parse(result.result as string);
		const promptTemplate = parsed.templates.find((t: any) => t.name === "prompt-template");
		const suggesterTemplate = parsed.templates.find((t: any) => t.name === "suggester-template");
		const mixedTemplate = parsed.templates.find((t: any) => t.name === "mixed-template");
		const simpleTemplate = parsed.templates.find((t: any) => t.name === "simple-template");

		const issues: string[] = [];

		// prompt-template should have 2 prompts
		if (!promptTemplate?.prompts || promptTemplate.prompts.length !== 2) {
			issues.push(`prompt-template: expected 2 prompts, got ${promptTemplate?.prompts?.length ?? 0}`);
		} else {
			if (promptTemplate.prompts[0].type !== "prompt") issues.push("prompt-template[0] type mismatch");
			if (promptTemplate.prompts[0].label !== "Enter note title") issues.push(`prompt-template[0] label: "${promptTemplate.prompts[0].label}"`);
			if (promptTemplate.prompts[1].label !== "Enter author name") issues.push(`prompt-template[1] label: "${promptTemplate.prompts[1].label}"`);
		}

		// suggester-template should have 1 suggester
		if (!suggesterTemplate?.prompts || suggesterTemplate.prompts.length !== 1) {
			issues.push(`suggester-template: expected 1 prompt entry, got ${suggesterTemplate?.prompts?.length ?? 0}`);
		} else {
			if (suggesterTemplate.prompts[0].type !== "suggester") issues.push("suggester-template[0] type mismatch");
			if (!suggesterTemplate.prompts[0].options_preview?.includes("Meeting")) {
				issues.push("suggester-template[0] missing 'Meeting' in options_preview");
			}
		}

		// mixed-template should have 3 entries (prompt, suggester, prompt)
		if (!mixedTemplate?.prompts || mixedTemplate.prompts.length !== 3) {
			issues.push(`mixed-template: expected 3 entries, got ${mixedTemplate?.prompts?.length ?? 0}`);
		} else {
			if (mixedTemplate.prompts[0].type !== "prompt") issues.push("mixed[0] should be prompt");
			if (mixedTemplate.prompts[1].type !== "suggester") issues.push("mixed[1] should be suggester");
			if (mixedTemplate.prompts[2].type !== "prompt") issues.push("mixed[2] should be prompt");
		}

		// simple-template should have no prompts
		if (simpleTemplate?.prompts) {
			issues.push(`simple-template: should have no prompts, got ${simpleTemplate.prompts.length}`);
		}

		if (issues.length === 0) {
			ctx.pass("list-templates-prompt-detection", "All prompt/suggester patterns detected correctly across templates");
		} else {
			ctx.fail("list-templates-prompt-detection", `Issues: ${issues.join("; ")}`);
		}
	} catch (err: any) {
		ctx.fail("list-templates-prompt-detection", `Failed to parse result: ${err.message}`);
	}
}

async function testApplyTemplatePrompts(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: apply_template with Templater prompt interception");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Notor plugin not found" };

		const registry = plugin.getToolRegistry();
		const tool = registry.get("apply_template");
		if (!tool) return { error: "apply_template tool not registered" };
		try {
			const toolResult = await tool.execute({
				template_path: "templates/prompt-template.md",
				output_folder: "",
				output_filename: "test-prompt-output",
				prompt_answers: ["My Test Title", "Test Author"],
				suggester_answers: [],
			});
			return { success: true, result: toolResult.success ? toolResult.result : toolResult.error };
		} catch (err: any) {
			return { error: err.message };
		}
	});

	if ("error" in result) {
		ctx.fail("apply-template-prompts", `Execution failed: ${result.error}`);
		return;
	}

	const resultStr = result.result as string;
	if (!resultStr.includes("Template applied successfully")) {
		ctx.fail("apply-template-prompts", `Unexpected result: ${resultStr}`);
		return;
	}

	// Verify the output file was created with correct content
	const fileCheck = await page.evaluate(async () => {
		const app = (window as any).app;
		const file = app.vault.getAbstractFileByPath("test-prompt-output.md");
		if (!file) return { error: "Output file not created" };
		const content = await app.vault.read(file);
		return { content };
	});

	if ("error" in fileCheck) {
		ctx.fail("apply-template-prompts", fileCheck.error);
		return;
	}

	const content = fileCheck.content as string;
	if (content.includes("My Test Title") && content.includes("Test Author")) {
		ctx.pass("apply-template-prompts", "Prompt answers correctly substituted into output note");
	} else {
		ctx.fail("apply-template-prompts", `Expected 'My Test Title' and 'Test Author' in content, got: ${content.substring(0, 200)}`);
	}
}

async function testApplyTemplateSuggester(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: apply_template with Templater suggester interception");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Notor plugin not found" };

		const registry = plugin.getToolRegistry();
		const tool = registry.get("apply_template");
		if (!tool) return { error: "apply_template tool not registered" };
		try {
			const toolResult = await tool.execute({
				template_path: "templates/suggester-template.md",
				output_folder: "",
				output_filename: "test-suggester-output",
				prompt_answers: [],
				suggester_answers: ["Project"],
			});
			return { success: true, result: toolResult.success ? toolResult.result : toolResult.error };
		} catch (err: any) {
			return { error: err.message };
		}
	});

	if ("error" in result) {
		ctx.fail("apply-template-suggester", `Execution failed: ${result.error}`);
		return;
	}

	// Verify the output: "Project" display label should resolve to "project" value
	const fileCheck = await page.evaluate(async () => {
		const app = (window as any).app;
		const file = app.vault.getAbstractFileByPath("test-suggester-output.md");
		if (!file) return { error: "Output file not created" };
		const content = await app.vault.read(file);
		return { content };
	});

	if ("error" in fileCheck) {
		ctx.fail("apply-template-suggester", fileCheck.error);
		return;
	}

	const content = fileCheck.content as string;
	if (content.includes("project")) {
		ctx.pass("apply-template-suggester", "Suggester display label 'Project' resolved to value 'project'");
	} else {
		ctx.fail("apply-template-suggester", `Expected 'project' in frontmatter, got: ${content.substring(0, 200)}`);
	}
}

async function testApplyTemplateMixed(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: apply_template with mixed prompt + suggester");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Notor plugin not found" };

		const registry = plugin.getToolRegistry();
		const tool = registry.get("apply_template");
		if (!tool) return { error: "apply_template tool not registered" };
		try {
			const toolResult = await tool.execute({
				template_path: "templates/mixed-template.md",
				output_folder: "",
				output_filename: "test-mixed-output",
				prompt_answers: ["Mixed Title", "A description here"],
				suggester_answers: ["Beta"],
			});
			return { success: true, result: toolResult.success ? toolResult.result : toolResult.error };
		} catch (err: any) {
			return { error: err.message };
		}
	});

	if ("error" in result) {
		ctx.fail("apply-template-mixed", `Execution failed: ${result.error}`);
		return;
	}

	const fileCheck = await page.evaluate(async () => {
		const app = (window as any).app;
		const file = app.vault.getAbstractFileByPath("test-mixed-output.md");
		if (!file) return { error: "Output file not created" };
		const content = await app.vault.read(file);
		return { content };
	});

	if ("error" in fileCheck) {
		ctx.fail("apply-template-mixed", fileCheck.error);
		return;
	}

	const content = fileCheck.content as string;
	const hasTitle = content.includes("Mixed Title");
	const hasSuggester = content.includes("b"); // "Beta" maps to value "b"
	const hasDescription = content.includes("A description here");

	if (hasTitle && hasSuggester && hasDescription) {
		ctx.pass("apply-template-mixed", "All prompt and suggester answers correctly applied in mixed template");
	} else {
		ctx.fail("apply-template-mixed", `Missing expected content: title=${hasTitle}, suggester=${hasSuggester}, desc=${hasDescription}. Content: ${content.substring(0, 300)}`);
	}
}

async function testApplyTemplateNotFound(ctx: TestContext): Promise<void> {
	console.log("\nTest 8: apply_template error — template not found");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Notor plugin not found" };

		const registry = plugin.getToolRegistry();
		const tool = registry.get("apply_template");
		if (!tool) return { error: "apply_template tool not registered" };
		try {
			const toolResult = await tool.execute({
				template_path: "templates/nonexistent-template.md",
				prompt_answers: [],
				suggester_answers: [],
			});
			return { success: true, result: toolResult.success ? toolResult.result : toolResult.error };
		} catch (err: any) {
			return { error: err.message };
		}
	});

	const resultStr = String(result.error ?? result.result ?? "");
	if (resultStr.toLowerCase().includes("not found") || resultStr.toLowerCase().includes("template")) {
		ctx.pass("apply-template-not-found", `Correct error response: ${resultStr.substring(0, 120)}`);
	} else {
		ctx.fail("apply-template-not-found", `Expected 'not found' error, got: ${resultStr.substring(0, 120)}`);
	}
}

async function testApplyTemplateUnusedAnswers(ctx: TestContext): Promise<void> {
	console.log("\nTest 9: apply_template — unused answers produce warning");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Notor plugin not found" };

		const registry = plugin.getToolRegistry();
		const tool = registry.get("apply_template");
		if (!tool) return { error: "apply_template tool not registered" };
		try {
			// Supply 5 prompt answers for a template that only uses 2
			const toolResult = await tool.execute({
				template_path: "templates/prompt-template.md",
				output_folder: "",
				output_filename: "test-unused-answers",
				prompt_answers: ["Title", "Author", "Extra1", "Extra2", "Extra3"],
				suggester_answers: ["UnusedSuggester"],
			});
			return { success: true, result: toolResult.success ? toolResult.result : toolResult.error };
		} catch (err: any) {
			return { error: err.message };
		}
	});

	if ("error" in result) {
		ctx.fail("apply-template-unused-answers", `Unexpected error: ${result.error}`);
		return;
	}

	const resultStr = result.result as string;
	if (resultStr.includes("unused") || resultStr.includes("Warnings")) {
		ctx.pass("apply-template-unused-answers", "Warning about unused answers present in result");
	} else {
		ctx.fail("apply-template-unused-answers", `Expected warning about unused answers. Result: ${resultStr.substring(0, 200)}`);
	}
}

async function testCoreTemplatesFallback(ctx: TestContext): Promise<void> {
	console.log("\nTest 10: Core Templates fallback — {{date}}/{{time}}/{{title}} substitution");
	const { page } = ctx;

	// Simulate core-only path by testing the substitution logic directly
	// We'll execute apply_template on a non-Templater template with Templater temporarily disabled
	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Notor plugin not found" };
		const app = (window as any).app;

		// Temporarily hide Templater to test fallback path
		const templater = app.plugins.plugins["templater-obsidian"];
		delete app.plugins.plugins["templater-obsidian"];

		const registry = plugin.getToolRegistry();
		const tool = registry.get("apply_template");
		if (!tool) return { error: "apply_template tool not registered" };
		try {
			const toolResult = await tool.execute({
				template_path: "templates/core-template.md",
				output_folder: "",
				output_filename: "test-core-output",
				prompt_answers: [],
				suggester_answers: [],
			});
			return { success: true, result: toolResult.success ? toolResult.result : toolResult.error };
		} catch (err: any) {
			return { error: err.message };
		} finally {
			// Restore Templater
			app.plugins.plugins["templater-obsidian"] = templater;
		}
	});

	if ("error" in result) {
		ctx.fail("core-templates-fallback", `Execution failed: ${result.error}`);
		return;
	}

	const fileCheck = await page.evaluate(async () => {
		const app = (window as any).app;
		const file = app.vault.getAbstractFileByPath("test-core-output.md");
		if (!file) return { error: "Output file not created" };
		const content = await app.vault.read(file);
		return { content };
	});

	if ("error" in fileCheck) {
		ctx.fail("core-templates-fallback", fileCheck.error);
		return;
	}

	const content = fileCheck.content as string;
	const today = new Date().toISOString().split("T")[0];
	const hasDate = content.includes(today);
	const hasTitle = content.includes("test-core-output");
	const noPlaceholders = !content.includes("{{date}}") && !content.includes("{{title}}") && !content.includes("{{time}}");

	if (hasDate && hasTitle && noPlaceholders) {
		ctx.pass("core-templates-fallback", `Placeholders resolved: date=${today}, title=test-core-output`);
	} else {
		ctx.fail("core-templates-fallback", `Substitution incomplete: hasDate=${hasDate}, hasTitle=${hasTitle}, noPlaceholders=${noPlaceholders}. Content: ${content.substring(0, 200)}`);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // Wait for plugin + Templater init

	// Verify Templater is loaded
	const templaterReady = await page.evaluate(() => {
		const tp = (window as any).app?.plugins?.plugins?.["templater-obsidian"];
		return {
			loaded: !!tp,
			hasTemplater: !!tp?.templater,
			version: tp?.manifest?.version,
		};
	});
	console.log(`Templater status: loaded=${templaterReady.loaded}, version=${templaterReady.version}`);

	if (!templaterReady.loaded || !templaterReady.hasTemplater) {
		ctx.fail("templater-prerequisite", "Templater plugin not loaded — cannot run template integration tests");
		return;
	}

	await testFeatureGroupDisabled(ctx);
	await testFeatureGroupEnabled(ctx);
	await testListTemplatesBasic(ctx);
	await testListTemplatesPromptDetection(ctx);
	await testApplyTemplatePrompts(ctx);
	await testApplyTemplateSuggester(ctx);
	await testApplyTemplateMixed(ctx);
	await testApplyTemplateNotFound(ctx);
	await testApplyTemplateUnusedAnswers(ctx);
	await testCoreTemplatesFallback(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	templates_enabled: false, // Start disabled, test enables it
	templates_apply_timeout: 30,
});

runTest(
	{
		name: "templates-integration",
		settings,
		setupVault,
		cleanupFiles: [
			"templates/",
			"test-prompt-output.md",
			"test-suggester-output.md",
			"test-mixed-output.md",
			"test-unused-answers.md",
			"test-core-output.md",
		],
	},
	tests,
);
