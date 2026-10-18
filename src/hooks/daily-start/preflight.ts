/**
 * Provider pre-flight for daily-start targets.
 *
 * The first boot of the day is when credentials have expired or the network
 * isn't up yet. Before launching an AI-backed target, resolve the provider(s)
 * it will use and validate each one, so a failure is reported (and retried)
 * before the run has any side effects.
 */

import type { Persona, Workflow } from "../../types";
import type { NotorSettings } from "../../settings/types";
import type { ProviderRegistry } from "../../providers";
import type { Circuit } from "../../circuits/types";
import { ProviderError } from "../../providers/provider";
import { isTransientNetworkError } from "../../providers/network-errors";
import { resolvePersonaProviderConfig } from "../../personas/provider-config-resolver";
import { resolvePreset } from "../../presets/preset-resolver";
import { matchCircuits } from "../../api/resolve";
import type { TriggerTarget } from "../trigger-sources";
import { hookCircuitRef } from "../hook-action-type";

/** Why a provider failed pre-flight. */
export type PreflightFailureKind = "auth" | "network" | "unavailable" | "error";

export interface PreflightFailure {
	providerId: string;
	/** Provider display name for Notices. */
	providerLabel: string;
	kind: PreflightFailureKind;
	message: string;
}

export interface PreflightDeps {
	getSettings: () => NotorSettings;
	registry: ProviderRegistry;
	getActivePersona: () => Persona | null;
	getPersonaByName: (name: string) => Promise<Persona | null>;
	getDiscoveredWorkflows: () => Workflow[];
	getDiscoveredCircuits: () => Circuit[];
}

/** True when a target talks to an LLM (and so needs a pre-flight). */
export function needsPreflight(target: TriggerTarget): boolean {
	switch (target.kind) {
		case "workflow":
		case "circuit":
			return true;
		case "automation":
			return false;
		case "hook":
			return target.hook.action_type !== "execute_command";
	}
}

/** Classify a `validateConnection()` failure. */
export function classifyPreflightError(e: unknown): PreflightFailureKind {
	const code = e instanceof ProviderError ? e.code : null;
	if (code === "AUTH_FAILED") return "auth";
	// Bedrock wraps network failures as PROVIDER_ERROR with the original error
	// as `cause`, so check the cause chain as well as the code.
	if (code === "CONNECTION_FAILED" || isTransientNetworkError(e)) return "network";
	if (code === "SERVICE_UNAVAILABLE" || code === "RATE_LIMITED") return "unavailable";
	return "error";
}

/** Human-readable reason for a failure (used in Notices). */
export function describePreflightFailure(f: PreflightFailure): string {
	switch (f.kind) {
		case "auth": return "credentials expired or invalid";
		case "network": return "no network or provider unreachable";
		case "unavailable": return "provider unavailable";
		case "error": return `provider error: ${f.message}`;
	}
}

/** Distinct provider ids a target will use. */
export async function resolveTargetProviders(target: TriggerTarget, deps: PreflightDeps): Promise<string[]> {
	const ids = new Set<string>();
	const addWorkflow = async (workflow: Workflow | null) => {
		ids.add(await workflowProviderId(workflow, deps));
	};
	const addCircuit = async (circuit: Circuit | null) => {
		if (!circuit) return;
		for (const step of circuit.steps) {
			if (step.mode === "code") continue;
			const persona = step.persona ? await deps.getPersonaByName(step.persona) : null;
			ids.add(resolvePersonaProviderConfig(persona, step.model, deps.getSettings(), deps.registry).providerId);
		}
	};

	switch (target.kind) {
		case "workflow":
			await addWorkflow(target.workflow);
			break;
		case "circuit":
			await addCircuit(target.circuit);
			break;
		case "hook": {
			const { hook } = target;
			if (hook.action_type === "run_workflow") {
				const workflow = deps.getDiscoveredWorkflows().find((w) => w.file_path === hook.workflow_path) ?? null;
				await addWorkflow(workflow);
			} else if (hook.action_type !== "execute_command") {
				const ref = hookCircuitRef(hook) ?? "";
				await addCircuit(matchCircuits(deps.getDiscoveredCircuits(), ref)[0] ?? null);
			}
			break;
		}
		case "automation":
			break;
	}
	return [...ids].filter((id) => id !== "");
}

/**
 * Validate each provider; returns the first failure, or null when all pass.
 * Credentials are reset first so a profile refreshed since the last attempt
 * (e.g. `aws sso login`) is picked up.
 */
export async function runPreflight(providerIds: string[], registry: ProviderRegistry): Promise<PreflightFailure | null> {
	for (const providerId of providerIds) {
		const providerLabel = registry.getConfig(providerId)?.display_name || providerId;
		try {
			registry.resetProviderCredentials(providerId);
			await registry.getProvider(providerId).validateConnection();
		} catch (e) {
			return {
				providerId,
				providerLabel,
				kind: classifyPreflightError(e),
				message: e instanceof Error ? e.message : String(e),
			};
		}
	}
	return null;
}

/**
 * Provider a background workflow will use: the workflow's model preset, else
 * its persona (or the active persona) — mirrors `executeBackgroundWorkflow`.
 */
async function workflowProviderId(workflow: Workflow | null, deps: PreflightDeps): Promise<string> {
	const settings = deps.getSettings();
	if (workflow?.model_preset) {
		const preset = resolvePreset(workflow.model_preset, settings.model_presets);
		if (preset) return preset.providerId;
	}
	const persona = workflow?.persona_name
		? await deps.getPersonaByName(workflow.persona_name)
		: deps.getActivePersona();
	return resolvePersonaProviderConfig(persona, null, settings, deps.registry).providerId;
}
