import { TFile, type App } from "obsidian";

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
