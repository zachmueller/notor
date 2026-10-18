import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import { createDefaultSettings } from "../defaults";
import { isProviderConfigured, needsInitialSetup } from "../setup-detection";
import type { NotorSettings } from "../types";

/** Build a fake App whose SecretStorage holds the given secrets. */
function fakeApp(secrets: Record<string, string> = {}): App {
	return {
		secretStorage: {
			getSecret: (id: string) => secrets[id] ?? null,
		},
	} as unknown as App;
}

/** Fresh default settings with deep-copied providers/presets (defaults share arrays). */
function freshSettings(): NotorSettings {
	const settings = createDefaultSettings(".obsidian");
	settings.providers = settings.providers.map((p) => ({ ...p }));
	settings.model_presets = settings.model_presets.map((p) => ({ ...p }));
	return settings;
}

function provider(settings: NotorSettings, id: string) {
	return settings.providers.find((p) => p.id === id)!;
}

describe("needsInitialSetup", () => {
	it("default settings need setup", () => {
		expect(needsInitialSetup(fakeApp(), freshSettings())).toBe(true);
	});

	it("local provider with an endpoint does not", () => {
		const settings = freshSettings();
		provider(settings, "local").endpoint = "http://localhost:11434/v1";
		expect(needsInitialSetup(fakeApp(), settings)).toBe(false);
	});

	it("whitespace-only local endpoint still needs setup", () => {
		const settings = freshSettings();
		provider(settings, "local").endpoint = "   ";
		expect(needsInitialSetup(fakeApp(), settings)).toBe(true);
	});

	it("anthropic provider with a stored API key does not", () => {
		const app = fakeApp({ "notor-anthropic-api-key": "sk-ant-test" });
		expect(needsInitialSetup(app, freshSettings())).toBe(false);
	});

	it("any fully configured preset clears setup even if no provider looks configured", () => {
		const settings = freshSettings();
		settings.model_presets[0]!.provider_id = "openai";
		settings.model_presets[0]!.model_id = "gpt-test";
		expect(needsInitialSetup(fakeApp(), settings)).toBe(false);
	});
});

describe("isProviderConfigured — bedrock", () => {
	it("access keys need both secrets", () => {
		const settings = freshSettings();
		const bedrock = provider(settings, "bedrock");
		bedrock.aws_auth_method = "keys";
		const oneKey = fakeApp({ "notor-bedrock-access-key-id": "AKIA" });
		const bothKeys = fakeApp({
			"notor-bedrock-access-key-id": "AKIA",
			"notor-bedrock-secret-access-key": "secret",
		});
		expect(isProviderConfigured(oneKey, bedrock, settings.model_presets)).toBe(false);
		expect(isProviderConfigured(bothKeys, bedrock, settings.model_presets)).toBe(true);
	});

	it("profile auth counts only once a preset references it", () => {
		const settings = freshSettings();
		const bedrock = provider(settings, "bedrock");
		expect(isProviderConfigured(fakeApp(), bedrock, settings.model_presets)).toBe(false);
		settings.model_presets[0]!.provider_id = "bedrock";
		expect(isProviderConfigured(fakeApp(), bedrock, settings.model_presets)).toBe(true);
	});
});
