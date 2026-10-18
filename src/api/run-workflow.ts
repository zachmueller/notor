/**
 * `api.runWorkflow` — run a workflow headless (an isolated background
 * conversation) or visibly in the main chat panel or a new tab.
 */

import type { ChatOrchestrator } from "../chat/orchestrator";
import type { ApprovalOverride } from "../chat/tool-policy";
import { buildPromptWithAttachments, extractWikilinkAttachments } from "../context/wikilink-attachments";
import type { ConversationMode, Workflow } from "../types";
import type { NotorApiHost } from "./host";
import { discoverWorkflowsNow } from "./discovery";
import { collectNotesTouched } from "./notes-touched";
import { applyInclude, linkSignal, openTargetPanel, resolveApproval, resolveDisplay, resolveMode } from "./options";
import { matchWorkflows } from "./resolve";
import type { RunTracker } from "./run-tracker";
import { NotorApiError, type NotorRunInfo, type NotorRunOptions, type NotorRunResult } from "./types";

interface WorkflowRunParams {
	workflow: Workflow;
	text: string;
	mode?: ConversationMode;
	approvalOverride?: ApprovalOverride;
	signal: AbortSignal;
	update: (patch: Partial<NotorRunInfo>) => void;
}

export async function runWorkflow(
	host: NotorApiHost,
	tracker: RunTracker,
	nameOrPath: string,
	opts: NotorRunOptions = {},
): Promise<NotorRunResult> {
	const matches = matchWorkflows(discoverWorkflowsNow(host), nameOrPath);
	if (matches.length === 0) throw new NotorApiError("not_found", `No workflow named '${nameOrPath}'.`);
	if (matches.length > 1) {
		throw new NotorApiError(
			"ambiguous",
			`'${nameOrPath}' matches ${matches.length} workflows (${matches.map((w) => w.file_path).join(", ")}). Pass a vault path.`,
		);
	}
	const workflow = matches[0]!;
	const mode = resolveMode(opts.mode);
	const display = resolveDisplay(opts.display);
	const approvalOverride = resolveApproval(host, opts.approval, `Workflow '${workflow.display_name}'`);
	const panel = display === "headless" ? null : await openTargetPanel(host, display);

	const controller = new AbortController();
	linkSignal(controller, opts.signal);
	const initial: NotorRunInfo = {
		runId: `wf-${crypto.randomUUID().slice(0, 12)}`,
		kind: "workflow",
		name: workflow.display_name,
		status: "running",
	};

	const handle = tracker.start(initial, () => controller.abort(), async (update) => {
		const params: WorkflowRunParams = {
			workflow,
			text: opts.prompt ?? "",
			mode,
			approvalOverride,
			signal: controller.signal,
			update,
		};
		const { final, attachedPaths } = panel
			? await runInPanel(host, panel, params)
			: await runHeadless(host, params);
		if (final.conversationId && opts.include?.includes("notes")) {
			Object.assign(final, await collectNotesTouched(host, { conversationIds: [final.conversationId], attachedPaths }));
		}
		return final;
	}, (info) => applyInclude(info, opts.include));

	if (opts.wait === false) return handle;
	const final = await handle.done;
	return { ...final, done: handle.done };
}

async function runHeadless(
	host: NotorApiHost,
	p: WorkflowRunParams,
): Promise<{ final: Partial<NotorRunInfo>; attachedPaths: string[] }> {
	// The background loop doesn't hydrate attachment snapshots, so linked notes
	// are inlined into the prompt text instead.
	const { prompt, attachments } = await buildPromptWithAttachments(host.app, p.text);
	const orchestrator = host.createHeadlessOrchestrator();
	try {
		const result = await orchestrator.runWorkflowHeadless(p.workflow, prompt, {
			mode: p.mode,
			approvalOverride: p.approvalOverride,
			abortSignal: p.signal,
			title: `Workflow: ${p.workflow.display_name}`,
			onConversationCreated: (conversationId) => p.update({ conversationId }),
		});
		return {
			final: {
				status: p.signal.aborted ? "cancelled" : "completed",
				conversationId: result.conversationId,
				text: result.text,
				costUsd: result.costUsd,
			},
			attachedPaths: attachments.map((a) => a.path),
		};
	} finally {
		await orchestrator.destroy();
	}
}

async function runInPanel(
	host: NotorApiHost,
	orchestrator: ChatOrchestrator,
	p: WorkflowRunParams,
): Promise<{ final: Partial<NotorRunInfo>; attachedPaths: string[] }> {
	// The panel's response loop rebuilds attachments from snapshots, so linked
	// notes attach as chips, exactly as when typed into the chat input.
	const { text, attachments } = extractWikilinkAttachments(host.app, p.text);
	let conversationId: string | undefined;
	const stop = () => {
		if (conversationId) orchestrator.getActiveSession(conversationId)?.abortController.abort();
	};
	p.signal.addEventListener("abort", stop, { once: true });

	try {
		const ran = await orchestrator.executeWorkflow(p.workflow, text, {
			attachments,
			mode: p.mode,
			approvalOverride: p.approvalOverride,
			onConversationCreated: (id) => {
				conversationId = id;
				p.update({ conversationId: id });
				if (p.signal.aborted) stop();
			},
		});
		if (!ran) {
			return {
				final: { status: "failed", error: "The workflow didn't start (see the notice in Obsidian).", errorCode: "run_failed" },
				attachedPaths: [],
			};
		}

		// The panel's display manager holds the synced turn once the run settles.
		const manager = orchestrator.getConversationManager();
		const showing = manager.getActiveConversation()?.id === ran;
		const lastText = showing
			? [...manager.getMessages()].reverse()
				.find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.length > 0)?.content
			: undefined;
		return {
			final: {
				status: p.signal.aborted ? "cancelled" : "completed",
				conversationId: ran,
				text: typeof lastText === "string" ? lastText : undefined,
				costUsd: showing ? manager.getActiveConversation()?.estimated_cost ?? undefined : undefined,
			},
			attachedPaths: attachments.map((a) => a.path),
		};
	} finally {
		p.signal.removeEventListener("abort", stop);
	}
}
