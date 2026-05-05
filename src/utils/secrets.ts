/**
 * Wrapper around Obsidian's SecretStorage API for credential management.
 *
 * Provides get/set/clear operations with a consistent key naming convention.
 * Secret IDs must be lowercase alphanumeric with dashes only (enforced by
 * Obsidian's SecretStorage).
 *
 * Architecture: Plugin settings store secret *names* (IDs), not values.
 * Actual credentials are retrieved at runtime via this wrapper.
 *
 * Requires Obsidian >= 1.11.4 (SecretStorage API).
 *
 * @see design/research/obsidian-secrets-manager.md
 */

import type { App } from "obsidian";
import { logger } from "./logger";

const log = logger("Secrets");

/**
 * Well-known secret IDs used by Notor.
 *
 * All IDs follow the convention: notor-{provider}-{credential-type}
 *
 * @deprecated Use the dynamic `secretIdFor*` functions instead. These
 * constants remain for backward compatibility with migrated provider
 * instances whose IDs match the type string.
 */
export const SECRET_IDS = {
	OPENAI_API_KEY: "notor-openai-api-key",
	ANTHROPIC_API_KEY: "notor-anthropic-api-key",
	LOCAL_API_KEY: "notor-local-api-key",
	BEDROCK_ACCESS_KEY_ID: "notor-bedrock-access-key-id",
	BEDROCK_SECRET_ACCESS_KEY: "notor-bedrock-secret-access-key",
} as const;

// ---------------------------------------------------------------------------
// Dynamic secret ID builders (multi-instance support)
// ---------------------------------------------------------------------------

/** Build the API key secret ID for a provider instance. */
export function secretIdForApiKey(instanceId: string): string {
	return `notor-${instanceId}-api-key`;
}

/** Build the AWS access key ID secret for a Bedrock provider instance. */
export function secretIdForAccessKeyId(instanceId: string): string {
	return `notor-${instanceId}-access-key-id`;
}

/** Build the AWS secret access key secret for a Bedrock provider instance. */
export function secretIdForSecretAccessKey(instanceId: string): string {
	return `notor-${instanceId}-secret-access-key`;
}

/** Clear all secrets associated with a provider instance. */
export function clearProviderSecrets(app: App, instanceId: string, type: string): void {
	clearSecret(app, secretIdForApiKey(instanceId));
	if (type === "bedrock") {
		clearSecret(app, secretIdForAccessKeyId(instanceId));
		clearSecret(app, secretIdForSecretAccessKey(instanceId));
	}
}

/**
 * Retrieve a secret by ID from Obsidian's SecretStorage.
 *
 * Returns `null` if the secret is not found or is empty (the SecretStorage
 * API has no delete — clearing sets the value to an empty string).
 *
 * @param app - The Obsidian App instance.
 * @param id  - The secret ID (lowercase alphanumeric with dashes).
 * @returns The secret value, or `null` if not configured.
 */
export function getSecret(app: App, id: string): string | null {
	if (!app.secretStorage) {
		log.error("SecretStorage not available — update Obsidian to 1.11.4+");
		return null;
	}
	if (!id) {
		return null;
	}
	try {
		const value = app.secretStorage.getSecret(id);
		// Treat both null and empty string as "not configured"
		if (value === null || value === "") {
			return null;
		}
		return value;
	} catch (e) {
		log.error("Failed to retrieve secret", { id, error: String(e) });
		return null;
	}
}

/**
 * Store a secret in Obsidian's SecretStorage.
 *
 * @param app    - The Obsidian App instance.
 * @param id     - The secret ID (lowercase alphanumeric with dashes).
 * @param value  - The secret value to store.
 */
export function setSecret(app: App, id: string, value: string): void {
	if (!app.secretStorage) {
		log.error("SecretStorage not available — update Obsidian to 1.11.4+");
		return;
	}
	try {
		app.secretStorage.setSecret(id, value);
	} catch (e) {
		log.error("Failed to store secret", { id, error: String(e) });
	}
}

/**
 * Clear a secret from Obsidian's SecretStorage.
 *
 * There is no delete API — this uses the recommended workaround of
 * setting the value to an empty string.
 *
 * @param app - The Obsidian App instance.
 * @param id  - The secret ID to clear.
 */
export function clearSecret(app: App, id: string): void {
	setSecret(app, id, "");
}