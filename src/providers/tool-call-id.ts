/**
 * Tool-call id normalization for providers with strict id rules.
 *
 * Anthropic (`tool_use.id`) and Bedrock (`toolUseId`) require
 * `^[a-zA-Z0-9_-]+$` (Bedrock also caps length at 64). Conversation history
 * can carry ids minted by another provider — e.g. after a mid-conversation
 * switch from an OpenAI-compatible/local server — so ids are sanitized when
 * converting history to the wire. The mapping is deterministic, so a tool
 * call and its result always map to the same id.
 */

const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_LENGTH = 64;

/** FNV-1a 32-bit hash as 8 hex chars (collision guard for rewritten ids). */
function fnv1a(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Return `id` unchanged when valid, else a deterministic valid rewrite. */
export function sanitizeToolCallId(id: string): string {
	if (VALID_ID.test(id)) return id;
	const base = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	const suffix = `_${fnv1a(id)}`;
	return base.slice(0, MAX_LENGTH - suffix.length) + suffix;
}
