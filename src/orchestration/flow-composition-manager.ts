/**
 * `FlowCompositionManager` (INT-041 / FR-171) — stateless invocable-flow
 * discovery behind the `run_flow` tool (INT-042).
 *
 * It mirrors `SubAgentManager` (`src/sub-agents/manager.ts`) precisely: **no
 * active state**, re-scan per request. A flow becoming (un)invocable on disk is
 * reflected on the next scan with no cache invalidation bookkeeping — exactly as
 * `SubAgentManager` re-discovers profiles each call.
 *
 * It is the resolver behind `run_flow`'s dynamic `flow` enum: the tool calls
 * {@link listInvocableFlows} to build the enum + the per-flow `notor-flow-inputs`
 * descriptions for its dynamic `get description()` / `get input_schema()`,
 * exactly as `UseSubagentTool` calls `SubAgentManager`. Resolution
 * ({@link resolveFlow}) looks up one invocable flow by name.
 *
 * Discovery reuses {@link FlowDefinitionParser.discoverFlows} (which already
 * excludes `sessions/`, `steps/`, and `memories.md`) and the `INT-040`
 * composition-field parse — no new scan/parser is introduced.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-7-composability.md — INT-041
 * @see specs/ZZ-misc/orchestration/contracts/tools.md — run_flow (dynamic enum)
 */

import type { Vault, MetadataCache } from "obsidian";
import { FlowDefinitionParser } from "./flow-parser";
import type { OrchestrationFlow } from "./types";
import { logger } from "../utils/logger";

const log = logger("FlowCompositionManager");

export class FlowCompositionManager {
	private readonly parser: FlowDefinitionParser;

	constructor(
		vault: Vault,
		metadataCache: MetadataCache,
		private readonly notorDir: string,
	) {
		this.parser = new FlowDefinitionParser(vault, metadataCache, notorDir);
	}

	/**
	 * Re-scan `{notor_dir}/orchestrations/*` and return only the flows whose
	 * `definition.md` declares `notor-flow-invocable: true`, each carrying its
	 * `notor-flow-inputs` / `notor-flow-returns` contract. Holds **no** active
	 * state: a flow toggled (un)invocable on disk is reflected on the next call.
	 *
	 * One unparseable flow never blocks the rest — `discoverFlows()` already logs
	 * and excludes a bad flow.
	 */
	async listInvocableFlows(): Promise<OrchestrationFlow[]> {
		try {
			const parsed = await this.parser.discoverFlows();
			return parsed.map((p) => p.flow).filter((f) => f.invocable);
		} catch (e) {
			log.warn("Invocable-flow discovery failed", { error: String(e) });
			return [];
		}
	}

	/**
	 * Resolve one **invocable** flow by its `notor-flow-name` (an exact match).
	 * Returns `null` for an unknown name or a flow that is not invocable — the
	 * caller (`run_flow`) surfaces that as a `success: false` tool error, never a
	 * throw.
	 */
	async resolveFlow(name: string): Promise<OrchestrationFlow | null> {
		const flows = await this.listInvocableFlows();
		return flows.find((f) => f.name === name) ?? null;
	}
}
