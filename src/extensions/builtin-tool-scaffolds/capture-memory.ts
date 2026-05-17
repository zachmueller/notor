import { scaffold } from "./_scaffold-helper";

export const CAPTURE_MEMORY = scaffold(
	"capture_memory",
	"Save an insight into long-term memory as an Evergreen note",
	"write",
	`params:
  content:
    type: string
    description: "The insight or piece of knowledge to save into long-term memory."
settings:
  resolver_profile:
    name: "Resolver Profile"
    type: string
    description: "Sub-agent profile used to decide whether to create or update an existing memory note."
    default: "memory-resolver"
  dedup_window_hours:
    name: "Dedup Window (hours)"
    type: number
    description: "Hours within which identical insights are deduplicated."
    default: 24
    min: 1
    max: 168`,
	`const log = utils.logger("capture_memory");

if (!params.content || typeof params.content !== "string") {
  throw new Error("Missing required parameter: content");
}

if (!utils.memory) {
  return "Memory is disabled. Enable it in Notor settings to use this tool.";
}

const content = (params.content as string).trim();
if (content.length === 0) {
  throw new Error("Content must not be empty.");
}

const windowHours = (settings.dedup_window_hours as number) ?? 24;
const resolverProfile = (settings.resolver_profile as string) ?? "memory-resolver";
const memoryDir = utils.resolveNotorPath("memory");
const approvalMode = utils.memoryApprovalMode ?? "auto";
const pendingMode = approvalMode === "bulk" || approvalMode === "bulk_and_inline";
const pendingMemoryDir = pendingMode ? utils.resolveNotorPath("pending-memories") : "";

log.debug("Checking dedup", { windowHours });
const { isDuplicate } = await utils.memory.fingerprintAndDedup(content, windowHours);
if (isDuplicate) {
  log.debug("Duplicate insight, skipping");
  return "Skipped — this insight was already captured recently.";
}

if (pendingMode) {
  await utils.memory.pendingMemoryManager.ensurePendingDir();
}

log.debug("Resolving concept", { resolverProfile, memoryDir, pendingMode });
const result = await utils.memory.resolveConcept({
  insight: content,
  memoryDir,
  resolverProfile,
  pendingMode,
  pendingMemoryDir: pendingMode ? pendingMemoryDir : undefined,
});

if (result.action === "skipped") {
  return "The insight could not be resolved into a memory note. It may be too vague or the resolver could not determine how to file it.";
}

if (pendingMode) {
  const verb = result.action === "created" ? "Queued new" : "Queued update to";
  return \`\${verb} memory note (pending approval): \${result.path}\`;
}

const verb = result.action === "created" ? "Created" : "Updated";
return \`\${verb} memory note: \${result.path}\`;`,
	"memory",
);
