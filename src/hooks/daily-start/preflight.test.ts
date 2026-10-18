import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../providers/provider";
import type { ProviderRegistry } from "../../providers";
import type { NotorSettings } from "../../settings/types";
import type { VaultEventHook, Workflow } from "../../types";
import {
	classifyPreflightError,
	describePreflightFailure,
	needsPreflight,
	resolveTargetProviders,
	runPreflight,
	type PreflightDeps,
} from "./preflight";
import type { TriggerTarget } from "../trigger-sources";

describe("classifyPreflightError", () => {
	it("maps AUTH_FAILED to auth", () => {
		expect(classifyPreflightError(new ProviderError("expired", "bedrock", "AUTH_FAILED"))).toBe("auth");
	});

	it("maps CONNECTION_FAILED and Bedrock-wrapped network causes to network", () => {
		expect(classifyPreflightError(new ProviderError("down", "local", "CONNECTION_FAILED"))).toBe("network");
		const cause = Object.assign(new Error("getaddrinfo ENOTFOUND bedrock.us-east-1.amazonaws.com"), { code: "ENOTFOUND" });
		const wrapped = new ProviderError(
			`Failed to list Bedrock inference profiles: ${cause.message}`,
			"bedrock",
			"PROVIDER_ERROR",
			cause,
		);
		expect(classifyPreflightError(wrapped)).toBe("network");
	});

	it("maps service unavailability and anything else", () => {
		expect(classifyPreflightError(new ProviderError("busy", "anthropic", "SERVICE_UNAVAILABLE"))).toBe("unavailable");
		expect(classifyPreflightError(new ProviderError("bad model", "openai", "PROVIDER_ERROR"))).toBe("error");
		expect(describePreflightFailure({ providerId: "x", providerLabel: "X", kind: "error", message: "boom" }))
			.toBe("provider error: boom");
	});
});

describe("runPreflight", () => {
	function registry(validate: () => Promise<boolean>) {
		return {
			getConfig: vi.fn().mockReturnValue({ display_name: "AWS Bedrock" }),
			resetProviderCredentials: vi.fn(),
			getProvider: vi.fn().mockReturnValue({ validateConnection: validate }),
		} as unknown as ProviderRegistry & { resetProviderCredentials: ReturnType<typeof vi.fn> };
	}

	it("resets credentials before validating and passes", async () => {
		const reg = registry(async () => true);
		expect(await runPreflight(["bedrock"], reg)).toBeNull();
		expect(reg.resetProviderCredentials).toHaveBeenCalledWith("bedrock");
	});

	it("returns the classified failure", async () => {
		const reg = registry(async () => {
			throw new ProviderError("token expired", "bedrock", "AUTH_FAILED");
		});
		expect(await runPreflight(["bedrock"], reg)).toEqual({
			providerId: "bedrock",
			providerLabel: "AWS Bedrock",
			kind: "auth",
			message: "token expired",
		});
	});
});

describe("needsPreflight / resolveTargetProviders", () => {
	const settings = {
		model_presets: [{ name: "large", provider_id: "anthropic", model_id: "claude", use_extended_context: false, thinking_level: null }],
	} as unknown as NotorSettings;
	const deps: PreflightDeps = {
		getSettings: () => settings,
		registry: {
			getActiveId: () => "bedrock",
			getConfig: () => ({ id: "bedrock", model_id: "m" }),
		} as unknown as ProviderRegistry,
		getActivePersona: () => null,
		getPersonaByName: async () => null,
		getDiscoveredWorkflows: () => [],
		getDiscoveredCircuits: () => [],
	};

	it("skips shell-command hooks and automations", () => {
		const hook = { action_type: "execute_command" } as VaultEventHook;
		expect(needsPreflight({ kind: "hook", key: "h", label: "h", hook })).toBe(false);
		expect(needsPreflight({ kind: "hook", key: "h", label: "h", hook: { ...hook, action_type: "run_workflow" } })).toBe(true);
	});

	it("uses the workflow's model preset, else the active provider", async () => {
		const withPreset = { model_preset: "large", persona_name: null } as unknown as Workflow;
		const plain = { model_preset: null, persona_name: null } as unknown as Workflow;
		expect(await resolveTargetProviders({ kind: "workflow", key: "w", label: "w", workflow: withPreset }, deps)).toEqual(["anthropic"]);
		expect(await resolveTargetProviders({ kind: "workflow", key: "w", label: "w", workflow: plain }, deps)).toEqual(["bedrock"]);
	});
});
