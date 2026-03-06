/**
 * `list_vault` tool — directory listing with pagination, sorting, and metadata.
 *
 * Read-only tool available in both Plan and Act modes. Uses Obsidian vault
 * API to enumerate files and folders with type classification and metadata.
 *
 * @see specs/01-mvp/contracts/tool-schemas.md — list_vault schema
 * @see specs/01-mvp/spec.md — FR-11
 * @see design/tools.md — list_vault
 */

import { TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import type { Tool, ToolResult } from "./tool";
import { logger } from "../utils/logger";

const log = logger("ListVaultTool");

/** Type classification for a vault item. */
type ItemType = "note" | "folder" | "image" | "attachment";

/** A single item in the listing result. */
interface ListItem {
	name: string;
	path: string;
	type: ItemType;
	size?: number;
	modified?: string;
}

/** Structured result returned from list_vault. */
interface ListResult {
	path: string;
	total_count: number;
	items: ListItem[];
}

/** Image file extensions. */
const IMAGE_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "tif", "ico", "avif",
]);

/**
 * Implements the `list_vault` tool.
 *
 * Lists files and folders in the vault or a subdirectory. Results are
 * paginated and sorted by last_modified (newest first) or alphabetically.
 */
export class ListVaultTool implements Tool {
	readonly name = "list_vault";
	readonly mode = "read" as const;

	readonly description =
		"List the folder and note structure of the vault or a subdirectory. " +
		"Returns files and folders with type and basic metadata. Results are paginated.";

	readonly input_schema = {
		type: "object",
		properties: {
			path: {
				type: "string",
				description:
					"Directory to list, relative to vault root. Defaults to vault root.",
				default: "",
			},
			recursive: {
				type: "boolean",
				description: "Whether to list contents recursively. Defaults to false.",
				default: false,
			},
			limit: {
				type: "number",
				description: "Maximum number of items to return. Defaults to 50.",
				default: 50,
			},
			offset: {
				type: "number",
				description: "Number of items to skip for pagination. Defaults to 0.",
				default: 0,
			},
			sort_by: {
				type: "string",
				description:
					"Sort order: 'last_modified' (newest first) or 'alphabetical'. Defaults to 'last_modified'.",
				enum: ["last_modified", "alphabetical"],
				default: "last_modified",
			},
		},
		required: [],
	};

	constructor(private readonly app: App) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const listPath = ((params["path"] as string | undefined) ?? "").trim();
		const recursive = (params["recursive"] as boolean | undefined) ?? false;
		const limit = Math.max(
			1,
			Math.min(500, Math.floor((params["limit"] as number | undefined) ?? 50))
		);
		const offset = Math.max(0, Math.floor((params["offset"] as number | undefined) ?? 0));
		const sortBy = ((params["sort_by"] as string | undefined) ?? "last_modified") as
			| "last_modified"
			| "alphabetical";

		log.debug("Listing vault", { listPath, recursive, limit, offset, sortBy });

		// Collect all items in the target directory
		const allItems = this.collectItems(listPath, recursive);

		// Sort items
		const sorted = this.sortItems(allItems, sortBy);

		// Apply pagination
		const totalCount = sorted.length;
		const paginated = sorted.slice(offset, offset + limit);

		const result: ListResult = {
			path: listPath || "/",
			total_count: totalCount,
			items: paginated,
		};

		log.debug("List complete", {
			path: listPath,
			totalCount,
			returned: paginated.length,
		});

		return {
			tool_name: this.name,
			success: true,
			result: result as unknown as Record<string, unknown>,
		};
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/**
	 * Collect items from the target path.
	 *
	 * For non-recursive: returns only direct children of the target directory.
	 * For recursive: returns all descendants.
	 */
	private collectItems(targetPath: string, recursive: boolean): ListItem[] {
		const items: ListItem[] = [];

		if (!recursive) {
			// Non-recursive: get direct children only
			const folder = targetPath
				? this.app.vault.getAbstractFileByPath(targetPath)
				: this.app.vault.getRoot();

			if (!folder || !(folder instanceof TFolder)) {
				return [];
			}

			for (const child of folder.children) {
				items.push(this.toListItem(child as TFile | TFolder));
			}
		} else {
			// Recursive: walk all vault files and folders
			const normalizedTarget = targetPath
				? (targetPath.endsWith("/") ? targetPath : targetPath + "/")
				: "";

			// Add matching folders
			const allFolders = this.getAllFolders();
			for (const folder of allFolders) {
				if (folder.path === "/" || folder.path === "") continue; // skip root
				if (
					normalizedTarget === "" ||
					folder.path.startsWith(normalizedTarget) ||
					folder.path === targetPath
				) {
					items.push(this.toListItem(folder));
				}
			}

			// Add matching files
			const allFiles = this.app.vault.getFiles();
			for (const file of allFiles) {
				if (
					normalizedTarget === "" ||
					file.path.startsWith(normalizedTarget) ||
					file.path === targetPath
				) {
					items.push(this.toListItem(file));
				}
			}
		}

		return items;
	}

	/**
	 * Get all TFolder instances in the vault.
	 */
	private getAllFolders(): TFolder[] {
		const folders: TFolder[] = [];
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					folders.push(child);
					walk(child);
				}
			}
		};
		walk(this.app.vault.getRoot());
		return folders;
	}

	/**
	 * Convert a vault abstract file to a ListItem.
	 */
	private toListItem(abstractFile: TFile | TFolder): ListItem {
		if (abstractFile instanceof TFolder) {
			return {
				name: abstractFile.name,
				path: abstractFile.path,
				type: "folder",
			};
		}

		const file = abstractFile as TFile;
		return {
			name: file.name,
			path: file.path,
			type: this.classifyFile(file),
			size: file.stat.size,
			modified: new Date(file.stat.mtime).toISOString(),
		};
	}

	/**
	 * Classify a file as note, image, or attachment.
	 */
	private classifyFile(file: TFile): ItemType {
		const ext = file.extension.toLowerCase();
		if (ext === "md") return "note";
		if (IMAGE_EXTENSIONS.has(ext)) return "image";
		return "attachment";
	}

	/**
	 * Sort items by the specified sort order.
	 *
	 * Folders always sort before files in alphabetical mode.
	 * In last_modified mode, folders (no mtime) sort after files.
	 */
	private sortItems(
		items: ListItem[],
		sortBy: "last_modified" | "alphabetical"
	): ListItem[] {
		return [...items].sort((a, b) => {
			if (sortBy === "alphabetical") {
				// Folders before files
				if (a.type === "folder" && b.type !== "folder") return -1;
				if (a.type !== "folder" && b.type === "folder") return 1;
				return a.path.localeCompare(b.path);
			}

			// last_modified: newest first; folders go last (no mtime)
			const aTime = a.modified ? new Date(a.modified).getTime() : 0;
			const bTime = b.modified ? new Date(b.modified).getTime() : 0;
			return bTime - aTime;
		});
	}
}