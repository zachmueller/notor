import type { AutomationTrigger, BuiltinAutomationScaffold } from "../types";

export const MEMORY_SEARCH: BuiltinAutomationScaffold = {
	name: "memory-search",
	displayName: "Memory Search (auto-inject)",
	trigger: "on_conversation_start" as AutomationTrigger,
	blocking: true,
	blockingEmitKind: "memory_recalled",
	blockingTimeout: 10000,
	featureGroup: "memory",
	settingsSchema: [
		{
			key: "search_profile",
			name: "Search profile",
			type: "string",
			description: "Sub-agent profile used to search memory notes.",
			default: "memory-search",
		},
		{
			key: "max_matches",
			name: "Max matches",
			type: "number",
			description: "Maximum number of memory notes to surface per conversation.",
			default: 8,
			min: 1,
			max: 20,
		},
	],
	scaffoldContent:
`---
notor-type: automation
notor-trigger: on_conversation_start
notor-display-name: Memory Search (auto-inject)
notor-blocking: true
notor-blocking-emit-kind: memory_recalled
notor-blocking-timeout: 10
notor-feature-group: memory
---

Searches the user's memory notes at conversation start and injects relevant
context as a \`memory_recalled\` block. Runs as a blocking automation so the
recalled memories are visible to the LLM on the first turn.

\`\`\`yaml
settings:
  search_profile:
    name: "Search profile"
    type: string
    description: "Sub-agent profile used to search memory notes."
    default: "memory-search"
  max_matches:
    name: "Max matches"
    type: number
    description: "Maximum number of memory notes to surface per conversation."
    default: 8
    min: 1
    max: 20
\`\`\`

\`\`\`ts
const log = utils.logger("memory-search");

if (!utils.memory) return;
if (!utils.chatBlocks) return;
if (!utils.chatHistory) return;

// Cold-start guard: skip if no memory notes exist yet
const hasNotes = await utils.memory.hasMemoryNotes();
if (!hasNotes) {
  log.debug("No memory notes found, skipping search");
  return;
}

const conversationId = context.conversationId as string;
if (!conversationId) return;

const searchProfile = (settings as Record<string, unknown>).search_profile as string ?? "memory-search";
const maxMatches = (settings as Record<string, unknown>).max_matches as number ?? 8;
const approvalMode = utils.memoryApprovalMode ?? "auto";
const pendingMode = approvalMode === "bulk" || approvalMode === "bulk_and_inline";
const pendingMemoryDir = pendingMode ? utils.resolveNotorPath("pending-memories") : "";

// Load conversation to get the user's first message + recent context
const messages = await utils.chatHistory.loadFull(conversationId);
if (!messages || messages.length === 0) return;

// Build task: include user message and up to 2 prior turns for context
const userMessages = messages.filter((m: any) => m.role === "user");
const lastUserMsg = userMessages[userMessages.length - 1];
if (!lastUserMsg) return;

const contentText = typeof lastUserMsg.content === "string"
  ? lastUserMsg.content
  : Array.isArray(lastUserMsg.content)
    ? lastUserMsg.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\\n")
    : "";

if (!contentText.trim()) return;

const pendingDirHint = pendingMode
  ? "\\n\\nAlso search for pending (not-yet-approved) memory notes in: " + pendingMemoryDir
  : "";

const task = [
  "Search for memory notes relevant to this conversation turn.",
  "",
  "<user_message>",
  contentText.substring(0, 2000),
  "</user_message>",
  "",
  "max_matches: " + maxMatches + pendingDirHint,
].join("\\n");

log.debug("Spawning memory-search sub-agent", { searchProfile, maxMatches });

const result = await utils.runSubAgent({
  profileName: searchProfile,
  task,
  detached: false,
  silent: true,
});

if (!result || !result.text) {
  log.debug("Memory search returned no result");
  await utils.chatBlocks.emit("memory_recalled", { matches: [] });
  return;
}

// Parse sub-agent JSON response (may be wrapped in explanatory text)
const extracted = utils.memory.extractJSON(result.text);
if (!extracted || typeof extracted !== "object") {
  log.warn("Failed to parse memory-search response as JSON", { text: result.text.substring(0, 200) });
  await utils.chatBlocks.emit("memory_recalled", { matches: [] });
  return;
}
const parsed = extracted as { matches?: Array<{ path: string; reason: string }> };

const rawMatches = parsed.matches ?? [];
if (rawMatches.length === 0) {
  log.debug("Memory search returned no matches");
  await utils.chatBlocks.emit("memory_recalled", { matches: [] });
  return;
}

// Read note bodies for matched notes
const enrichedMatches: Array<{ path: string; title: string; reason: string; payload: string }> = [];
for (const match of rawMatches.slice(0, maxMatches)) {
  try {
    const content = await utils.readNote(match.path);
    const note = utils.memory.parseNote(content);
    enrichedMatches.push({
      path: match.path,
      title: note.title || match.path.split("/").pop()?.replace(/\\.md$/, "") || match.path,
      reason: match.reason,
      payload: content,
    });
  } catch (e) {
    log.warn("Failed to read matched memory note", { path: match.path, error: String(e) });
  }
}

// Patch notor-last-recalled-at on every matched note (best-effort)
const recalledNow = new Date().toISOString();
for (const match of enrichedMatches) {
  try {
    const file = utils.vault.getFileByPath(match.path);
    if (!file) continue;
    const patched = utils.memory.patchFrontmatterField(match.payload, "notor-last-recalled-at", recalledNow);
    await utils.vault.modify(file, patched);
  } catch {
    // best-effort; don't block recall on timestamp failure
  }
}

log.debug("Memory search complete", { matchCount: enrichedMatches.length });
await utils.chatBlocks.emit("memory_recalled", { matches: enrichedMatches });
\`\`\`
`,
};
