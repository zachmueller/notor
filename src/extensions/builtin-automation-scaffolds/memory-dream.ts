import type { AutomationTrigger, BuiltinAutomationScaffold, SettingsFieldSchema } from "../types";

export const MEMORY_DREAM: BuiltinAutomationScaffold = {
	name: "memory-dream",
	displayName: "Memory Dream",
	trigger: "on_schedule" as AutomationTrigger,
	featureGroup: "memory",
	schedule: "0 */3 * * *",
	settingsSchema: [
		{
			key: "dream_profile",
			name: "Dream profile",
			type: "string",
			description: "Sub-agent profile used for cross-session memory consolidation.",
			default: "memory-dream",
		},
		{
			key: "resolver_profile",
			name: "Resolver profile",
			type: "string",
			description: "Sub-agent profile used to resolve new concepts discovered during Dream.",
			default: "memory-resolver",
		},
		{
			key: "max_tokens_per_batch",
			name: "Max tokens per batch",
			type: "number",
			description: "Approximate token budget per Dream sub-agent call.",
			default: 30000,
			min: 5000,
			max: 100000,
		},
		{
			key: "note_max_chars",
			name: "Note max chars",
			type: "number",
			description: "Maximum character length for a single memory note body before split-or-compact is triggered.",
			default: 4000,
			min: 1000,
			max: 20000,
		},
		{
			key: "split_depth",
			name: "Split depth",
			type: "number",
			description: "Maximum recursion depth for split-or-compact overflow handling.",
			default: 2,
			min: 1,
			max: 5,
		},
		{
			key: "initial_lookback_days",
			name: "Initial lookback days",
			type: "number",
			description: "Days to look back on first Dream run (no cursor file).",
			default: 7,
			min: 1,
			max: 30,
		},
	],
	scaffoldContent:
`---
notor-type: automation
notor-trigger: on_schedule
notor-schedule: "0 */3 * * *"
notor-display-name: Memory Dream
notor-feature-group: memory
---

Runs on a cron schedule to consolidate and refine Evergreen memory notes by
analyzing recent conversations. The Dream pipeline: cursor gate → load
conversations → chunk by token budget → per-chunk sub-agent analysis →
directive application → overflow handling → progressive cursor advance.

\`\`\`yaml
settings:
  dream_profile:
    name: "Dream profile"
    type: string
    description: "Sub-agent profile used for cross-session memory consolidation."
    default: "memory-dream"
  resolver_profile:
    name: "Resolver profile"
    type: string
    description: "Sub-agent profile used to resolve new concepts discovered during Dream."
    default: "memory-resolver"
  max_tokens_per_batch:
    name: "Max tokens per batch"
    type: number
    description: "Approximate token budget per Dream sub-agent call."
    default: 30000
    min: 5000
    max: 100000
  note_max_chars:
    name: "Note max chars"
    type: number
    description: "Maximum character length for a single memory note body before split-or-compact is triggered."
    default: 4000
    min: 1000
    max: 20000
  split_depth:
    name: "Split depth"
    type: number
    description: "Maximum recursion depth for split-or-compact overflow handling."
    default: 2
    min: 1
    max: 5
  initial_lookback_days:
    name: "Initial lookback days"
    type: number
    description: "Days to look back on first Dream run (no cursor file)."
    default: 7
    min: 1
    max: 30
\`\`\`

\`\`\`ts
const log = utils.logger("memory-dream");

if (!utils.memory) return;
if (!utils.chatHistory) return;

const dreamProfile = (settings as Record<string, unknown>).dream_profile as string ?? "memory-dream";
const resolverProfile = (settings as Record<string, unknown>).resolver_profile as string ?? "memory-resolver";
const maxTokensPerBatch = (settings as Record<string, unknown>).max_tokens_per_batch as number ?? 30000;
const noteMaxChars = (settings as Record<string, unknown>).note_max_chars as number ?? 4000;
const splitDepth = (settings as Record<string, unknown>).split_depth as number ?? 2;
const initialLookbackDays = (settings as Record<string, unknown>).initial_lookback_days as number ?? 7;
const memoryDir = utils.resolveNotorPath("memory");

// Phase 0: Deterministic gate — read cursor and filter conversations
const cursorTimestamp = await utils.memory.readDreamCursor();
const cutoff = cursorTimestamp
  ? new Date(cursorTimestamp)
  : new Date(Date.now() - initialLookbackDays * 24 * 60 * 60 * 1000);

log.debug("Dream starting", { cursor: cursorTimestamp, cutoff: cutoff.toISOString() });

const recentConversations = await utils.chatHistory.listRecent(100);
const qualifying = recentConversations.filter((c: any) => {
  const updatedAt = new Date(c.updated_at || c.created_at);
  return updatedAt > cutoff;
});

if (qualifying.length === 0) {
  log.debug("No qualifying conversations since last Dream run");
  return;
}

log.debug("Dream found qualifying conversations", { count: qualifying.length });

// Rough token estimation: ~4 chars per token
const CHARS_PER_TOKEN = 4;
const maxCharsPerBatch = maxTokensPerBatch * CHARS_PER_TOKEN;

// Phase 1-2: Process each conversation
for (const conversation of qualifying) {
  const convId = conversation.id || conversation.conversation_id;
  if (!convId) continue;

  const messages = await utils.chatHistory.loadFull(convId);
  if (!messages || messages.length === 0) {
    log.debug("Empty conversation, skipping", { conversationId: convId });
    continue;
  }

  // Build transcript text for chunking
  const transcriptParts: string[] = [];
  for (const msg of messages) {
    const role = (msg as any).role as string;
    if (role !== "user" && role !== "assistant") continue;
    const text = typeof (msg as any).content === "string"
      ? (msg as any).content
      : Array.isArray((msg as any).content)
        ? (msg as any).content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\\n")
        : "";
    if (!text.trim()) continue;
    transcriptParts.push("<" + role + ">\\n" + text + "\\n</" + role + ">");
  }

  const fullTranscript = transcriptParts.join("\\n\\n");
  if (!fullTranscript.trim()) continue;

  // Chunk by token budget
  const chunks: string[] = [];
  if (fullTranscript.length <= maxCharsPerBatch) {
    chunks.push(fullTranscript);
  } else {
    let remaining = fullTranscript;
    while (remaining.length > 0) {
      chunks.push(remaining.substring(0, maxCharsPerBatch));
      remaining = remaining.substring(maxCharsPerBatch);
    }
  }

  // Process each chunk through the Dream sub-agent
  for (const chunk of chunks) {
    const task = [
      "Analyze this conversation excerpt and return consolidation directives for Evergreen memory notes.",
      "",
      "<conversation>",
      chunk,
      "</conversation>",
    ].join("\\n");

    log.debug("Spawning dream sub-agent for chunk", { chunkLength: chunk.length });

    const result = await utils.runSubAgent({
      profileName: dreamProfile,
      task,
      detached: false,
      silent: true,
    });

    if (!result || !result.text) {
      log.debug("Dream sub-agent returned no result for chunk");
      continue;
    }

    // Parse directives
    let directives: Array<{
      action: string;
      title?: string;
      body?: string;
      path?: string;
      merged_body?: string;
      source_path?: string;
      target_path?: string;
      reason?: string;
    }>;
    const extractedDream = utils.memory.extractJSON(result.text);
    if (Array.isArray(extractedDream)) {
      directives = extractedDream;
    } else if (extractedDream && typeof extractedDream === "object" && Array.isArray((extractedDream as any).directives)) {
      directives = (extractedDream as any).directives;
    } else {
      log.warn("Failed to parse dream response as JSON array", { text: result.text.substring(0, 200) });
      continue;
    }

    // Apply directives
    for (const directive of directives) {
      try {
        if (directive.action === "create" && directive.title && directive.body) {
          const resolveResult = await utils.memory!.resolveConcept({
            insight: directive.title + "\\n\\n" + directive.body,
            memoryDir,
            resolverProfile,
            silent: true,
          });

          // Check overflow after apply
          if (resolveResult.path && resolveResult.action !== "skipped") {
            await handleOverflow(resolveResult.path, noteMaxChars, splitDepth, 0);
          }

        } else if (directive.action === "update" && directive.path && directive.merged_body) {
          utils.memory!.assertMemoryPath(directive.path, memoryDir);
          const existing = await utils.readNote(directive.path);
          const note = utils.memory!.parseNote(existing);
          const updated = utils.memory!.serializeNote({
            title: note.title,
            body: directive.merged_body,
            sources: note.sources.includes("dream") ? note.sources : [...note.sources, "dream"],
            createdAt: note.createdAt || new Date().toISOString(),
          });
          const file = app.vault.getAbstractFileByPath(directive.path);
          if (file) {
            await app.vault.modify(file as any, updated);
            await handleOverflow(directive.path, noteMaxChars, splitDepth, 0);
          }

        } else if (directive.action === "merge" && directive.source_path && directive.target_path && directive.merged_body) {
          utils.memory!.assertMemoryPath(directive.source_path, memoryDir);
          utils.memory!.assertMemoryPath(directive.target_path, memoryDir);

          // Update target with merged body
          const existing = await utils.readNote(directive.target_path);
          const note = utils.memory!.parseNote(existing);
          const updated = utils.memory!.serializeNote({
            title: note.title,
            body: directive.merged_body,
            sources: note.sources.includes("dream") ? note.sources : [...note.sources, "dream"],
            createdAt: note.createdAt || new Date().toISOString(),
          });
          const targetFile = app.vault.getAbstractFileByPath(directive.target_path);
          if (targetFile) {
            await app.vault.modify(targetFile as any, updated);
          }

          // Delete source
          const sourceFile = app.vault.getAbstractFileByPath(directive.source_path);
          if (sourceFile) {
            await app.vault.delete(sourceFile as any);
            log.debug("Merged and deleted source note", { source: directive.source_path, target: directive.target_path });
          }

          if (directive.target_path) {
            await handleOverflow(directive.target_path, noteMaxChars, splitDepth, 0);
          }

        } else if (directive.action === "remove" && directive.path) {
          utils.memory!.assertMemoryPath(directive.path, memoryDir);
          const file = app.vault.getAbstractFileByPath(directive.path);
          if (file) {
            await app.vault.delete(file as any);
            log.debug("Removed memory note", { path: directive.path, reason: directive.reason });
          }
        }
      } catch (e) {
        log.error("Failed to apply dream directive", { action: directive.action, error: String(e) });
      }
    }
  }

  // Progressive cursor advance after each conversation
  const convUpdatedAt = (conversation as any).updated_at || (conversation as any).created_at || new Date().toISOString();
  await utils.memory!.advanceDreamCursor(convUpdatedAt);
  log.debug("Advanced dream cursor", { timestamp: convUpdatedAt, conversationId: convId });
}

log.info("Dream pipeline complete", { conversationsProcessed: qualifying.length });

// --- Split-or-compact overflow handler ---
async function handleOverflow(
  notePath: string,
  maxChars: number,
  maxDepth: number,
  currentDepth: number,
): Promise<void> {
  if (currentDepth >= maxDepth) {
    log.debug("Overflow depth limit reached, deferring to next Dream run", { notePath, currentDepth });
    return;
  }

  let content: string;
  try {
    content = await utils.readNote(notePath);
  } catch {
    return;
  }

  const note = utils.memory!.parseNote(content);
  if (note.body.length <= maxChars) return;

  log.debug("Note exceeds max chars, running split-or-compact", {
    notePath,
    bodyLength: note.body.length,
    maxChars,
    depth: currentDepth,
  });

  const overflowTask = [
    "The following memory note body exceeds the maximum length of " + maxChars + " characters (" + note.body.length + " chars).",
    "Decide whether to SPLIT it into multiple atomic concept notes or COMPACT it into a shorter version.",
    "",
    "Note title: " + note.title,
    "Note path: " + notePath,
    "",
    "<note_body>",
    note.body,
    "</note_body>",
    "",
    "If splitting: return { \\"action\\": \\"split\\", \\"children\\": [{ \\"title\\": \\"...\\", \\"body\\": \\"...\\" }, ...] }",
    "If compacting: return { \\"action\\": \\"compact\\", \\"body\\": \\"...\\" }",
    "",
    "Each child note must be atomic (one concept) and under " + maxChars + " characters.",
    "Compacted body must be under " + maxChars + " characters.",
  ].join("\\n");

  const overflowResult = await utils.runSubAgent({
    profileName: dreamProfile,
    task: overflowTask,
    detached: false,
    silent: true,
  });

  if (!overflowResult || !overflowResult.text) return;

  const decision = utils.memory.extractJSON(overflowResult.text) as any;
  if (!decision || typeof decision !== "object") {
    log.warn("Failed to parse overflow decision", { text: overflowResult.text.substring(0, 200) });
    return;
  }

  if (decision.action === "split" && Array.isArray(decision.children)) {
    // Route each child through concept resolver for collision detection
    for (const child of decision.children) {
      if (!child.title || !child.body) continue;
      try {
        const childResult = await utils.memory!.resolveConcept({
          insight: child.title + "\\n\\n" + child.body,
          memoryDir,
          resolverProfile,
          silent: true,
        });
        // Recurse on children that may still be oversized
        if (childResult.path && childResult.action !== "skipped") {
          await handleOverflow(childResult.path, maxChars, maxDepth, currentDepth + 1);
        }
      } catch (e) {
        log.error("Failed to resolve split child", { title: child.title, error: String(e) });
      }
    }

    // Delete or update original (fully subsumed by children)
    try {
      const origFile = app.vault.getAbstractFileByPath(notePath);
      if (origFile) {
        await app.vault.delete(origFile as any);
        log.debug("Deleted original note after split", { notePath });
      }
    } catch (e) {
      log.error("Failed to delete original after split", { notePath, error: String(e) });
    }

  } else if (decision.action === "compact" && decision.body) {
    // Overwrite with compacted body
    try {
      const compacted = utils.memory!.serializeNote({
        title: note.title,
        body: decision.body,
        sources: note.sources.includes("dream") ? note.sources : [...note.sources, "dream"],
        createdAt: note.createdAt || new Date().toISOString(),
      });
      const file = app.vault.getAbstractFileByPath(notePath);
      if (file) {
        await app.vault.modify(file as any, compacted);
        log.debug("Compacted oversized note", { notePath, newLength: decision.body.length });
      }
    } catch (e) {
      log.error("Failed to compact note", { notePath, error: String(e) });
    }
  }
}
\`\`\`
`,
};
