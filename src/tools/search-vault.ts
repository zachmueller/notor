/**
 * `search_vault` tool — regex/text search across vault notes with context lines.
 *
 * Read-only tool available in both Plan and Act modes. Enumerates vault
 * files via Obsidian API, searches line-by-line, and returns matches grouped
 * by file with surrounding context.
 *
 * @see specs/01-mvp/contracts/tool-schemas.md — search_vault schema
 * @see specs/01-mvp/spec.md — FR-10
 * @see design/tools.md — search_vault
 */

import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { Tool, ToolResult } from "./tool";
import { logger } from "../utils/logger";

const log = logger("SearchVaultTool");

/** A single match within a file. */
interface MatchResult {
	line: number;
	match: string;
	context: string;
}

/** Search results grouped by file. */
interface FileResult {
	path: string;
	matches: MatchResult[];
	match_count: number;
	backlink_count: number;
	modified: string;
}

/** Structured result returned from search_vault. */
interface SearchResult {
	total_matches: number;
	files: FileResult[];
}

/**
 * Implements the `search_vault` tool.
 *
 * Searches vault notes using regex or literal text patterns. Results are
 * grouped by file with line numbers and surrounding context.
 *
 * Performance: reads each matching file individually. For large vaults
 * (10,000+ notes) this may take a few seconds, which is acceptable per NFR-1.
 */
export class SearchVaultTool implements Tool {
	readonly name = "search_vault";
	readonly mode = "read" as const;

	readonly description =
		"Search across notes in the vault using regex or text patterns, returning matches " +
		"with surrounding context lines. Results are grouped by file with line numbers. " +
		"Results can be sorted by match count (default), backlink count (to find hub/authoritative notes), " +
		"or last modified time. Each result includes match_count, backlink_count, and modified metadata.";

	readonly input_schema = {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "Regex pattern or text string to search for",
			},
			path: {
				type: "string",
				description:
					"Directory to search within, relative to vault root. Defaults to vault root.",
				default: "",
			},
			context_lines: {
				type: "number",
				description:
					"Number of surrounding lines to include with each match. Defaults to 3.",
				default: 3,
			},
			file_pattern: {
				type: "string",
				description:
					"Glob pattern to filter which files to search. Defaults to '*.md'.",
				default: "*.md",
			},
			sort_by: {
				type: "string",
				description:
					"Sort order for result files: 'match_count' (most matches first, default), " +
					"'backlinks' (most backlinks first), or 'modified' (most recently edited first).",
				enum: ["match_count", "backlinks", "modified"],
				default: "match_count",
			},
		},
		required: ["query"],
	};

	constructor(private readonly app: App) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const query = params["query"] as string;
		const searchPath = ((params["path"] as string | undefined) ?? "").trim();
		const contextLines = Math.max(
			0,
			Math.min(10, Math.floor((params["context_lines"] as number | undefined) ?? 3))
		);
		const filePattern = ((params["file_pattern"] as string | undefined) ?? "*.md").trim();
		const sortBy = ((params["sort_by"] as string | undefined) ?? "match_count") as
			| "match_count"
			| "backlinks"
			| "modified";

		if (!query || typeof query !== "string") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: query",
			};
		}

		// Compile regex — treat as literal string if not valid regex
		let regex: RegExp;
		try {
			regex = new RegExp(query, "gm");
		} catch (e) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Invalid search pattern: ${e instanceof Error ? e.message : String(e)}`,
			};
		}

		log.debug("Searching vault", { query, searchPath, contextLines, filePattern });

		// Collect candidate files
		const candidates = this.getCandidateFiles(searchPath, filePattern);

		const fileResults: FileResult[] = [];
		let totalMatches = 0;

		// Build backlink counts once (O(n) in-memory pass over resolvedLinks)
		const backlinkCounts = this.getBacklinkCounts();

		for (const file of candidates) {
			try {
				const content = await this.app.vault.cachedRead(file);
				const matches = this.searchFile(content, regex, contextLines);

				if (matches.length > 0) {
					fileResults.push({
						path: file.path,
						matches,
						match_count: matches.length,
						backlink_count: backlinkCounts.get(file.path) ?? 0,
						modified: new Date(file.stat.mtime).toISOString(),
					});
					totalMatches += matches.length;
				}
			} catch (e) {
				// Skip files that can't be read (binary, permission issues, etc.)
				log.debug("Skipping unreadable file", {
					path: file.path,
					error: e instanceof Error ? e.message : String(e),
				});
			}

			// Reset regex lastIndex between files (stateful with /g flag)
			regex.lastIndex = 0;
		}

		// Sort results by the selected field
		const sortedResults = this.sortFileResults(fileResults, sortBy);

		log.debug("Search complete", {
			query,
			totalMatches,
			filesSearched: candidates.length,
			filesWithMatches: sortedResults.length,
		});

		const result: SearchResult = {
			total_matches: totalMatches,
			files: sortedResults,
		};

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
	 * Get all vault files matching the path prefix and file pattern.
	 */
	private getCandidateFiles(searchPath: string, filePattern: string): TFile[] {
		const allFiles = this.app.vault.getFiles();

		return allFiles.filter((file) => {
			// Path prefix filter
			if (searchPath) {
				const normalizedPath = searchPath.endsWith("/")
					? searchPath
					: searchPath + "/";
				if (!file.path.startsWith(normalizedPath) && file.path !== searchPath) {
					return false;
				}
			}

			// File pattern filter (simple glob: supports * wildcard and extension matching)
			if (filePattern && filePattern !== "*") {
				if (!this.matchesGlob(file.name, filePattern)) {
					return false;
				}
			}

			return true;
		});
	}

	/**
	 * Simple glob matcher supporting `*` wildcard and `*.ext` patterns.
	 * Not a full glob implementation — handles the common `*.md` case.
	 */
	private matchesGlob(filename: string, pattern: string): boolean {
		// Convert glob to regex: escape dots, replace * with .*
		const regexStr = pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape special chars except *
			.replace(/\*/g, ".*");
		try {
			return new RegExp(`^${regexStr}$`, "i").test(filename);
		} catch {
			// Fallback: exact match
			return filename === pattern;
		}
	}

	/**
	 * Build a map of file path → backlink count from Obsidian's resolved links.
	 * O(n) in-memory pass — no disk I/O.
	 */
	private getBacklinkCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const [sourcePath, links] of Object.entries(
			this.app.metadataCache.resolvedLinks
		)) {
			for (const targetPath of Object.keys(links)) {
				if (targetPath !== sourcePath) {
					counts.set(targetPath, (counts.get(targetPath) ?? 0) + 1);
				}
			}
		}
		return counts;
	}

	/**
	 * Sort file results by the specified field, descending.
	 */
	private sortFileResults(
		results: FileResult[],
		sortBy: "match_count" | "backlinks" | "modified"
	): FileResult[] {
		return [...results].sort((a, b) => {
			switch (sortBy) {
				case "backlinks":
					return b.backlink_count - a.backlink_count;
				case "modified":
					return new Date(b.modified).getTime() - new Date(a.modified).getTime();
				case "match_count":
				default:
					return b.match_count - a.match_count;
			}
		});
	}

	/**
	 * Search a file's content for matches, returning results with context.
	 */
	private searchFile(content: string, regex: RegExp, contextLines: number): MatchResult[] {
		const lines = content.split("\n");
		const matches: MatchResult[] = [];
		// Track which lines already have a match (to avoid duplicate context)
		const matchedLineNumbers = new Set<number>();

		for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
			const line = lines[lineIndex] ?? "";

			// Reset regex for each line test (stateful with /g)
			regex.lastIndex = 0;

			if (regex.test(line)) {
				if (matchedLineNumbers.has(lineIndex)) continue;
				matchedLineNumbers.add(lineIndex);

				// Build context: lines before and after
				const contextStart = Math.max(0, lineIndex - contextLines);
				const contextEnd = Math.min(lines.length - 1, lineIndex + contextLines);

				const contextParts: string[] = [];
				for (let ci = contextStart; ci <= contextEnd; ci++) {
					const prefix = ci === lineIndex ? ">" : " ";
					contextParts.push(`${prefix} ${(lines[ci] ?? "")}`);
				}

				matches.push({
					line: lineIndex + 1, // 1-based line numbers
					match: line.trim(),
					context: contextParts.join("\n"),
				});
			}
		}

		return matches;
	}
}