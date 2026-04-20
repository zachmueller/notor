import type { NotorSettings } from "../settings/types";
import type { TemplateVariableRegistry } from "./registry";

export function registerBuiltinVars(
	registry: TemplateVariableRegistry,
	getSettings: () => NotorSettings,
	getVaultName: () => string,
): void {
	registry.register("notor_dir", () => {
		const dir = getSettings().notor_dir;
		return dir.endsWith("/") ? dir.slice(0, -1) : dir;
	});

	registry.register("vault_name", () => getVaultName());
}
