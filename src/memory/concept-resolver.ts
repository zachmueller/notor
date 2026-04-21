import type { App, Vault } from "obsidian";
import type { ExtensionUtils } from "../extensions/runtime-context";
import {
	serializeNote,
	parseNote,
	slugifyTitle,
	assertMemoryPath,
	extractJSON,
} from "./note-format";

export interface ResolveConceptArgs {
	insight: string;
	memoryDir: string;
	resolverProfile: string;
	app: App;
	runSubAgent: ExtensionUtils["runSubAgent"];
	vault: Vault;
}

export interface ResolveConceptResult {
	action: "created" | "updated" | "skipped";
	path?: string;
}

interface ResolverDirective {
	action: "update" | "create";
	path?: string;
	title?: string;
	merged_body: string;
	linked_titles?: string[];
}

export async function resolveConcept(
	args: ResolveConceptArgs,
): Promise<ResolveConceptResult> {
	const { insight, memoryDir, resolverProfile, app, runSubAgent, vault } = args;

	const result = await runSubAgent({
		profileName: resolverProfile,
		task: insight,
		detached: false,
	});

	if (!result) {
		return { action: "skipped" };
	}

	const extracted = extractJSON(result.text);
	if (!extracted || typeof extracted !== "object") {
		return { action: "skipped" };
	}
	const directive = extracted as ResolverDirective;

	if (!directive || !directive.action || !directive.merged_body) {
		return { action: "skipped" };
	}

	if (directive.action === "create") {
		const title = directive.title ?? "untitled";
		let slug = slugifyTitle(title);
		let filePath = `${memoryDir}/${slug}.md`;
		let suffix = 1;

		while (await app.vault.adapter.exists(filePath)) {
			suffix++;
			filePath = `${memoryDir}/${slug}-${suffix}.md`;
		}

		assertMemoryPath(filePath, memoryDir);

		const now = new Date().toISOString();
		const content = serializeNote({
			title,
			body: directive.merged_body,
			sources: ["chat"],
			createdAt: now,
		});

		await app.vault.adapter.write(filePath, content);
		return { action: "created", path: filePath };
	}

	if (directive.action === "update") {
		if (!directive.path) {
			return { action: "skipped" };
		}

		assertMemoryPath(directive.path, memoryDir);

		const file = app.vault.getAbstractFileByPath(directive.path);
		if (!file) {
			return { action: "skipped" };
		}

		const existing = await vault.read(file as import("obsidian").TFile);
		const parsed = parseNote(existing);

		const now = new Date().toISOString();
		const updatedSources = parsed.sources.includes("chat")
			? parsed.sources
			: [...parsed.sources, "chat"];

		const updated = serializeNote({
			title: parsed.title,
			body: directive.merged_body,
			sources: updatedSources,
			createdAt: parsed.createdAt || now,
		});

		await vault.modify(file as import("obsidian").TFile, updated);
		return { action: "updated", path: directive.path };
	}

	return { action: "skipped" };
}
