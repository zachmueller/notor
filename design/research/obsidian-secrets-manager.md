# R-1: Obsidian Secrets Manager API — Research Findings

**Completed:** 2026-06-03
**Source:** [obsidian.d.ts](https://raw.githubusercontent.com/obsidianmd/obsidian-api/refs/heads/master/obsidian.d.ts) (v1.11.4+), [Obsidian Docs — Store secrets](https://docs.obsidian.md/Plugins/Guides/Store+secrets), [SecretStorage API Reference](https://docs.obsidian.md/Reference/TypeScript+API/SecretStorage)

---

## 1. API Surface

Obsidian exposes a dedicated `SecretStorage` class available via `app.secretStorage`. This is **separate** from `loadData()`/`saveData()` (which persist to `data.json`) and from `loadLocalStorage()`/`saveLocalStorage()` (which use browser `localStorage`).

### `SecretStorage` (since 1.11.4)

| Method | Signature | Description |
|---|---|---|
| `setSecret` | `setSecret(id: string, secret: string): void` | Stores a secret. `id` must be lowercase alphanumeric with optional dashes. Throws on invalid ID. |
| `getSecret` | `getSecret(id: string): string \| null` | Retrieves a secret by ID. Returns `null` if not found. |
| `listSecrets` | `listSecrets(): string[]` | Returns an array of all secret IDs currently stored. |

**Key observations:**

- All methods are **synchronous** (no `Promise` return types).
- The `id` parameter is constrained: **lowercase alphanumeric characters and dashes only** (e.g., `openai-api-key`, `anthropic-key`). Invalid IDs throw an `Error`.
- There is **no `deleteSecret` method** in the public API. To "clear" a secret, the recommended approach is `setSecret(id, "")` — storing an empty string.

### `SecretComponent` (since 1.11.1, updated 1.11.4)

A UI input component for secret entry in settings tabs:

| Method | Signature | Description |
|---|---|---|
| `constructor` | `constructor(app: App, containerEl: HTMLElement)` | Creates a secret input field. Requires `App` reference. |
| `setValue` | `setValue(value: string): this` | Sets the displayed value (the secret name/ID, not the secret itself). |
| `onChange` | `onChange(cb: (value: string) => unknown): this` | Registers a callback for when the user changes the value. |

**Integration with `Setting`:** `SecretComponent` is used via `Setting.addComponent()` (since 1.11.0), not via a dedicated `addSecret()` method. This is because `SecretComponent` requires an `App` instance in its constructor, which standard `addText`/`addToggle` callbacks don't provide.

### Usage Pattern (from official docs)

```typescript
import { App, PluginSettingTab, SecretComponent, Setting } from "obsidian";

// In settings tab display():
new Setting(containerEl)
  .setName('API key')
  .setDesc('Select a secret from SecretStorage')
  .addComponent(el => new SecretComponent(this.app, el)
    .setValue(this.plugin.settings.mySetting)
    .onChange(value => {
      this.plugin.settings.mySetting = value;
      this.plugin.saveSettings();
    }));

// Retrieving the actual secret value:
const secretValue = this.app.secretStorage.getSecret(this.settings.mySetting);
```

**Important architectural pattern:** The plugin settings store the **secret name/ID** (e.g., `"openai-api-key"`), not the secret value itself. At runtime, the plugin retrieves the actual secret via `app.secretStorage.getSecret(secretName)`. This means `data.json` never contains the actual credential.

---

## 2. Storage Mechanism

The `SecretStorage` is described as a "centralized key-value store" that is **shared across plugins**. From the official docs:

> "SecretStorage offers a centralized key-value store that allows users to share secrets across multiple plugins."

### Per-Platform Storage

The Obsidian API type definitions and public documentation do **not** specify the underlying storage mechanism per platform. Based on Obsidian's Electron architecture and the API's synchronous nature:

| Platform | Likely Mechanism | Notes |
|---|---|---|
| macOS | Electron `safeStorage` / Keychain | Electron provides `safeStorage.encryptString()`/`decryptString()` backed by macOS Keychain |
| Windows | Electron `safeStorage` / DPAPI | Data Protection API via Electron's safe storage |
| Linux | Electron `safeStorage` / libsecret (GNOME Keyring) | Falls back to basic encryption if libsecret unavailable |
| iOS | iOS Keychain (via Capacitor/native bridge) | Platform-specific secure storage |
| Android | Android Keystore (via native bridge) | Platform-specific secure storage |

**Evidence for Electron `safeStorage`:** The synchronous API signature (`getSecret` returns `string | null`, not `Promise<string | null>`) is consistent with Electron's `safeStorage` API which can work synchronously. The "centralized" and cross-plugin nature suggests secrets are stored in a single encrypted file or native keychain rather than per-plugin.

### Namespace Considerations

- **Secrets are shared globally** — any plugin can read any secret by ID if it knows the name.
- There is **no per-plugin namespace** or access control between plugins.
- This is a **security design choice**: users manage a single pool of secrets (e.g., one OpenAI API key shared by multiple AI plugins).
- Plugin settings store only the **name** of the secret to use, allowing users to select which secret to associate with which plugin.

---

## 3. Secret Lifecycle (CRUD)

| Operation | Method | Supported |
|---|---|---|
| **Create** | `setSecret(id, secret)` | ✅ |
| **Read** | `getSecret(id)` | ✅ (returns `null` if not found) |
| **Update** | `setSecret(id, newSecret)` | ✅ (overwrites existing) |
| **Delete** | *None* | ❌ No public `deleteSecret` method |
| **List** | `listSecrets()` | ✅ (returns array of IDs) |

**Deletion workaround:** Set the secret to an empty string via `setSecret(id, "")`. The ID will still appear in `listSecrets()`, but `getSecret(id)` will return `""` (empty string, not `null`). Code should treat both `null` and `""` as "no secret configured."

**Namespace:** Secrets are global to the vault, not namespaced per plugin. Use descriptive, plugin-prefixed IDs to avoid collisions (e.g., `notor-openai-api-key`). However, the shared nature is by design — the official docs explicitly state secrets can be shared across plugins.

---

## 4. Size and Format Limitations

| Aspect | Limitation |
|---|---|
| **ID format** | Lowercase alphanumeric + dashes only. Throws `Error` on invalid. |
| **Value type** | `string` only. No binary data. |
| **Value size** | Not documented. Likely limited by underlying keychain (macOS Keychain: ~100KB per item; DPAPI: practical limit ~1MB). API keys and tokens are typically <1KB, well within any limit. |
| **Structured data** | No native JSON support. Could store `JSON.stringify(obj)`, but not recommended — secrets should be atomic values. |

**Recommendation for Notor:** Store each API key as a single string secret. Do not attempt to store JSON-structured provider configurations as secrets. Use `data.json` (via `loadData`/`saveData`) for non-sensitive configuration and `SecretStorage` exclusively for credentials.

---

## 5. Plugin Lifecycle Integration

### Availability

- `app.secretStorage` is a property on the `App` class, available as of Obsidian 1.11.4.
- It is available **during `onload()`** — no deferred initialization required.
- The `App` instance is passed to the `Plugin` constructor, so `this.app.secretStorage` is accessible from the start of plugin lifecycle.

### Retrieval Timing

```typescript
async onload() {
  // Safe to access immediately
  const settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  
  // Safe to retrieve secrets during onload
  const apiKey = this.app.secretStorage.getSecret(settings.openaiSecretName);
  
  // Use apiKey for initialization...
}
```

### Plugin Uninstall

- The API documentation does **not** specify what happens to secrets on plugin uninstall.
- Since secrets are **global and shared**, uninstalling a plugin likely does **not** delete its secrets. The user manages secrets independently.
- The plugin settings (`data.json`) which store the secret **names** would be cleaned up by Obsidian's normal plugin uninstall process, but the secrets themselves persist in the vault's secret store.

---

## 6. Minimum Obsidian Version

| Feature | Minimum Version |
|---|---|
| `SecretStorage` class | **1.11.4** |
| `SecretComponent` class | **1.11.1** (constructor), **1.11.4** (`setValue`, `onChange`) |
| `Setting.addComponent()` | **1.11.0** |
| `app.secretStorage` property | **1.11.4** |

### Impact on Notor

The current `manifest.json` specifies `"minAppVersion": "0.15.0"`. **This must be bumped to at least `1.11.4`** to use `SecretStorage`.

**Other features used by Notor that have version requirements:**
- `app.loadLocalStorage` / `app.saveLocalStorage`: since 1.8.7
- `BaseComponent.setDisabled`: since 1.2.3

**Recommendation:** Set `minAppVersion` to `"1.11.4"` in `manifest.json`. This is the minimum required for all `SecretStorage` and `SecretComponent` features. Obsidian 1.11.4 was released well before this plugin's development, so adoption should be widespread.

---

## 7. Mobile Support

The `SecretStorage` API is part of the core `App` class and is **not** marked with any desktop-only annotations. The `SecretComponent` UI component is also not desktop-restricted.

| Platform | Expected Support | Notes |
|---|---|---|
| macOS Desktop | ✅ | Via Electron `safeStorage` / Keychain |
| Windows Desktop | ✅ | Via Electron `safeStorage` / DPAPI |
| Linux Desktop | ✅ | Via Electron `safeStorage` / libsecret |
| iOS | ✅ (expected) | Not desktop-only; likely uses iOS Keychain |
| Android | ✅ (expected) | Not desktop-only; likely uses Android Keystore |

**Caveat:** The official docs do not explicitly confirm mobile platform behavior. Since Notor sets `"isDesktopOnly": false`, mobile testing should verify `SecretStorage` works correctly on iOS and Android. The synchronous API nature may have different performance characteristics on mobile.

---

## 8. Fallback Strategy

### When is a fallback needed?

A fallback would only be necessary if:
1. The user is on an Obsidian version < 1.11.4 (should be prevented by `minAppVersion`)
2. The underlying platform secret storage is unavailable (rare edge case on Linux without libsecret)

### Recommended approach: No fallback — require SecretStorage

**Rationale:**
- Setting `minAppVersion` to `1.11.4` guarantees `SecretStorage` availability.
- Providing a fallback to `data.json` storage would undermine the security benefit (NFR-2).
- The API is synchronous and simple — there's no complex failure mode to handle.

### Defensive coding for runtime checks

If we want belt-and-suspenders safety:

```typescript
function getApiKey(app: App, secretName: string): string | null {
  if (!app.secretStorage) {
    // Should never happen if minAppVersion >= 1.11.4
    console.error('Notor: SecretStorage not available. Update Obsidian to 1.11.4+');
    return null;
  }
  if (!secretName) {
    return null;
  }
  return app.secretStorage.getSecret(secretName);
}
```

### Alternative: `loadLocalStorage` / `saveLocalStorage`

If `SecretStorage` were truly unavailable, `app.loadLocalStorage(key)` / `app.saveLocalStorage(key, data)` (since 1.8.7) stores data in browser `localStorage` scoped to the vault. However:
- **Not encrypted** — stored as plain text in the browser's local storage.
- **Not cross-platform** — `localStorage` is per-device, which is actually the same as `SecretStorage`.
- **Not recommended** for secrets.

**Conclusion: Do not implement a fallback.** Require Obsidian ≥ 1.11.4.

---

## Recommendation Summary

| Decision | Recommendation |
|---|---|
| **Proceed with SecretStorage?** | ✅ Yes — it is the official, supported approach |
| **`minAppVersion` bump** | **Required: `0.15.0` → `1.11.4`** |
| **Secret ID convention** | Use lowercase-with-dashes: `notor-openai-api-key`, `notor-anthropic-api-key`, etc. |
| **Settings architecture** | Store secret **names** in `data.json` via `loadData`/`saveData`; store actual credentials in `SecretStorage` |
| **UI component** | Use `SecretComponent` via `Setting.addComponent()` in the settings tab |
| **Deletion** | Use `setSecret(id, "")` as workaround; treat both `null` and `""` as "not configured" |
| **Fallback** | None — require `minAppVersion` ≥ 1.11.4 |
| **Mobile** | Expected to work; verify during testing |

### Implementation Pattern for Notor

```typescript
// settings.ts — store secret NAMES, not values
export interface NotorSettings {
  openaiSecretName: string;    // e.g., "notor-openai-api-key"
  anthropicSecretName: string; // e.g., "notor-anthropic-api-key"
  bedrockSecretName: string;   // e.g., "notor-bedrock-credentials"
  // ... other non-sensitive settings
}

// At runtime, retrieve the actual secret:
const apiKey = this.app.secretStorage.getSecret(this.settings.openaiSecretName);
if (!apiKey) {
  // Prompt user to configure API key in settings
}

// In settings tab, use SecretComponent for input:
new Setting(containerEl)
  .setName('OpenAI API key')
  .setDesc('Select or create a secret for your OpenAI API key')
  .addComponent(el => new SecretComponent(this.app, el)
    .setValue(this.plugin.settings.openaiSecretName)
    .onChange(async (value) => {
      this.plugin.settings.openaiSecretName = value;
      await this.plugin.saveData(this.plugin.settings);
    }));
```

---

## Risks and Limitations

1. **No delete API:** Cannot programmatically remove secrets. Users must manage cleanup manually or through Obsidian's settings UI.
2. **Shared namespace:** Other plugins could theoretically read Notor's secrets if they know the ID. This is by design but worth noting in documentation.
3. **Synchronous API:** While convenient, any future changes to async behavior could require refactoring. Low risk since the API is already public and stable.
4. **Undocumented storage backend:** The exact per-platform encryption mechanism is not documented. We trust Obsidian's implementation but cannot independently verify the security level.
5. **No expiry or rotation:** The API has no built-in support for secret expiry or rotation. Users must manually update secrets when keys change.