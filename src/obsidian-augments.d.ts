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
		/** Store a secret. ID must be lowercase alphanumeric with dashes, ≤ 64 chars. */
		setSecret(id: string, secret: string): void;
		/** Retrieve a secret by ID. Returns null if not found. */
		getSecret(id: string): string | null;
		/** List all stored secret IDs. */
		listSecrets(): string[];
		/**
		 * Remove a secret entirely, so its ID also leaves `listSecrets()`.
		 *
		 * Undocumented but present at runtime (Obsidian's own Keychain settings
		 * UI calls it). Optional so older builds fall back to `setSecret(id, "")`.
		 */
		deleteSecret?(id: string): void;
		/**
		 * Whether the OS-level encryption backend is usable (Keychain / DPAPI /
		 * libsecret). When false, Obsidian stores secrets without encrypting them.
		 * Undocumented but present at runtime.
		 */
		isEncryptionAvailable?(): boolean;
	}

	interface App {
		/** Secure secret storage (since Obsidian 1.11.4). */
		secretStorage: SecretStorage;

		/** Internal (non-community) plugins. Not in published types. */
		internalPlugins: {
			plugins: Record<string, { instance: unknown; enabled: boolean }>;
			/** Look up a core plugin by id; `instance` is plugin-specific. */
			getPluginById?: (id: string) => { instance?: unknown } | null;
		};

		/** Community plugin registry. Not in published types. */
		plugins?: {
			plugins?: Record<string, unknown>;
		};

		/**
		 * View-type registry. Used to detect whether a Web Viewer view type is
		 * registered. Not in published types.
		 */
		viewRegistry?: {
			viewByType?: Record<string, unknown>;
		};
	}

	interface View {
		/** Component children array. Not in published types. */
		_children: unknown[];
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

	/**
	 * WorkspaceLeaf has a string `id` property at runtime, used by
	 * `workspace.getLeafById()`. Not yet in the published type definitions.
	 */
	interface WorkspaceLeaf {
		id: string;
	}

	/**
	 * Obsidian's internal suggestion controller, exposed at runtime on every
	 * `PopoverSuggest`/`AbstractInputSuggest` instance as `.suggestions`. It owns
	 * the *real* keyboard highlight (moved by the popover's own `scope` on
	 * ArrowUp/Down) — distinct from any bookkeeping a subclass may keep. Not in
	 * the published type definitions. Only the members we rely on are declared.
	 */
	interface SuggestionContainer<T> {
		/**
		 * Accept the currently-highlighted item. This is exactly what Obsidian's
		 * own Enter handler calls; it invokes the owner's `selectSuggestion(value, evt)`
		 * with the highlighted value. The evt is forwarded to `selectSuggestion`.
		 */
		useSelectedItem(evt: KeyboardEvent | MouseEvent | Record<string, never>): void;
		/** Index of the highlighted item within `values` (the real selection). */
		selectedItem: number;
		/** The rendered suggestion values, in display order. */
		values: T[];
	}

	interface AbstractInputSuggest<T> {
		/**
		 * Undocumented runtime controller holding the real highlight. Optional
		 * because it is untyped/internal — guard with a runtime check before use.
		 */
		suggestions?: SuggestionContainer<T>;
	}
}
