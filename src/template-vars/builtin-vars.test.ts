import { describe, it, expect } from "vitest";
import type { NotorSettings } from "../settings/types";
import { TemplateVariableRegistry } from "./registry";
import { registerBuiltinVars } from "./builtin-vars";

function makeSettings(
	overrides: Partial<NotorSettings> = {},
): NotorSettings {
	return { notor_dir: "notor/", ...overrides } as NotorSettings;
}

describe("registerBuiltinVars", () => {
	it("strips trailing slash from notor_dir", () => {
		const settings = makeSettings({ notor_dir: "notor/" });
		const registry = new TemplateVariableRegistry();
		registerBuiltinVars(registry, () => settings, () => "vault");

		expect(registry.resolve("{notor_dir}")).toBe("notor");
	});

	it("passes through notor_dir with no trailing slash", () => {
		const settings = makeSettings({ notor_dir: "notor" });
		const registry = new TemplateVariableRegistry();
		registerBuiltinVars(registry, () => settings, () => "vault");

		expect(registry.resolve("{notor_dir}")).toBe("notor");
	});

	it("resolves vault_name from callback", () => {
		const settings = makeSettings();
		const registry = new TemplateVariableRegistry();
		registerBuiltinVars(registry, () => settings, () => "My Vault");

		expect(registry.resolve("{vault_name}")).toBe("My Vault");
	});

	it("picks up settings changes without re-registration", () => {
		const settings = makeSettings({ notor_dir: "notor/" });
		const registry = new TemplateVariableRegistry();
		registerBuiltinVars(registry, () => settings, () => "vault");

		expect(registry.resolve("{notor_dir}")).toBe("notor");

		settings.notor_dir = "custom-dir";
		expect(registry.resolve("{notor_dir}")).toBe("custom-dir");
	});

	it("registers both variables", () => {
		const registry = new TemplateVariableRegistry();
		registerBuiltinVars(
			registry,
			() => makeSettings(),
			() => "vault",
		);

		expect(registry.list().sort()).toEqual(["notor_dir", "vault_name"]);
	});
});
