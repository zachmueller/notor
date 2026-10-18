/**
 * `api.runTool` — call one tool by name, outside any conversation, through the
 * same dispatcher, policy, and approval checks as a chat tool call.
 */

import { ConfigResolver } from "../chat/config-resolver";
import type { ToolPolicyContext } from "../chat/tool-policy";
import { canonicalToolName } from "../tools/tool-aliases";
import { resolveNote } from "../utils/resolve-note";
import type { NotorApiHost } from "./host";
import { resolveApproval, resolveMode } from "./options";
import { NotorApiError, type NotorToolOptions, type NotorToolResult } from "./types";

/**
 * Tools that only work inside a conversation or circuit turn (they need a
 * session, an interaction channel, or a circuit context).
 */
const SESSION_ONLY_TOOLS = new Set(["run_circuit", "submit_plan", "ask_user", "use_subagent"]);

export async function runTool(
	host: NotorApiHost,
	name: string,
	params: Record<string, unknown>,
	opts: NotorToolOptions = {},
): Promise<NotorToolResult> {
	const toolName = canonicalToolName(name);
	const dispatcher = host.getToolDispatcher();
	const tool = dispatcher.getTool(toolName);
	if (!tool) throw new NotorApiError("not_found", `No tool named '${name}'.`);
	if (tool.internal || SESSION_ONLY_TOOLS.has(toolName)) {
		throw new NotorApiError("unsupported_tool", `'${toolName}' only works inside a conversation or circuit.`);
	}
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		throw new NotorApiError("invalid_option", "params must be an object.");
	}

	const label = `A script's ${toolName} call`;
	const mode = resolveMode(opts.mode) ?? host.settings.mode;
	const approvalOverride = resolveApproval(host, opts.approval, label);

	// Same effective config a chat turn resolves: global settings, rules-free,
	// under the active persona.
	const persona = host.getPersonaManager().getActivePersona();
	const resolver = new ConfigResolver(host.settings, host.getSystemPromptBuilder(), dispatcher);
	const { effective } = await resolver.resolveEffectiveConfig(undefined, null, persona, mode);
	const resolveVaultPath = (p: string) => resolveNote(p, host.app.vault, host.app.metadataCache)?.path ?? null;
	const policyCtx: ToolPolicyContext = {
		effectiveConfig: effective,
		mode,
		domainDenylist: host.settings.domain_denylist,
		vaultRootPath: host.vaultRootPath ?? "",
		resolveVaultPath,
		approvalOverride,
	};

	const approval = host.getRunApproval?.(label);
	const result = await dispatcher.dispatch(
		toolName,
		params,
		mode,
		`api:${crypto.randomUUID()}`,
		opts.signal,
		undefined,
		policyCtx,
		// Never undefined in the plugin: without a callback the dispatcher would
		// auto-approve everything policy leaves for a human.
		approval?.callback ?? (async () => "rejected" as const),
		undefined,
		approval?.hook,
	);

	return {
		toolName,
		success: result.success,
		result: result.result,
		...(result.error ? { error: result.error } : {}),
		...(result.duration_ms !== undefined ? { durationMs: result.duration_ms } : {}),
	};
}
