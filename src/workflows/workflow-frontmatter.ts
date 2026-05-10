import { TFile, TFolder, type App, type MetadataCache, type Vault, normalizePath } from "obsidian";
import { logger } from "../utils/logger";

const log = logger("workflow-auto-pickup");

export interface FrontmatterInjectionResult {
	injected: boolean;
	fieldsAdded: string[];
}

/**
 * Inject required workflow frontmatter fields into a file.
 * Adds missing fields only — does not overwrite existing values.
 */
export async function injectWorkflowFrontmatter(
	app: App,
	file: TFile,
	trigger: string,
	mode: string = "plan"
): Promise<FrontmatterInjectionResult> {
	const fieldsAdded: string[] = [];

	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (!fm["notor-type"] && fm["notor-workflow"] !== true) {
			fm["notor-type"] = "workflow";
			fieldsAdded.push("notor-type");
		}
		if (!fm["notor-trigger"]) {
			fm["notor-trigger"] = trigger;
			fieldsAdded.push("notor-trigger");
		}
		if (!fm["notor-conversation-mode"]) {
			fm["notor-conversation-mode"] = mode;
			fieldsAdded.push("notor-conversation-mode");
		}
	});

	return { injected: fieldsAdded.length > 0, fieldsAdded };
}

/**
 * Scan workflows/ directory recursively for .md files missing workflow
 * identification frontmatter, and inject defaults (manual trigger, plan mode).
 * Returns vault-relative paths of files that were injected.
 */
export async function autoInjectUnidentifiedWorkflows(
	app: App,
	vault: Vault,
	metadataCache: MetadataCache,
	notorDir: string
): Promise<string[]> {
	const workflowsPath = normalizePath(`${notorDir}/workflows`);
	const folder = vault.getAbstractFileByPath(workflowsPath);
	if (!folder || !(folder instanceof TFolder)) return [];

	const mdFiles = collectMarkdownFilesRecursive(folder);
	const injectedPaths: string[] = [];

	for (const file of mdFiles) {
		const cache = metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		const isIdentified = fm?.["notor-workflow"] === true || fm?.["notor-type"] === "workflow";
		if (isIdentified) continue;

		const result = await injectWorkflowFrontmatter(app, file, "manual", "plan");
		if (result.injected) {
			log.info("Auto-injected workflow frontmatter", {
				path: file.path,
				fieldsAdded: result.fieldsAdded,
			});
			injectedPaths.push(file.path);
		}
	}

	return injectedPaths;
}

function collectMarkdownFilesRecursive(folder: TFolder): TFile[] {
	const files: TFile[] = [];
	for (const child of folder.children) {
		if (child instanceof TFolder) {
			files.push(...collectMarkdownFilesRecursive(child));
		} else if (child instanceof TFile && child.name.endsWith(".md")) {
			files.push(child);
		}
	}
	return files;
}
