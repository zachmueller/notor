/**
 * Settings schema parsing and resolution for user-defined extensions.
 *
 * Parses the `settings` block from YAML code fences into typed schemas,
 * and resolves runtime values by merging defaults, persisted values, and
 * SecretStorage entries.
 */

import type { App } from "obsidian";
import type { SettingsFieldSchema } from "./types";
import { getSecret } from "../utils/secrets";

// ---------------------------------------------------------------------------
// Valid setting types
// ---------------------------------------------------------------------------

const VALID_SETTING_TYPES = new Set<string>(["string", "number", "boolean", "string[]"]);

// ---------------------------------------------------------------------------
// Secret ID slugification
// ---------------------------------------------------------------------------

/**
 * Normalize parts into a lowercase-alphanumeric-with-dashes string suitable
 * for SecretStorage IDs.
 *
 * Joins parts with `-`, converts to lowercase, replaces non-alphanumeric-dash
 * chars with `-`, and collapses consecutive dashes.
 *
 * @example slugifySecretId("notor-ext", "Custom Search", "api_key") → "notor-ext-custom-search-api-key"
 */
export function slugifySecretId(...parts: string[]): string {
	return parts
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Schema parsing
// ---------------------------------------------------------------------------

/**
 * Parse a YAML `settings` block into typed `SettingsFieldSchema[]`.
 *
 * Each key in the YAML object becomes a schema entry. Required properties
 * are `name` (string) and `type` (one of the valid setting types).
 */
export function parseSettingsSchema(
	yamlSettings: Record<string, unknown>,
): { schemas: SettingsFieldSchema[]; errors: string[] } {
	const schemas: SettingsFieldSchema[] = [];
	const errors: string[] = [];

	for (const [key, rawValue] of Object.entries(yamlSettings)) {
		if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
			errors.push(`Setting '${key}': value must be an object with at least 'name' and 'type' fields`);
			continue;
		}

		const value = rawValue as Record<string, unknown>;

		// Validate required: name
		if (!value.name || typeof value.name !== "string") {
			errors.push(`Setting '${key}': missing or invalid required property 'name' (must be a string)`);
			continue;
		}

		// Validate required: type
		if (!value.type || typeof value.type !== "string" || !VALID_SETTING_TYPES.has(value.type)) {
			errors.push(`Setting '${key}': missing or invalid required property 'type' (must be one of: ${[...VALID_SETTING_TYPES].join(", ")})`);
			continue;
		}

		const schema: SettingsFieldSchema = {
			key,
			name: value.name,
			type: value.type as SettingsFieldSchema["type"],
		};

		// Optional properties
		if (typeof value.description === "string") {
			schema.description = value.description;
		}

		if (value.default !== undefined) {
			schema.default = value.default as SettingsFieldSchema["default"];
		}

		if (typeof value.secret === "boolean") {
			schema.secret = value.secret;
		}

		if (typeof value.min === "number") {
			schema.min = value.min;
		}

		if (typeof value.max === "number") {
			schema.max = value.max;
		}

		if (Array.isArray(value.options) && value.options.every((o: unknown) => typeof o === "string")) {
			schema.options = value.options as string[];
		}

		schemas.push(schema);
	}

	return { schemas, errors };
}

// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

/**
 * Resolve per-extension settings values at runtime.
 *
 * Synchronous — `getSecret()` and settings access are both sync.
 * Always reads from live `plugin.settings` reference (no caching).
 *
 * Resolution order per field:
 * 1. If `secret: true` → read from SecretStorage via `getSecret(app, slugifiedId)`
 * 2. Else → read from `persistedValues[field.key]`
 * 3. Fall back to `field.default`
 * 4. If no default and no persisted value → add to `missing[]`
 */
export function resolveSettings(
	schemas: SettingsFieldSchema[],
	extensionName: string,
	persistedValues: Record<string, string | number | boolean | string[]>,
	app: App,
): { values: Record<string, unknown>; missing: string[] } {
	const values: Record<string, unknown> = {};
	const missing: string[] = [];

	for (const field of schemas) {
		let resolved: unknown = undefined;

		if (field.secret) {
			// Secret fields are read from SecretStorage
			const secretId = slugifySecretId("notor-ext", extensionName, field.key);
			const secretValue = getSecret(app, secretId);
			if (secretValue !== null) {
				resolved = secretValue;
			}
		} else {
			// Non-secret fields are read from persisted settings
			const persisted = persistedValues[field.key];
			if (persisted !== undefined) {
				resolved = persisted;
			}
		}

		// Fall back to default
		if (resolved === undefined && field.default !== undefined) {
			resolved = field.default;
		}

		// Track missing required settings
		if (resolved === undefined) {
			missing.push(field.key);
		}

		values[field.key] = resolved;
	}

	return { values, missing };
}

/**
 * Resolve global shared settings values at runtime.
 *
 * Same logic as `resolveSettings` but uses the shared secret ID convention:
 * `notor-shared-{key}` instead of `notor-ext-{extensionName}-{key}`.
 */
export function resolveSharedSettings(
	schemas: SettingsFieldSchema[],
	persistedValues: Record<string, string | number | boolean | string[]>,
	app: App,
): { values: Record<string, unknown>; missing: string[] } {
	const values: Record<string, unknown> = {};
	const missing: string[] = [];

	for (const field of schemas) {
		let resolved: unknown = undefined;

		if (field.secret) {
			const secretId = slugifySecretId("notor-shared", field.key);
			const secretValue = getSecret(app, secretId);
			if (secretValue !== null) {
				resolved = secretValue;
			}
		} else {
			const persisted = persistedValues[field.key];
			if (persisted !== undefined) {
				resolved = persisted;
			}
		}

		if (resolved === undefined && field.default !== undefined) {
			resolved = field.default;
		}

		if (resolved === undefined) {
			missing.push(field.key);
		}

		values[field.key] = resolved;
	}

	return { values, missing };
}
