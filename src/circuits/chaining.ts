/**
 * Orchestration chaining handoff (INT-045 / FR-175) — the `notor-on-complete-flow`
 * one-way handoff, extracted from `run-lifecycle.ts` (F6 follow-up) so the core
 * `launchOrchestration` module stays under the ~500-line ceiling.
 *
 * A completed flow that declares `notor-on-complete-flow` launches its successor
 * over the SAME shared budget cell + depth (canSpawnChild semantics), so an
 * A → B → A on-complete cycle terminates at max_depth / the aggregate budget. The
 * handoff is AWAITED (Bug B, F1) — a `run_flow` parent transitively sees the whole
 * chain complete; that is the documented, intended semantics.
 *
 * Mutual recursion crosses the module boundary (this imports `launchOrchestration`;
 * run-lifecycle imports the helpers back). ESM tolerates the cycle because both are
 * used lazily at call time — the same shape as the existing child-spawn↔recovery-boot
 * cycle. `run-lifecycle.test.ts`'s chaining coverage lives in `chaining.test.ts`.
 *
 * @see specs/ZZ-misc/arch-review-july-2026/tasks/06-launch-decomposition.md
 */

import { Notice } from "obsidian";
import type { OrchestrationHost } from "./host";
import { logger } from "../utils/logger";
import { FlowDefinitionParser } from "./flow-parser";
import { OrchestrationSessionManager } from "./session-manager";
import type { OrchestrationRunResult } from "./runner";
import type { OrchestrationFlow } from "./types";
import { VaultSessionFs } from "./launch-wiring";
import { launchOrchestration, type RequestUserInput } from "./run-lifecycle";

const log = logger("OrchestrationLaunch");

/**
 * Resolve a chaining successor's `notor-flow-inputs` by wikilink-stripped flow
 * name (INT-045). Returns `null` when the successor is not discoverable (the
 * HANDOFF section is then simply omitted).
 */
export async function resolveSuccessorInputs(
	host: OrchestrationHost,
	successorName: string,
): Promise<string | null> {
	try {
		const parser = new FlowDefinitionParser(
			host.app.vault,
			host.app.metadataCache,
			host.settings.notor_dir,
		);
		const parsed = await parser.discoverFlows();
		const match = parsed.find((p) => p.flow.name === successorName);
		return match?.flow.flowInputs ?? null;
	} catch {
		return null;
	}
}

/**
 * The successor-launcher signature — {@link launchOrchestration} in production,
 * injectable in tests to observe the gate decision without driving a full run.
 */
export type ChainLauncher = (
	host: OrchestrationHost,
	flow: OrchestrationFlow,
	promptText: string,
	options?: Parameters<typeof launchOrchestration>[3],
) => Promise<OrchestrationRunResult>;

/** Injectable seams for {@link chainToSuccessor} (production defaults built inline). */
export interface ChainDeps {
	/** Resolve the successor flow by name; `null` when not discoverable. */
	resolveSuccessor?: (name: string) => Promise<OrchestrationFlow | null>;
	/** Launch the successor run (defaults to {@link launchOrchestration}). */
	launch?: ChainLauncher;
}

/**
 * Launch a chaining successor (INT-045 / FR-175). Gated exactly like a `run_flow`
 * spawn over the predecessor's live shared budget cell + depth (`canSpawnChild`).
 *
 * **Blocked-handoff behavior (locked by chaining.test.ts, F6 §3.3):** a blocked
 * handoff (depth/budget exhausted) or a non-discoverable successor surfaces a
 * **Notice and stops the chain** — it does **not** launch a successor and does
 * **not** change the predecessor's status. The predecessor already completed; only
 * the further hop is skipped. (The earlier docstring claimed a `FLOW_ERROR`/status-
 * `error` stop; the code never mutated status — the docstring was corrected to
 * match the code, per F1's landed behavior.) The successor, when launched, is a
 * recovery **root**-able `origin: "chaining"` run (recovered as a root once this
 * predecessor is terminal — INT-005).
 *
 * **Bug B (F1):** this handoff is **awaited**, not fire-and-forget — the caller
 * (`launchOrchestration`) awaits `chainToSuccessor`, which awaits the full successor
 * `launchOrchestration`, so a `run_flow` parent transitively awaits the entire
 * chain. That is the current, intended semantics (a `run_flow` caller sees the
 * whole chain's result), locked by a regression test in chaining.test.ts. Making it
 * truly detached would change those semantics and orphan the successor from the
 * abort cascade; it is a follow-up candidate now that the run registry (Fix 1)
 * could own a detached chain.
 *
 * Reached only from `launchOrchestration`'s `result.status === "completed" &&
 * flow.onCompleteFlow` guard — so a chain only ever fires on a **completed**
 * predecessor that declares `notor-on-complete-flow`.
 */
export async function chainToSuccessor(
	host: OrchestrationHost,
	predecessor: OrchestrationFlow,
	predecessorResult: OrchestrationRunResult,
	predecessorSessionId: string,
	requestUserInput?: RequestUserInput,
	deps?: ChainDeps,
): Promise<void> {
	const successorName = predecessor.onCompleteFlow;
	if (!successorName) return;

	const resolveSuccessor =
		deps?.resolveSuccessor ??
		(async (name: string) => {
			const parser = new FlowDefinitionParser(
				host.app.vault,
				host.app.metadataCache,
				host.settings.notor_dir,
			);
			const parsed = await parser.discoverFlows();
			return parsed.find((p) => p.flow.name === name)?.flow ?? null;
		});
	const launch = deps?.launch ?? launchOrchestration;

	const successor = await resolveSuccessor(successorName);
	if (!successor) {
		new Notice(
			`Chaining target '${successorName}' (from '${predecessor.name}') is not discoverable — chain stops.`,
		);
		return;
	}

	// Gate the handoff over the SAME shared cell + depth (canSpawnChild semantics).
	const budget = predecessorResult.budget;
	const depth = predecessorResult.depth;
	const maxDepth =
		successor.maxDepth !== null && successor.maxDepth !== undefined
			? depth + 1 + successor.maxDepth
			: Infinity;
	const blocked =
		depth + 1 >= maxDepth ||
		budget.iterationsRemaining <= 0 ||
		budget.costRemainingUsd <= 0;
	if (blocked) {
		// A blocked handoff stops the chain with a Notice — the predecessor already
		// completed, so its status is left untouched and no successor is launched.
		new Notice(
			`Chain '${predecessor.name}' → '${successorName}' blocked (depth/budget exhausted); chain stops.`,
		);
		log.warn("Chaining handoff blocked — terminating the chain", {
			predecessor: predecessor.name,
			successor: successorName,
			depth,
			budget,
		});
		return;
	}

	// Forward the predecessor's terminal payload (shaped by the HANDOFF section).
	const forwardedPayload = predecessorResult.text;
	new Notice(`Chaining '${predecessor.name}' → '${successorName}'…`);
	await launch(host, successor, forwardedPayload, {
		origin: "chaining",
		parentSessionId: predecessorSessionId,
		// Inherit the SAME shared cell by reference + depth + 1 (bounded cycle).
		inheritedContext: { budget, depth: depth + 1 },
		parentScratchpadPath:
			successor.handoffIsolation === "shared"
				? new OrchestrationSessionManager(
						host.settings.notor_dir,
						new VaultSessionFs(host.app),
					).resolveWorkspace(predecessorSessionId).scratchpadPath
				: undefined,
		requestUserInput,
	});
}
