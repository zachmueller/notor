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

	/**
	 * A settings UI component for entering secrets.
	 * Renders a masked input that reads/writes from/to SecretStorage.
	 * Available since Obsidian 1.11.1 (constructor), 1.11.4 (setValue/onChange).
	 *
	 * Used via `Setting.addComponent(el => new SecretComponent(app, el)...)`.
	 */
	class SecretComponent {
		constructor(app: App, containerEl: HTMLElement);
		/** Sets the secret name/ID displayed in the input. */
		setValue(value: string): this;
		/** Registers a callback called when the user changes the value. */
		onChange(cb: (value: string) => unknown): this;
	}

	interface Setting {
		/**
		 * Add a custom component to a setting row.
		 * Available since Obsidian 1.11.0. Required for SecretComponent.
		 */
		addComponent<T>(
			cb: (containerEl: HTMLElement) => T
		): this;
	}
}
