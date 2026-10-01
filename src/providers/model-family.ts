/**
 * Claude model-ID parsing and nearest-sibling selection.
 *
 * Used to infer context-window metadata for Claude models that are not yet
 * in the static `MODEL_METADATA` table (e.g. a newly released Bedrock
 * inference profile). Parsing is deliberately conservative: anything that
 * doesn't look exactly like a Claude model ID returns null, so non-Claude
 * models never inherit Claude metadata.
 */

export type ClaudeFamily = "opus" | "sonnet" | "haiku" | "fable" | "mythos";

/** "direct": Anthropic API / Vertex ID. "bedrock": `anthropic.`-prefixed Bedrock ID. */
export type ClaudeIdShape = "direct" | "bedrock";

export interface ParsedClaudeId {
	family: ClaudeFamily;
	/** [major, minor]; minor is 0 when absent (e.g. `claude-opus-5`). */
	version: [number, number];
	shape: ClaudeIdShape;
	/** Lowercased geo prefix (`us`, `global`, `jp`, …) or null. */
	geo: string | null;
}

/** A known table entry, pre-parsed, offered as an inference candidate. */
export interface ClaudeCandidate<T> {
	id: string;
	parsed: ParsedClaudeId;
	value: T;
}

const MODERN_ID = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:-(\d{1,2}))?$/;
const LEGACY_ID = /^claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)$/;

/**
 * Parse a Claude model ID into family, version, shape and geo.
 *
 * Handles `us.anthropic.claude-opus-5-5`, `anthropic.claude-opus-5-5-v1:0`,
 * `claude-opus-5-5`, dated IDs (`claude-sonnet-4-20250514` → 4.0),
 * Vertex `@date` IDs, and legacy `claude-3-7-sonnet` naming.
 *
 * @returns the parsed ID, or null for anything that isn't a Claude model ID
 */
export function parseClaudeModelId(id: string): ParsedClaudeId | null {
	let s = id.trim().toLowerCase();
	let geo: string | null = null;
	let shape: ClaudeIdShape = "direct";

	const geoMatch = /^([a-z][a-z-]*)\.anthropic\./.exec(s);
	if (geoMatch) {
		geo = geoMatch[1] ?? null;
		s = s.slice(geoMatch[0].length);
		shape = "bedrock";
	} else if (s.startsWith("anthropic.")) {
		s = s.slice("anthropic.".length);
		shape = "bedrock";
	}

	// Strip the Bedrock version suffix first, then any date/alias suffix —
	// the date must go before parsing or it reads as the minor version.
	s = s.replace(/-v\d+(?::\d+)?$/, "");
	s = s.replace(/(?:-\d{8}|@\d{8}|-latest)$/, "");

	const modern = MODERN_ID.exec(s);
	if (modern) {
		return {
			family: modern[1] as ClaudeFamily,
			version: [Number(modern[2]), modern[3] !== undefined ? Number(modern[3]) : 0],
			shape,
			geo,
		};
	}

	const legacy = LEGACY_ID.exec(s);
	if (legacy) {
		return {
			family: legacy[3] as ClaudeFamily,
			version: [Number(legacy[1]), legacy[2] !== undefined ? Number(legacy[2]) : 0],
			shape,
			geo,
		};
	}

	return null;
}

/** Compare two versions: negative when a < b, 0 when equal, positive when a > b. */
export function compareClaudeVersions(a: [number, number], b: [number, number]): number {
	return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

/** Mythos shares Fable's limits, so the two are matched as one lineage. */
function lineage(family: ClaudeFamily): ClaudeFamily {
	return family === "mythos" ? "fable" : family;
}

/** Geo preference when several entries share the chosen version. */
function geoRank(candidateGeo: string | null, targetGeo: string | null): number {
	if (candidateGeo === targetGeo) return 0;
	if (candidateGeo === "global") return 1;
	if (candidateGeo === "us") return 2;
	return 3;
}

/**
 * Pick the nearest known sibling for a parsed Claude ID.
 *
 * Only considers candidates of the same lineage (family) and shape. Picks the
 * highest version ≤ the target, else the lowest version above it; ties are
 * broken by same geo, then `global`, then `us`, then ID.
 *
 * @returns the sibling plus `newerThanAll` (target version above every
 *   candidate in its lineage), or null when the lineage has no candidates
 */
export function pickNearestClaudeEntry<T>(
	target: ParsedClaudeId,
	candidates: Array<ClaudeCandidate<T>>
): { id: string; value: T; newerThanAll: boolean } | null {
	const pool = candidates.filter(
		(c) => lineage(c.parsed.family) === lineage(target.family) && c.parsed.shape === target.shape
	);
	if (pool.length === 0) return null;

	const atOrBelow = pool.filter((c) => compareClaudeVersions(c.parsed.version, target.version) <= 0);
	const versionPool = atOrBelow.length > 0 ? atOrBelow : pool;
	const pickHighest = atOrBelow.length > 0;

	let chosenVersion = versionPool[0]!.parsed.version;
	for (const c of versionPool) {
		const cmp = compareClaudeVersions(c.parsed.version, chosenVersion);
		if (pickHighest ? cmp > 0 : cmp < 0) chosenVersion = c.parsed.version;
	}

	const best = versionPool
		.filter((c) => compareClaudeVersions(c.parsed.version, chosenVersion) === 0)
		.sort((a, b) => geoRank(a.parsed.geo, target.geo) - geoRank(b.parsed.geo, target.geo) || a.id.localeCompare(b.id))[0]!;

	const newerThanAll = pool.every((c) => compareClaudeVersions(target.version, c.parsed.version) > 0);
	return { id: best.id, value: best.value, newerThanAll };
}
