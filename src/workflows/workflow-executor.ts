/**
 * Workflow executor — prompt assembly pipeline for workflow execution.
 *
 * Implements the full prompt assembly pipeline defined in the
 * workflow-assembly contract:
 *
 *   1. Read workflow note body (strip frontmatter)            — E-002
 *   2. Resolve `<include_note>` tags                          — E-003
 *   3. Validate resolved content is non-empty                 — E-004
 *   4. Wrap in `<workflow_instructions>` XML tag              — E-005
 *   5. Build `<trigger_context>` (event-triggered only)
 *   6. Compose final message via `assembleUserMessage()`      — E-006
 *
 * Also provides persona switching/revert helpers (E-007, E-008) and
 * the workflow picker function for the command palette (E-009).
 *
 * @see specs/03-workflows-personas/contracts/workflow-assembly.md
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-002..E-009
 */

import { App, FuzzySuggestModal, getFrontMatterInfo, Notice, TFile, type MetadataCache, type Vault } from "obsidian";
import type {
	IncludeNoteResolutionResult,
	TriggerContext,
	Workflow,
	WorkflowAssemblyResult,
	WorkflowExecutionRequest,
} from "../types";
import type { PersonaManager } from "../personas/persona-manager";
import { resolveIncludeNotes } from "../include-note/resolver";
import { assembleUserMessage } from "../context/message-assembler";
import { logger } from "../utils/logger";

const log = logger("WorkflowExecutor");

// ---------------------------------------------------------------------------
// E-002: Workflow body reader — read and strip frontmatter
// ---------------------------------------------------------------------------

/**
 * Read the full content of a workflow note and strip its YAML frontmatter
 * to produce the raw body content (the workflow instructions).
 *
 * Uses Obsidian's `getFrontMatterInfo()` to reliably locate the frontmatter
 * boundary, then returns everything after `contentStart`. If the note has
 * no frontmatter, the full content is returned as-is.
 *
 * This is step 1 of the workflow prompt assembly pipeline.
 *
 * @param file - The workflow note's `TFile` handle.
 * @param vault - The Obsidian vault instance.
 * @returns The body content string (may be empty — checked in E-004).
 * @throws A descriptive `Error` if the vault read fails.
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-002
 */
export async function readWorkflowBody(file: TFile, vault: Vault): Promise<string> {
	let rawContent: string;
	try {
		rawContent = await vault.read(file);
	} catch (err) {
		throw new Error(
			`Failed to read workflow note '${file.path}': ${err instanceof Error ? err.message : String(err)}`
		);
	}

	const fmInfo = getFrontMatterInfo(rawContent);
	return rawContent.slice(fmInfo.contentStart);
}

// ---------------------------------------------------------------------------
// E-003: `<include_note>` resolution in workflow bodies
// ---------------------------------------------------------------------------

/**
 * Resolve all `<include_note>` tags in a workflow body string.
 *
 * Delegates to Group D's `resolveIncludeNotes()` with context `"workflow"`
 * so that both `inline` and `attached` modes are supported. The workflow
 * note's own vault-relative path is provided as `sourceFilePath` for
 * wikilink disambiguation.
 *
 * This is step 2 of the workflow prompt assembly pipeline.
 *
 * @param body - The raw workflow body (frontmatter already stripped).
 * @param vault - The Obsidian vault instance.
 * @param metadataCache - The Obsidian metadata cache.
 * @param workflowFilePath - Vault-relative path of the workflow note itself.
 * @returns Resolution result: `inlineContent` (body with inline tags resolved,
 *          attached tags removed) and `attachments` (collected attached entries).
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-003
 */
export async function resolveWorkflowIncludes(
	body: string,
	vault: Vault,
	metadataCache: MetadataCache,
	workflowFilePath: string
): Promise<IncludeNoteResolutionResult> {
	return resolveIncludeNotes(body, vault, metadataCache, workflowFilePath, "workflow");
}

// ---------------------------------------------------------------------------
// E-004: Empty workflow guard
// ---------------------------------------------------------------------------

/**
 * Validate that the resolved workflow body has non-empty content.
 *
 * Returns `false` if the body is empty or whitespace-only, signalling
 * that the caller should abort execution and surface a notice.
 *
 * Bodies consisting entirely of `<include_note>` error markers (e.g.,
 * `[include_note error: ...]`) are considered non-empty and pass the
 * guard — the LLM receives the markers and can inform the user.
 *
 * This is step 3 of the workflow prompt assembly pipeline.
 *
 * @param resolvedBody - The workflow body after `<include_note>` resolution.
 * @returns `true` if the body has usable content; `false` if it is empty.
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-004
 */
export function validateWorkflowContent(resolvedBody: string): boolean {
	return resolvedBody.trim().length > 0;
}

// ---------------------------------------------------------------------------
// E-005: `<workflow_instructions>` XML wrapping
// ---------------------------------------------------------------------------

/**
 * Wrap the resolved workflow body in a `<workflow_instructions>` XML tag.
 *
 * Format:
 * ```xml
 * <workflow_instructions type="{workflowFileName}">
 * {resolvedBody}
 * </workflow_instructions>
 * ```
 *
 * The `type` attribute contains the workflow note's **file name only**
 * (e.g., `daily-review.md`), not the full vault-relative path. Opening
 * tag, content, and closing tag are on separate lines. No additional
 * whitespace is inserted around the content.
 *
 * This is step 4 of the workflow prompt assembly pipeline.
 *
 * @param resolvedBody - The resolved workflow body content (after include resolution).
 * @param workflowFileName - The workflow note's file name (e.g. `"daily-review.md"`).
 * @returns The `<workflow_instructions>` wrapped string.
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-005
 * @see specs/03-workflows-personas/contracts/workflow-assembly.md — Step 4
 */
export function wrapWorkflowInstructions(
	resolvedBody: string,
	workflowFileName: string
): string {
	return `<workflow_instructions type="${workflowFileName}">\n${resolvedBody}\n</workflow_instructions>`;
}

// ---------------------------------------------------------------------------
// E-006: Full pipeline orchestrator
// ---------------------------------------------------------------------------

/**
 * Build the `<trigger_context>` XML block for event-triggered workflows.
 *
 * Formats the context per the workflow-assembly contract:
 * - Note-related events: `event`, `note_path`
 * - Tag-change events: `event`, `note_path`, `tags_added`, `tags_removed`
 * - Scheduled events: `event` only (no note path)
 *
 * @param ctx - The trigger context object.
 * @returns The formatted `<trigger_context>` XML string.
 *
 * @see specs/03-workflows-personas/contracts/workflow-assembly.md — Step 5
 */
function buildTriggerContextBlock(ctx: TriggerContext): string {
	const lines: string[] = [`event: ${ctx.event}`];

	if (ctx.note_path !== null) {
		lines.push(`note_path: ${ctx.note_path}`);
	}

	if (ctx.tags_added !== null && ctx.tags_added.length > 0) {
		lines.push(`tags_added: ${ctx.tags_added.join(", ")}`);
	}

	if (ctx.tags_removed !== null && ctx.tags_removed.length > 0) {
		lines.push(`tags_removed: ${ctx.tags_removed.join(", ")}`);
	}

	return `<trigger_context>\n${lines.join("\n")}\n</trigger_context>`;
}

/**
 * Build an `<attachments>` XML block from `<include_note mode="attached">`
 * resolution results.
 *
 * Each attachment entry is rendered as a `<vault-note>` element, matching
 * the format established by the attachment system in Phase 2.
 *
 * Returns `null` if there are no attachments to include.
 *
 * @param attachments - The collected attached-mode entries from include resolution.
 * @returns The `<attachments>` XML string, or `null` if empty.
 */
function buildIncludeAttachmentsBlock(
	attachments: IncludeNoteResolutionResult["attachments"]
): string | null {
	if (attachments.length === 0) {
		return null;
	}

	const tags = attachments.map((att) => {
		const pathAttr = escapeXmlAttr(att.path);
		if (att.section !== null) {
			const sectionAttr = escapeXmlAttr(att.section);
			return `  <vault-note path="${pathAttr}" section="${sectionAttr}">\n${att.content}\n  </vault-note>`;
		}
		return `  <vault-note path="${pathAttr}">\n${att.content}\n  </vault-note>`;
	});

	return `<attachments>\n${tags.join("\n")}\n</attachments>`;
}

/** Escape special characters in XML attribute values. */
function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Orchestrate the full workflow prompt assembly pipeline.
 *
 * Executes steps 1–7 of the workflow-assembly contract in order:
 * 1. Read workflow note body (strip frontmatter)
 * 2. Resolve `<include_note>` tags
 * 3. Validate non-empty content (aborts with `null` return if empty)
 * 4. Wrap in `<workflow_instructions>` XML
 * 5. Build `<trigger_context>` block (event-triggered only)
 * 6. Build `<attachments>` block from attached-mode include entries
 * 7. Compose final message via `assembleUserMessage()`
 *
 * @param request - The workflow execution request (workflow, supplementary text, trigger context).
 * @param vault - The Obsidian vault instance.
 * @param metadataCache - The Obsidian metadata cache.
 * @returns The assembled `WorkflowAssemblyResult`, or `null` if the empty guard fires.
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-006
 * @see specs/03-workflows-personas/contracts/workflow-assembly.md — Pipeline
 */
export async function assembleWorkflowPrompt(
	request: WorkflowExecutionRequest,
	vault: Vault,
	metadataCache: MetadataCache
): Promise<WorkflowAssemblyResult | null> {
	const { workflow, supplementaryText, triggerContext } = request;

	// Resolve the workflow TFile from the vault
	const abstractFile = vault.getAbstractFileByPath(workflow.file_path);
	if (!(abstractFile instanceof TFile)) {
		throw new Error(
			`Workflow file not found in vault: '${workflow.file_path}'`
		);
	}
	const workflowFile = abstractFile;

	log.debug("Assembling workflow prompt", {
		file_path: workflow.file_path,
		display_name: workflow.display_name,
		has_trigger_context: triggerContext !== null,
	});

	// Step 1: Read body (frontmatter stripped)
	const body = await readWorkflowBody(workflowFile, vault);

	// Step 2: Resolve <include_note> tags
	const includeResult = await resolveWorkflowIncludes(
		body,
		vault,
		metadataCache,
		workflow.file_path
	);
	const resolvedBody = includeResult.inlineContent;

	// Step 3: Validate non-empty content
	if (!validateWorkflowContent(resolvedBody)) {
		log.warn("Workflow body is empty after resolution, aborting", {
			file_path: workflow.file_path,
		});
		new Notice("Workflow has no prompt content.");
		return null;
	}

	// Step 4: Wrap in <workflow_instructions>
	const workflowInstructions = wrapWorkflowInstructions(resolvedBody, workflow.file_name);

	// Step 5: Build <trigger_context> block (event-triggered workflows only)
	const triggerContextBlock =
		triggerContext !== null ? buildTriggerContextBlock(triggerContext) : undefined;

	// Step 6: Build <attachments> block from attached-mode include_note entries
	const attachmentsBlock =
		includeResult.attachments.length > 0
			? buildIncludeAttachmentsBlock(includeResult.attachments) ?? undefined
			: undefined;

	// Step 7: Compose final message
	const assembledMessage = assembleUserMessage({
		triggerContext: triggerContextBlock,
		attachments: attachmentsBlock,
		workflowInstructions,
		userText: supplementaryText ?? "",
	});

	log.info("Workflow prompt assembled", {
		file_path: workflow.file_path,
		display_name: workflow.display_name,
		assembled_length: assembledMessage.length,
		attached_count: includeResult.attachments.length,
	});

	return {
		assembledMessage,
		workflowName: workflow.display_name,
		attachments: includeResult.attachments,
	};
}

// ---------------------------------------------------------------------------
// E-007: Persona switching on workflow start
// ---------------------------------------------------------------------------

/**
 * Switch to the workflow's designated persona before execution begins.
 *
 * Saves the current persona state (for later revert by `revertWorkflowPersona`),
 * then activates the named persona via `PersonaManager.activatePersona()`.
 *
 * If `personaName` is null or empty, no switch is performed and the caller
 * can proceed with the current persona unchanged.
 *
 * If `activatePersona()` returns `false` (persona not found), execution
 * is NOT aborted — a notice is surfaced and the workflow proceeds with
 * the current settings.
 *
 * @param personaName - Persona name from `notor-workflow-persona` frontmatter, or null.
 * @param personaManager - The active `PersonaManager` instance.
 * @returns Whether the switch occurred and the previous persona name for revert.
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-007
 */
export async function switchWorkflowPersona(
	personaName: string | null,
	personaManager: PersonaManager
): Promise<{ switched: boolean; previousPersona: string | null }> {
	if (!personaName || personaName.trim().length === 0) {
		return { switched: false, previousPersona: null };
	}

	// Save current state before switching
	personaManager.savePersonaState();
	const previousPersona = personaManager.getActivePersona()?.name ?? null;

	const activated = await personaManager.activatePersona(personaName);

	if (activated) {
		new Notice(`Persona '${personaName}' activated for workflow.`);
		log.info("Workflow persona switched", {
			personaName,
			previousPersona,
		});
		return { switched: true, previousPersona };
	} else {
		// Persona not found — clear the saved state (nothing to revert)
		// and proceed with current settings per spec.
		new Notice(`Persona '${personaName}' not found; running with current settings.`);
		log.warn("Workflow persona not found, continuing with current settings", {
			personaName,
		});
		return { switched: false, previousPersona: null };
	}
}

// ---------------------------------------------------------------------------
// E-008: Persona revert on workflow end
// ---------------------------------------------------------------------------

/**
 * Revert the active persona to the state saved before a workflow execution.
 *
 * Called when the user leaves a workflow conversation (switches to another
 * conversation or starts a new one). The revert happens regardless of whether
 * the workflow succeeded, failed, or was stopped.
 *
 * If `previousPersona` is null, calls `deactivatePersona()` to revert to
 * global defaults. If non-null, calls `activatePersona()` to restore the
 * saved persona.
 *
 * If the previous persona is no longer available (deleted while the workflow
 * was running), silently falls back to global defaults.
 *
 * @param previousPersona - The persona name saved by `switchWorkflowPersona()`, or null.
 * @param personaManager - The active `PersonaManager` instance.
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-008
 */
export async function revertWorkflowPersona(
	previousPersona: string | null,
	personaManager: PersonaManager
): Promise<void> {
	if (previousPersona !== null) {
		const restored = await personaManager.activatePersona(previousPersona);
		if (!restored) {
			// Persona was deleted while workflow was running — fall back to defaults
			log.warn("Previous persona no longer available after workflow, deactivating", {
				previousPersona,
			});
			personaManager.deactivatePersona();
		} else {
			log.info("Workflow persona reverted", { previousPersona });
		}
	} else {
		personaManager.deactivatePersona();
		log.info("Workflow persona reverted to global defaults");
	}
}

// ---------------------------------------------------------------------------
// E-009: "Notor: Run workflow" command palette picker
// ---------------------------------------------------------------------------

/**
 * FuzzySuggestModal subclass that lists all discovered workflows and
 * calls a callback when the user selects one.
 *
 * Used by the "Notor: Run workflow" command palette entry.
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-009
 */
class WorkflowPickerModal extends FuzzySuggestModal<Workflow> {
	constructor(
		app: App,
		private readonly workflows: Workflow[],
		private readonly onSelect: (workflow: Workflow) => void,
		private readonly notorDir: string
	) {
		super(app);
		this.setPlaceholder("Select a workflow to run…");
	}

	getItems(): Workflow[] {
		return this.workflows;
	}

	getItemText(workflow: Workflow): string {
		return workflow.display_name;
	}

	onChooseItem(workflow: Workflow): void {
		this.onSelect(workflow);
	}

	/** Override to show an informational empty state message. */
	onNoSuggestion(): void {
		// The base class renders "No match found" — we surface a custom
		// empty-list message only when the query is empty and workflows is [].
		if (this.workflows.length === 0) {
			this.resultContainerEl.empty();
			const msg = this.resultContainerEl.createDiv({ cls: "notor-workflow-picker-empty" });
			msg.textContent = `No workflows found in ${this.notorDir}/workflows/`;
		}
	}
}

/**
 * Open the workflow picker modal.
 *
 * Refreshes the workflow list via `rescanWorkflows()` before showing the
 * picker so that newly created or deleted workflows are reflected without
 * a plugin reload (FR-41 requirement). When the user selects a workflow,
 * the provided `onSelect` callback is invoked.
 *
 * If no workflows are discovered, the modal still opens and shows an
 * informational empty-state message.
 *
 * @param app - The Obsidian `App` instance.
 * @param rescanWorkflows - Async function that rescans and returns all discovered workflows.
 * @param onSelect - Callback invoked with the selected `Workflow`.
 * @param notorDir - The Notor directory path (for the empty-state message).
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-009
 */
export async function showWorkflowPicker(
	app: App,
	rescanWorkflows: () => Promise<Workflow[]>,
	onSelect: (workflow: Workflow) => void,
	notorDir: string
): Promise<void> {
	log.debug("Opening workflow picker — rescanning workflows");

	let workflows: Workflow[];
	try {
		workflows = await rescanWorkflows();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error("Workflow rescan failed before picker open", { error: msg });
		new Notice(`Failed to load workflows: ${msg}`);
		return;
	}

	log.info("Workflow picker opened", { count: workflows.length });

	const modal = new WorkflowPickerModal(app, workflows, onSelect, notorDir);
	modal.open();
}
