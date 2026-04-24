import { createHash } from "crypto";

export interface MemoryNote {
	title: string;
	body: string;
	createdAt: string;
	updatedAt: string;
	sources: string[];
}

export function serializeNote(args: {
	title: string;
	body: string;
	sources: string[];
	createdAt: string;
}): string {
	const now = new Date().toISOString();
	const sourcesYaml =
		args.sources.length > 0
			? `[${args.sources.join(", ")}]`
			: "[]";
	return [
		"---",
		"notor-type: memory",
		`notor-created-at: ${args.createdAt}`,
		`notor-updated-at: ${now}`,
		`notor-sources: ${sourcesYaml}`,
		"---",
		"",
		`# ${args.title}`,
		"",
		args.body,
		"",
	].join("\n");
}

export function parseNote(markdown: string): MemoryNote {
	const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!fmMatch) {
		return {
			title: "",
			body: markdown.trim(),
			createdAt: "",
			updatedAt: "",
			sources: [],
		};
	}

	const frontmatter = fmMatch[1]!;
	const rest = fmMatch[2]!;

	const createdAt = extractField(frontmatter, "notor-created-at") ?? "";
	const updatedAt = extractField(frontmatter, "notor-updated-at") ?? "";
	const sources = extractArrayField(frontmatter, "notor-sources");

	const titleMatch = rest.match(/^#\s+(.+)$/m);
	const title = titleMatch ? titleMatch[1]!.trim() : "";

	const bodyStart = titleMatch
		? rest.indexOf(titleMatch[0]) + titleMatch[0].length
		: 0;
	const body = rest.slice(bodyStart).trim();

	return { title, body, createdAt, updatedAt, sources };
}

// ---------------------------------------------------------------------------
// Pending memory notes
// ---------------------------------------------------------------------------

export interface PendingMemoryNote extends MemoryNote {
	approvalState: "pending";
	/** Whether this note will create a new memory or update an existing one. */
	originalAction: "create" | "update";
	/**
	 * Vault-relative path of the live memory note being updated (updates only).
	 * Stored as an Obsidian wikilink (e.g. `[[notor/memory/slug]]`) so vault
	 * renames propagate automatically via Obsidian's link-update machinery.
	 */
	targetPath?: string;
}

export function serializePendingNote(note: PendingMemoryNote): string {
	const now = new Date().toISOString();
	const sourcesYaml =
		note.sources.length > 0 ? `[${note.sources.join(", ")}]` : "[]";
	const lines = [
		"---",
		"notor-type: pending-memory",
		`notor-created-at: ${note.createdAt}`,
		`notor-updated-at: ${now}`,
		`notor-sources: ${sourcesYaml}`,
		"notor-approval-state: pending",
		`notor-original-action: ${note.originalAction}`,
	];
	if (note.targetPath) {
		lines.push(`notor-target-path: "[[${note.targetPath}]]"`);
	}
	lines.push("---", "", `# ${note.title}`, "", note.body, "");
	return lines.join("\n");
}

export function parsePendingNote(markdown: string): PendingMemoryNote {
	const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!fmMatch) {
		return {
			title: "",
			body: markdown.trim(),
			createdAt: "",
			updatedAt: "",
			sources: [],
			approvalState: "pending",
			originalAction: "create",
		};
	}

	const frontmatter = fmMatch[1]!;
	const rest = fmMatch[2]!;

	const createdAt = extractField(frontmatter, "notor-created-at") ?? "";
	const updatedAt = extractField(frontmatter, "notor-updated-at") ?? "";
	const sources = extractArrayField(frontmatter, "notor-sources");
	const originalAction =
		(extractField(frontmatter, "notor-original-action") as "create" | "update") ?? "create";
	const rawTargetPath = extractField(frontmatter, "notor-target-path");
	// Strip the wikilink delimiters: "[[notor/memory/slug]]" → "notor/memory/slug"
	const targetPath = rawTargetPath
		? rawTargetPath.replace(/^\s*"\s*\[\[/, "").replace(/\]\]\s*"\s*$/, "").trim() || undefined
		: undefined;

	const titleMatch = rest.match(/^#\s+(.+)$/m);
	const title = titleMatch ? titleMatch[1]!.trim() : "";
	const bodyStart = titleMatch ? rest.indexOf(titleMatch[0]) + titleMatch[0].length : 0;
	const body = rest.slice(bodyStart).trim();

	return { title, body, createdAt, updatedAt, sources, approvalState: "pending", originalAction, targetPath };
}

export function assertPendingMemoryPath(
	vaultRelativePath: string,
	pendingDir: string,
): void {
	if (!vaultRelativePath || !pendingDir) {
		throw new Error(`Invalid pending memory path: path and pendingDir must be non-empty`);
	}
	if (vaultRelativePath.startsWith("/")) {
		throw new Error(`Absolute paths are not allowed: ${vaultRelativePath}`);
	}
	const normalizedTarget = normalizVaultPath(vaultRelativePath);
	const normalizedPendingDir = normalizVaultPath(pendingDir);
	if (
		normalizedTarget !== normalizedPendingDir &&
		!normalizedTarget.startsWith(normalizedPendingDir + "/")
	) {
		throw new Error(
			`Path "${vaultRelativePath}" is outside pending memory directory "${pendingDir}"`,
		);
	}
}

export function slugifyTitle(title: string): string {
	return title
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 200);
}

export function computeFingerprint(content: string): string {
	const normalized = content.toLowerCase().trim().replace(/\s+/g, " ");
	return createHash("sha256").update(normalized).digest("hex");
}

export function assertMemoryPath(
	vaultRelativePath: string,
	memoryDir: string,
): void {
	if (!vaultRelativePath || !memoryDir) {
		throw new Error(`Invalid memory path: path and memoryDir must be non-empty`);
	}

	if (vaultRelativePath.startsWith("/")) {
		throw new Error(
			`Absolute paths are not allowed: ${vaultRelativePath}`,
		);
	}

	const normalizedTarget = normalizVaultPath(vaultRelativePath);
	const normalizedMemDir = normalizVaultPath(memoryDir);

	if (
		normalizedTarget !== normalizedMemDir &&
		!normalizedTarget.startsWith(normalizedMemDir + "/")
	) {
		throw new Error(
			`Path "${vaultRelativePath}" is outside memory directory "${memoryDir}"`,
		);
	}
}

function normalizVaultPath(p: string): string {
	const segments: string[] = [];
	for (const seg of p.replace(/\\/g, "/").split("/")) {
		if (seg === "..") segments.pop();
		else if (seg && seg !== ".") segments.push(seg);
	}
	return segments.join("/");
}

/**
 * Extract a JSON object from an LLM response that may contain surrounding text.
 * Tries `JSON.parse` on the full text first, then looks for a ```json code block,
 * then falls back to finding the first `{...}` balanced brace pair.
 */
export function extractJSON(text: string): unknown | null {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch { /* not pure JSON */ }

	const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
	if (codeBlockMatch) {
		try {
			return JSON.parse(codeBlockMatch[1]!.trim());
		} catch { /* invalid JSON in code block */ }
	}

	const firstBrace = trimmed.indexOf("{");
	if (firstBrace >= 0) {
		let depth = 0;
		for (let i = firstBrace; i < trimmed.length; i++) {
			if (trimmed[i] === "{") depth++;
			else if (trimmed[i] === "}") depth--;
			if (depth === 0) {
				try {
					return JSON.parse(trimmed.slice(firstBrace, i + 1));
				} catch { break; }
			}
		}
	}

	return null;
}

function extractField(frontmatter: string, key: string): string | null {
	const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
	const m = frontmatter.match(re);
	return m ? m[1]!.trim() : null;
}

function extractArrayField(frontmatter: string, key: string): string[] {
	const raw = extractField(frontmatter, key);
	if (!raw) return [];
	const inner = raw.replace(/^\[/, "").replace(/\]$/, "").trim();
	if (!inner) return [];
	return inner.split(",").map((s) => s.trim()).filter(Boolean);
}
