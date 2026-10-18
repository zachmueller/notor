/**
 * Fresh circuit and workflow discovery for API calls. The plugin's caches are
 * filled by the first layout-ready scan and vault events, which can briefly
 * lag behind the vault; an API call reads the vault directly, like the
 * `run_circuit` hook action does.
 */

import { CircuitDefinitionParser } from "../circuits/circuit-parser";
import type { Circuit } from "../circuits/types";
import type { Workflow } from "../types";
import { discoverWorkflows } from "../workflows/workflow-discovery";
import type { NotorApiHost } from "./host";

export async function discoverCircuitsNow(host: NotorApiHost): Promise<Circuit[]> {
	if (!host.settings.circuits_enabled) return [];
	const parser = new CircuitDefinitionParser(host.app.vault, host.app.metadataCache, host.settings.notor_dir);
	return (await parser.discoverCircuits()).map((p) => p.flow);
}

export function discoverWorkflowsNow(host: NotorApiHost): Workflow[] {
	return discoverWorkflows(host.app.vault, host.app.metadataCache, host.settings.notor_dir);
}
