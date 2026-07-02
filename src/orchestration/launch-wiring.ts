/**
 * Orchestration launch wiring (FEAT-011) — the stack-composition half of the
 * former `launch.ts`. Builds a fully-wired {@link StepTurnExecutor} from the
 * host's chat stack and the two per-step runtime factories (conversation +
 * code) behind it, plus the vault-adapter-backed fs seams the session log and
 * task registry read/write through.
 *
 * The real {@link StepRuntimeFactory} composes the persona-pinned system prompt
 * and a per-step `ToolDispatcher` via the existing `ConfigResolver` /
 * `SystemPromptBuilder` — no reimplementation of system-prompt assembly. The
 * resolved provider/model comes from the pure `resolvePersonaProviderConfig(...)`
 * pinned by `StepTurnExecutor`, so concurrent step turns never race on the global
 * registry.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-011
 * @see specs/ZZ-misc/arch-review-july-2026/F6-launch-ts-decomposition.md
 */

import { Notice, normalizePath } from "obsidian";
import type { App } from "obsidian";
import type { OrchestrationHost } from "./host";
import { ToolDispatcher } from "../chat/dispatcher";
import { ConfigResolver } from "../chat/config-resolver";
import type { ToolDefinition } from "../providers/provider";
import type { EffectiveToolConfig } from "../tool-config/types";
import type { Tool } from "../tools/tool";
import { buildLibs, buildObsidianExports } from "../extensions/runtime-context";
import { resolveNote } from "../utils/resolve-note";
import { NoteOpener } from "../tools/note-opener";
import { resolveIncludeNotes } from "../include-note/resolver";
import { StepPromptBuilder } from "./step-prompt-builder";
import { StepTurnExecutor, type StepRuntime, type StepRuntimeFactory } from "./step-turn-executor";
import type { ToolPolicyContext } from "../chat/tool-policy";
import { CodeStepExecutor, type CodeStepRuntime, type CodeStepRuntimeFactory } from "./code-step-executor";
import type { ScratchpadFs } from "./orchestration-helper";
import { SessionLog, type SessionLogWriter } from "./session-log";
import { type SessionFs } from "./session-manager";
import { TaskRegistry, type TaskFs } from "./task-registry";
import { memoriesPath } from "./memories";
import { VaultStepConversationStore } from "./step-conversation-store";
import { showOrchestrationProgressNotice } from "./notices";
import { jumpToStepConversation } from "../ui/orchestration-modals";

/**
 * Query a session's still-open/running tasks for the runner's `FLOW_COMPLETE`
 * enforcement (INT-003). Backed by the same vault-adapter {@link TaskRegistry}
 * the task-tool scaffolds write through, so the open-task set the runner reads is
 * exactly what those tools persisted.
 */
export async function listOpenTaskKeys(
	host: OrchestrationHost,
	tasksPath: string,
): Promise<Array<{ key: string; description: string }>> {
	const adapter = host.app.vault.adapter;
	const fs: TaskFs = {
		exists: (p) => adapter.exists(normalizePath(p)),
		read: (p) => adapter.read(normalizePath(p)),
		write: async (p, data) => adapter.write(normalizePath(p), data),
		mkdir: async (p) => adapter.mkdir(normalizePath(p)),
		list: async (dir) => {
			const norm = normalizePath(dir);
			if (!(await adapter.exists(norm))) return [];
			return (await adapter.list(norm)).files;
		},
	};
	const open = await new TaskRegistry(fs).listOpen(tasksPath);
	return open.map((t) => ({ key: t.key, description: t.description }));
}

/**
 * Build the {@link StepTurnExecutor} wired to the host's chat stack. Shared by
 * a fresh launch and a recovery resume so both run on the identical runtime.
 *
 * `committedKeys` is the SHARED `once()` skip set for the whole run (seeded empty
 * on a fresh launch, or from the recovered log on resume so an already-committed
 * external effect is not re-run — FR-125 / INT-010).
 */
export function buildExecutor(
	host: OrchestrationHost,
	sessionLog: SessionLog,
	committedKeys: Set<string>,
	openNotesInEditor: boolean,
): StepTurnExecutor {
	// INT-006: persist each step conversation (hidden from the flat list) with its
	// orchestration_edges header into the chat history directory.
	const stepConversationStore = new VaultStepConversationStore(
		new VaultSessionFs(host.app),
		host.settings.history_path,
	);
	// INT-010: the deterministic code-step executor (notor-step-mode: code).
	const codeStepExecutor = new CodeStepExecutor(
		{
			runtimeFactory: makeCodeStepRuntimeFactory(host, committedKeys, openNotesInEditor),
			notifyError: (message: string) => new Notice(message),
		},
		sessionLog,
	);
	return new StepTurnExecutor(
		{
			personaManager: {
				getPersonaByName: (name: string) => host.getPersonaManager().getPersonaByName(name),
			},
			providerRegistry: host.getProviderRegistry(),
			settings: host.settings,
			promptBuilder: new StepPromptBuilder(),
			runtimeFactory: makeRuntimeFactory(host, openNotesInEditor),
			memoriesPath: memoriesPath(host.settings.notor_dir),
			stepConversationStore,
			codeStepExecutor,
			// INT-020 / INT-021: per-turn progress Notice. The jump callback reuses
			// the existing notor-conversation:// navigation primitive
			// (`switchToConversationById`, the same path main.ts's obsidian://notor?id=
			// handler uses) — no new navigation is introduced. The closure resolves the
			// active orchestrator lazily at right-click time (a panel may not be open
			// when the flow is launched from a hook).
			showProgressNotice: ({ flowName, stepName, iteration, emittedTopic, conversationId }) =>
				showOrchestrationProgressNotice({
					flowName,
					stepName,
					iteration,
					emittedTopic,
					conversationId,
					onJumpToConversation: () => jumpToStepConversation(host, conversationId),
				}),
			resolveIncludes: async (body, notePath) => {
				const result = await resolveIncludeNotes(
					body,
					host.app.vault,
					host.app.metadataCache,
					notePath,
					"workflow",
				);
				return result.inlineContent;
			},
		},
		sessionLog,
	);
}

/** A {@link SessionLogWriter} backed by Obsidian's append-only adapter. */
export class VaultSessionLogWriter implements SessionLogWriter {
	constructor(private readonly app: App) {}

	async append(path: string, data: string): Promise<void> {
		const dir = path.slice(0, path.lastIndexOf("/"));
		// Ensure the session directory exists before the first append.
		if (dir && !(await this.app.vault.adapter.exists(dir))) {
			await this.app.vault.adapter.mkdir(dir);
		}
		await this.app.vault.adapter.append(path, data);
	}
}

/** A {@link SessionFs} backed by Obsidian's vault adapter (INT-001). */
export class VaultSessionFs implements SessionFs {
	constructor(private readonly app: App) {}

	exists(path: string): Promise<boolean> {
		return this.app.vault.adapter.exists(normalizePath(path));
	}

	async mkdir(path: string): Promise<void> {
		const norm = normalizePath(path);
		// Obsidian's adapter.mkdir is not recursive — create parents first.
		const parts = norm.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(current))) {
				await this.app.vault.adapter.mkdir(current);
			}
		}
	}

	async write(path: string, data: string): Promise<void> {
		const norm = normalizePath(path);
		const dir = norm.slice(0, norm.lastIndexOf("/"));
		if (dir && !(await this.app.vault.adapter.exists(dir))) {
			await this.mkdir(dir);
		}
		// Atomic write: write to a temp file, then rename over the target. Obsidian's
		// desktop adapter.rename REFUSES to overwrite an existing file ("Destination
		// file already exists!"), so the target must be removed first — the same idiom
		// dedup-cache.ts uses. The remove→rename window is non-atomic but far narrower
		// than the torn read→mutate→write it replaces.
		const tmp = norm + ".tmp";
		await this.app.vault.adapter.write(tmp, data);
		if (await this.app.vault.adapter.exists(norm)) {
			await this.app.vault.adapter.remove(norm);
		}
		await this.app.vault.adapter.rename(tmp, norm);
	}

	read(path: string): Promise<string> {
		return this.app.vault.adapter.read(normalizePath(path));
	}
}

/**
 * The persona type threaded to a conversation step's dispatcher assembly (the
 * `persona` arg of {@link StepRuntimeFactory.build}). A code step passes `null`.
 */
type StepPersona = Parameters<StepRuntimeFactory["build"]>[0]["persona"];

/**
 * Assemble a fresh per-step {@link ToolDispatcher} + its resolved effective
 * config and filtered tool definitions — the assembly the conversation-step and
 * code-step runtime factories previously duplicated byte-for-byte (F6 §4.1). The
 * only variation is the `persona`: a conversation step pins the active persona
 * name and resolves the effective config against it; a code step passes `null`
 * (which leaves the dispatcher's default `activePersonaName` of `null` untouched,
 * so passing it is behavior-neutral vs. the old omit).
 */
async function assembleStepDispatcher(
	host: OrchestrationHost,
	opts: { persona: StepPersona; openNotesInEditor: boolean },
): Promise<{ dispatcher: ToolDispatcher; effective: EffectiveToolConfig; toolDefinitions: ToolDefinition[] }> {
	const settings = host.settings;
	const registry = host.getToolRegistry();

	// A fresh per-step dispatcher (mirrors the sub-agent dispatcher pattern), so
	// concurrent step turns don't share mutable dispatcher state.
	const dispatcher = new ToolDispatcher();
	for (const tool of registry.getAll()) {
		dispatcher.registerTool(tool);
	}
	dispatcher.setSettings(settings);
	// Honor the orchestration note-opening decision (global setting or the per-flow
	// `notor-open-notes-in-editor` override), independent of the chat
	// `open_notes_on_access` setting, for every tool this step dispatches.
	dispatcher.setOpenNotesOverride(opts.openNotesInEditor);
	dispatcher.setActivePersonaName(opts.persona?.name ?? null);
	if (host.vaultRootPath) dispatcher.setVaultRootPath(host.vaultRootPath);
	dispatcher.setResolveVaultPath((p: string) => {
		const file = resolveNote(p, host.app.vault, host.app.metadataCache);
		return file?.path ?? null;
	});

	// Filtered tool definitions via the shared ConfigResolver path.
	const configResolver = new ConfigResolver(
		settings,
		host.getSystemPromptBuilder(),
		dispatcher,
	);
	configResolver.setGetToolDefinitions((effective?: EffectiveToolConfig) =>
		buildToolDefinitions(registry.getAll(), effective),
	);
	const { effective, toolDefinitions } = await configResolver.resolveEffectiveConfig(
		undefined,
		null,
		opts.persona,
	);
	return { dispatcher, effective, toolDefinitions };
}

/**
 * Build the real per-step {@link StepRuntimeFactory} from the host. Each call
 * to `build` composes the persona system prompt + filtered tool definitions +
 * a per-step dispatcher (with the orchestration session context bound via the
 * dispatcher's session-context seam).
 */
export function makeRuntimeFactory(host: OrchestrationHost, openNotesInEditor: boolean): StepRuntimeFactory {
	return {
		async build({ step, persona, resolved, mode, orchestrationContext }): Promise<StepRuntime> {
			const settings = host.settings;

			const { dispatcher, effective, toolDefinitions } = await assembleStepDispatcher(host, {
				persona,
				openNotesInEditor,
			});

			// Persona-composed system prompt (append/replace per the persona's mode).
			const systemPrompt = await host
				.getSystemPromptBuilder()
				.assemble(
					host.settings.mode,
					toolDefinitions,
					undefined,
					undefined,
					persona,
					settings.memory_enabled,
					null,
					settings.enable_popover_references,
				);

			const provider = host.getProviderRegistry().getProvider(resolved.providerId);

			// F2: build the per-step policy context so the step's RunLoop gates its
			// tool calls through the pure engine (command patterns / paths /
			// plan-mode / denylist). The scratchpad (+ a shared-handoff child's
			// parent scratchpad) is auto-allowed IN ADDITION to each tool's
			// configured allowed_paths, sourced from the orchestrationContext.
			const policyCtx: ToolPolicyContext = {
				effectiveConfig: effective,
				mode,
				domainDenylist: settings.domain_denylist,
				vaultRootPath: host.vaultRootPath ?? "",
				resolveVaultPath: (p: string) => {
					const file = resolveNote(p, host.app.vault, host.app.metadataCache);
					return file?.path ?? null;
				},
				sessionAllowedPaths: [
					orchestrationContext.scratchpadPath,
					...(orchestrationContext.parentScratchpadPath
						? [orchestrationContext.parentScratchpadPath]
						: []),
				],
			};

			void step;

			return { provider, dispatcher, toolDefinitions, systemPrompt, policyCtx };
		},
	};
}

/**
 * Build the real per-step {@link CodeStepRuntimeFactory} (INT-010). Each call
 * assembles:
 *  - `utils` / `libs` / `obsidian` — the **identical** objects user-defined
 *    tools receive (`buildUtils()` / `buildLibs()` / `buildObsidianExports()`),
 *    so a code step inherits `utils.executeShellCommand` / `utils.notify` / … unchanged;
 *  - a fresh per-step `ToolDispatcher` (registry + effective config + vault root),
 *    so `orchestration.callTool` / `callMcpTool` dispatch through the same seam as
 *    LLM tool calls and honor path enforcement + the auto-allowed scratchpad path;
 *  - a vault-adapter-backed scratchpad FS + the shared {@link TaskRegistry}.
 *
 * `committedKeys` is the run-wide `once()` skip set (mutated in place as guarded
 * effects commit), shared with the conversation path.
 */
export function makeCodeStepRuntimeFactory(
	host: OrchestrationHost,
	committedKeys: Set<string>,
	openNotesInEditor: boolean,
): CodeStepRuntimeFactory {
	const adapter = host.app.vault.adapter;
	const scratchpadFs: ScratchpadFs = {
		read: async (path) => {
			const norm = normalizePath(path);
			if (!(await adapter.exists(norm))) return null;
			return adapter.read(norm);
		},
		write: async (path, content) => {
			const norm = normalizePath(path);
			const dir = norm.slice(0, norm.lastIndexOf("/"));
			if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
			await adapter.write(norm, content);
		},
		exists: (path) => adapter.exists(normalizePath(path)),
		list: async (dir) => {
			const norm = normalizePath(dir);
			if (!(await adapter.exists(norm))) return [];
			return (await adapter.list(norm)).files;
		},
	};
	const taskFs: TaskFs = {
		exists: (p) => adapter.exists(normalizePath(p)),
		read: (p) => adapter.read(normalizePath(p)),
		write: async (p, data) => {
			const norm = normalizePath(p);
			const dir = norm.slice(0, norm.lastIndexOf("/"));
			if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
			await adapter.write(norm, data);
		},
		mkdir: async (p) => {
			const norm = normalizePath(p);
			if (!(await adapter.exists(norm))) await adapter.mkdir(norm);
		},
		list: async (dir) => {
			const norm = normalizePath(dir);
			if (!(await adapter.exists(norm))) return [];
			return (await adapter.list(norm)).files;
		},
	};
	const taskRegistry = new TaskRegistry(taskFs);

	return {
		async build({ orchestrationContext, mode, abortSignal }): Promise<CodeStepRuntime> {
			const settings = host.settings;

			// A code step assembles the same per-step dispatcher as a conversation
			// step, minus the persona pin (it passes `null`) — so
			// `orchestration.callTool`/`callMcpTool` dispatch through the same seam as
			// LLM tool calls and honor path enforcement + the auto-allowed scratchpad.
			const { dispatcher, effective } = await assembleStepDispatcher(host, {
				persona: null,
				openNotesInEditor,
			});

			// utils/libs/obsidian — IDENTICAL to user-defined tools, except the
			// note-opener honors the orchestration note-opening decision (a code step
			// may call `utils.notes.open` directly, bypassing the dispatcher).
			const utils = host.buildExtensionUtils();
			utils._setNoteOpener(new NoteOpener(
				host.app,
				openNotesInEditor,
				settings.focus_notes_on_access,
			));
			utils.abortSignal = abortSignal;
			// The scaffold task tools (and any orchestration-aware tool reached via
			// callTool) read the session carriage off utils, exactly as a step turn.
			utils.orchestrationContext = orchestrationContext;
			const libs = buildLibs();
			const obsidian = buildObsidianExports();

			// F2: policy context for `orchestration.callTool`/`callMcpTool` dispatch —
			// same construction as the conversation-step factory, with the scratchpad
			// (+ parent scratchpad) auto-allowed in addition to each tool's configured
			// allowed_paths.
			const policyCtx: ToolPolicyContext = {
				effectiveConfig: effective,
				mode,
				domainDenylist: settings.domain_denylist,
				vaultRootPath: host.vaultRootPath ?? "",
				resolveVaultPath: (p: string) => {
					const file = resolveNote(p, host.app.vault, host.app.metadataCache);
					return file?.path ?? null;
				},
				sessionAllowedPaths: [
					orchestrationContext.scratchpadPath,
					...(orchestrationContext.parentScratchpadPath
						? [orchestrationContext.parentScratchpadPath]
						: []),
				],
			};

			return {
				app: host.app,
				obsidian,
				utils,
				libs,
				dispatcher,
				scratchpadFs,
				taskRegistry,
				committedKeys,
				policyCtx,
			};
		},
	};
}

/** Compute filtered `ToolDefinition[]` from the registry + an effective config. */
export function buildToolDefinitions(
	tools: Tool[],
	effective?: EffectiveToolConfig,
): ToolDefinition[] {
	const defs: ToolDefinition[] = [];
	for (const tool of tools) {
		const entry = effective?.tools[tool.name];
		if (!entry || !entry.enabled) continue;
		defs.push({
			name: tool.name,
			description: tool.description,
			input_schema: tool.input_schema as ToolDefinition["input_schema"],
			mode: tool.mode,
		});
	}
	return defs;
}
