import type { BuilderContext, ExtensionUtils } from "./types";
import { resolveNote } from "../../utils/resolve-note";
import { resolveAndValidatePath, isPathWithin } from "../../utils/path-validation";
import { executeShellCommand } from "../../shell/shell-executor";
import { enforcePathConstraints } from "../../tool-config/path-enforcer";
import { TFolder, normalizePath } from "obsidian";

export function buildFileUtils(ctx: BuilderContext): Pick<ExtensionUtils,
	"resolveNote" | "resolveAndValidatePath" | "pathEnforcer" |
	"executeShellCommand" | "tempOutputSpiller" | "resolveNotorPath" |
	"readNote" | "ensureDirectoryExists"
> {
	const { plugin, vaultRootPath } = ctx;

	return {
		resolveNote: (path: string) =>
			resolveNote(path, plugin.app.vault, plugin.app.metadataCache),

		resolveAndValidatePath: (path: string, allowedPaths?: string[]) => {
			const baseAllowed = allowedPaths ?? (plugin.settings.user_shared_settings?.["read_file_allowed_paths"] as string[] | undefined) ?? [];
			const spillDir = plugin.getTempOutputSpiller()?.getSpillDir();
			const effectiveAllowed = spillDir ? [...baseAllowed, spillDir] : baseAllowed;
			return resolveAndValidatePath(path, vaultRootPath, effectiveAllowed);
		},

		executeShellCommand: (cmd, opts?) =>
			executeShellCommand(cmd, plugin.settings, opts),

		tempOutputSpiller: plugin.getTempOutputSpiller(),

		pathEnforcer: {
			enforcePathConstraints: (toolName, params, entry) =>
				enforcePathConstraints(toolName, params, entry, vaultRootPath, (path: string) => {
					const file = resolveNote(path, plugin.app.vault, plugin.app.metadataCache);
					return file?.path ?? null;
				}),

			isPathWithin: (target: string, base: string) =>
				isPathWithin(target, base),
		},

		resolveNotorPath: (subdir: string) =>
			normalizePath(`${plugin.settings.notor_dir}/${subdir}`),

		readNote: async (path: string) => {
			const file = resolveNote(path, plugin.app.vault, plugin.app.metadataCache);
			if (!file) {
				throw new Error(`Note not found: ${path}`);
			}
			return plugin.app.vault.read(file);
		},

		ensureDirectoryExists: async (filePath: string) => {
			const parts = filePath.split("/");
			parts.pop();
			if (parts.length === 0) return;
			let current = "";
			for (const part of parts) {
				current = current ? `${current}/${part}` : part;
				const existing = plugin.app.vault.getAbstractFileByPath(current);
				if (!existing) {
					await plugin.app.vault.createFolder(current);
				} else if (!(existing instanceof TFolder)) {
					throw new Error(`Cannot create directory: "${current}" already exists as a file`);
				}
			}
		},
	};
}
