/**
 * Type augmentations for Obsidian APIs not yet in the published type definitions.
 *
 * SecretStorage and SecretComponent were added in Obsidian 1.11.4 but are
 * not yet present in the `obsidian` npm package's type definitions.
 *
 * @see design/research/obsidian-secrets-manager.md
 */

import "obsidian";

declare module "obsidian" {
	/**
	 * Secure secret storage backed by OS-level encrypted storage.
	 * Available since Obsidian 1.11.4 via `app.secretStorage`.
	 */
	interface SecretStorage {
		/** Store a secret. ID must be lowercase alphanumeric with dashes. */
		setSecret(id: string, secret: string): void;
		/** Retrieve a secret by ID. Returns null if not found. */
		getSecret(id: string): string | null;
		/** List all stored secret IDs. */
		listSecrets(): string[];
	}

	interface App {
		/** Secure secret storage (since Obsidian 1.11.4). */
		secretStorage: SecretStorage;
	}
}