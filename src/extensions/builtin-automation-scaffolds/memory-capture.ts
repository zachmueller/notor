import type { AutomationTrigger, BuiltinAutomationScaffold } from "../types";

export const MEMORY_CAPTURE: BuiltinAutomationScaffold = {
	name: "memory-capture",
	displayName: "Memory Capture (auto)",
	trigger: "after_completion" as AutomationTrigger,
	featureGroup: "memory",
	settingsSchema: [
		{
			key: "capture_profile",
			name: "Capture profile",
			type: "string",
			description: "Sub-agent profile used to extract insights from conversation turns.",
			default: "memory-capture",
		},
		{
			key: "resolver_profile",
			name: "Resolver profile",
			type: "string",
			description: "Sub-agent profile used to resolve insights into memory notes.",
			default: "memory-resolver",
		},
		{
			key: "dedup_window_hours",
			name: "Dedup window (hours)",
			type: "number",
			description: "Hours within which identical insights are deduplicated.",
			default: 24,
			min: 1,
			max: 168,
		},
		{
			key: "evaluator_profile",
			name: "Evaluator profile",
			type: "string",
			description: "Sub-agent profile used to evaluate which recalled memories were useful.",
			default: "memory-evaluator",
		},
	],
	scaffoldContent:
`---
notor-type: automation
notor-trigger: after_completion
notor-display-name: Memory Capture (auto)
notor-feature-group: memory
---

Extracts durable insights from each conversation turn and saves them as
Evergreen memory notes. Runs detached after each LLM response completes.

\`\`\`yaml
settings:
  capture_profile:
    name: "Capture profile"
    type: string
    description: "Sub-agent profile used to extract insights from conversation turns."
    default: "memory-capture"
  resolver_profile:
    name: "Resolver profile"
    type: string
    description: "Sub-agent profile used to resolve insights into memory notes."
    default: "memory-resolver"
  dedup_window_hours:
    name: "Dedup window (hours)"
    type: number
    description: "Hours within which identical insights are deduplicated."
    default: 24
    min: 1
    max: 168
  evaluator_profile:
    name: "Evaluator profile"
    type: string
    description: "Sub-agent profile used to evaluate which recalled memories were useful."
    default: "memory-evaluator"
\`\`\`

\`\`\`ts
const log = utils.logger("memory-capture");

if (!utils.memory) return;
if (!utils.chatBlocks) return;
if (!utils.chatHistory) return;

const conversationId = context.conversationId as string;
if (!conversationId) return;

const captureProfile = (settings as Record<string, unknown>).capture_profile as string ?? "memory-capture";
const resolverProfile = (settings as Record<string, unknown>).resolver_profile as string ?? "memory-resolver";
const windowHours = (settings as Record<string, unknown>).dedup_window_hours as number ?? 24;
const evaluatorProfile = (settings as Record<string, unknown>).evaluator_profile as string ?? "memory-evaluator";
const memoryDir = utils.resolveNotorPath("memory");
const approvalMode = utils.memoryApprovalMode ?? "auto";
const pendingMode = approvalMode === "bulk" || approvalMode === "bulk_and_inline";
const pendingMemoryDir = pendingMode ? utils.resolveNotorPath("pending-memories") : "";

// Load full conversation for context
const messages = await utils.chatHistory.loadFull(conversationId);
if (!messages || messages.length === 0) return;

// Build transcript of the last few turns for the capture sub-agent
const recentMessages = messages.slice(-6);
const transcript = recentMessages.map((m: any) => {
  const role = m.role as string;
  const text = typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? m.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\\n")
      : "";
  if (!text.trim()) return null;
  return "<" + role + ">\\n" + text.substring(0, 3000) + "\\n</" + role + ">";
}).filter(Boolean).join("\\n\\n");

if (!transcript.trim()) return;

const task = [
  "Extract durable insights from this conversation turn.",
  "",
  "<transcript>",
  transcript,
  "</transcript>",
].join("\\n");

log.debug("Spawning memory-capture sub-agent (detached)", { captureProfile, approvalMode });

await utils.runSubAgent({
  profileName: captureProfile,
  task,
  detached: true,
  silent: true,
  onComplete: async (result) => {
    if (!result || !result.text) {
      log.debug("Capture sub-agent returned no result");
      return;
    }

    const extractedCapture = utils.memory.extractJSON(result.text);
    if (!extractedCapture || typeof extractedCapture !== "object") {
      log.warn("Failed to parse capture response as JSON", { text: result.text.substring(0, 200) });
      return;
    }
    const parsed = extractedCapture as { insights?: Array<{ content: string; evidence_paths?: string[] }> };

    const insights = parsed.insights ?? [];
    if (insights.length === 0) {
      log.debug("No insights extracted");
      return;
    }

    if (pendingMode) {
      await utils.memory!.pendingMemoryManager.ensurePendingDir();
    }

    const results: Array<{ action: string; path?: string; insight: string; pending?: boolean }> = [];

    for (const insight of insights) {
      if (!insight.content?.trim()) continue;

      try {
        const { isDuplicate } = await utils.memory!.fingerprintAndDedup(insight.content, windowHours);
        if (isDuplicate) {
          log.debug("Duplicate insight, skipping", { content: insight.content.substring(0, 80) });
          continue;
        }

        const resolveResult = await utils.memory!.resolveConcept({
          insight: insight.content,
          memoryDir,
          resolverProfile,
          silent: true,
          pendingMode,
          pendingMemoryDir: pendingMode ? pendingMemoryDir : undefined,
        });

        results.push({
          action: resolveResult.action,
          path: resolveResult.path,
          insight: insight.content.substring(0, 120),
          pending: pendingMode,
        });
      } catch (e) {
        log.error("Failed to resolve insight", { error: String(e), content: insight.content.substring(0, 80) });
      }
    }

    const actionable = results.filter(r => r.action !== "skipped");
    if (actionable.length > 0 && utils.chatBlocks) {
      await utils.chatBlocks.emit("memory_captured", {
        results: actionable,
        conversationId,
      });

      // Emit per-memory inline approval blocks when bulk_and_inline mode is active.
      if (approvalMode === "bulk_and_inline") {
        for (const r of actionable) {
          if (!r.path) continue;
          try {
            const pendingContent = await utils.memory!.pendingMemoryManager.getLiveNoteContent
              ? null // placeholder — actual data assembled below
              : null;
            // Read the pending note to get its body for the inline block.
            const pendingNote = await (async () => {
              try {
                const raw = await utils.vault.adapter.read(r.path!);
                return utils.memory!.parseNote(raw);
              } catch { return null; }
            })();
            if (!pendingNote) continue;

            // For updates, also read the current live note body.
            const isUpdate = r.action === "updated";
            let currentBody: string | undefined;
            if (isUpdate) {
              const targetPath = (pendingNote as any).targetPath as string | undefined;
              if (targetPath) {
                const liveRaw = await utils.memory!.pendingMemoryManager.getLiveNoteContent(targetPath);
                if (liveRaw) {
                  currentBody = utils.memory!.parseNote(liveRaw).body;
                }
              }
            }

            await utils.chatBlocks.emit("memory_pending_approval", {
              pendingPath: r.path,
              title: pendingNote.title,
              action: r.action,
              targetPath: (pendingNote as any).targetPath,
              proposedBody: pendingNote.body,
              currentBody,
            });
          } catch (e) {
            log.warn("Failed to emit inline approval block", { error: String(e) });
          }
        }
      }

      log.debug("Memory capture complete", { count: actionable.length, pendingMode });
    }

    // Usefulness evaluation: determine which recalled memories were actually
    // drawn upon in this conversation and stamp notor-last-useful-at on them.
    const recalledMatches: Array<{ path: string; title: string }> = messages
      .filter((m: any) => m.role === "extension_block")
      .flatMap((m: any) => {
        if (!Array.isArray(m.content)) return [];
        return m.content
          .filter((b: any) => b.type === "custom_block" && b.kind === "memory_recalled")
          .flatMap((b: any) => (b.data?.matches ?? []) as Array<{ path: string; title: string }>);
      });

    if (recalledMatches.length > 0) {
      const evalTask = [
        "Below is a conversation transcript followed by a list of memory notes that were recalled and injected at the start of the conversation.",
        "Identify which memory notes were clearly drawn upon, referenced, or confirmed by the conversation.",
        "Be conservative: only include a memory if it was visibly used, not merely tangentially related.",
        "",
        "<transcript>",
        transcript,
        "</transcript>",
        "",
        "<recalled-memories>",
        recalledMatches.map((m: any) => "- path: " + m.path + "\\n  title: " + m.title).join("\\n"),
        "</recalled-memories>",
        "",
        'Return JSON: { "useful_paths": ["path1", "path2"] }',
      ].join("\\n");

      try {
        const evalResult = await utils.runSubAgent({
          profileName: evaluatorProfile,
          task: evalTask,
          detached: false,
          silent: true,
        });

        if (evalResult?.text) {
          const evalParsed = utils.memory.extractJSON(evalResult.text) as { useful_paths?: string[] } | null;
          const usefulPaths = evalParsed?.useful_paths ?? [];
          const evalNow = new Date().toISOString();

          for (const usefulPath of usefulPaths) {
            try {
              const file = utils.vault.getFileByPath(usefulPath);
              if (!file) continue;
              const content = await utils.vault.read(file);
              const patched = utils.memory.patchFrontmatterField(content, "notor-last-useful-at", evalNow);
              await utils.vault.modify(file, patched);
            } catch (e) {
              log.warn("Failed to stamp notor-last-useful-at", { path: usefulPath, error: String(e) });
            }
          }

          log.debug("Usefulness evaluation complete", { useful: usefulPaths.length, recalled: recalledMatches.length });
        }
      } catch (e) {
        log.warn("Usefulness evaluation failed", { error: String(e) });
      }
    }
  },
});
\`\`\`
`,
};
