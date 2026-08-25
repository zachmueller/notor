import { describe, it, expect, beforeEach, vi } from "vitest";
import type { App } from "obsidian";
import { createMcpSecretStore, mcpSecretId } from "./mcp-secrets";
import { SECRET_ID_MAX_LENGTH } from "../utils/secrets";

vi.mock("../utils/logger", () => ({
	logger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Fake App with an in-memory SecretStorage + localStorage
// ---------------------------------------------------------------------------

function makeApp(opts: { localStorage?: Record<string, string>; encryption?: boolean } = {}) {
	const secrets = new Map<string, string>();
	const local: Record<string, string | null> = { ...(opts.localStorage ?? {}) };
	const app = {
		secretStorage: {
			setSecret: (id: string, value: string) => {
				if (!/^[a-z0-9-]+$/.test(id) || id.length > SECRET_ID_MAX_LENGTH) {
					throw new Error("Secret ID is invalid.");
				}
				secrets.set(id, value);
			},
			getSecret: (id: string) => secrets.get(id) ?? null,
			listSecrets: () => Array.from(secrets.keys()),
			deleteSecret: (id: string) => void secrets.delete(id),
			isEncryptionAvailable: () => opts.encryption ?? true,
		},
		loadLocalStorage: (key: string) => local[key] ?? null,
		saveLocalStorage: (key: string, value: unknown) => {
			if (value === null) delete local[key];
			else local[key] = value as string;
		},
	} as unknown as App;
	return { app, secrets, local };
}

// ---------------------------------------------------------------------------
// mcpSecretId
// ---------------------------------------------------------------------------

describe("mcpSecretId", () => {
	it("produces IDs Obsidian accepts", () => {
		const id = mcpSecretId("env", "github", "GITHUB_TOKEN");
		expect(id).toMatch(/^[a-z0-9-]+$/);
		expect(id.length).toBeLessThanOrEqual(SECRET_ID_MAX_LENGTH);
		expect(id.startsWith("notor-mcp-env-github-github-token-")).toBe(true);
	});

	it("stays within the length limit for maximal server names and keys", () => {
		const id = mcpSecretId("header", "a".repeat(50), "X".repeat(120));
		expect(id).toMatch(/^[a-z0-9-]+$/);
		expect(id.length).toBeLessThanOrEqual(SECRET_ID_MAX_LENGTH);
	});

	it("is stable across calls", () => {
		expect(mcpSecretId("env", "srv", "API_KEY")).toBe(mcpSecretId("env", "srv", "API_KEY"));
	});

	it("separates env from header namespaces", () => {
		expect(mcpSecretId("env", "srv", "AUTH")).not.toBe(mcpSecretId("header", "srv", "AUTH"));
	});

	it("does not collide when slugification would merge two distinct keys", () => {
		expect(mcpSecretId("env", "srv", "API_KEY")).not.toBe(mcpSecretId("env", "srv", "api.key"));
	});

	it("does not collide when truncation would merge two long keys", () => {
		const a = mcpSecretId("env", "srv", `${"PREFIX_THAT_IS_LONG"}_A`);
		const b = mcpSecretId("env", "srv", `${"PREFIX_THAT_IS_LONG"}_B`);
		expect(a).not.toBe(b);
	});

	it("does not collide across servers whose names truncate the same", () => {
		const a = mcpSecretId("env", `${"server-name-is-long"}-a`, "TOKEN");
		const b = mcpSecretId("env", `${"server-name-is-long"}-b`, "TOKEN");
		expect(a).not.toBe(b);
	});
});

// ---------------------------------------------------------------------------
// Store behaviour
// ---------------------------------------------------------------------------

describe("createMcpSecretStore", () => {
	let fixture: ReturnType<typeof makeApp>;

	beforeEach(() => {
		fixture = makeApp();
	});

	it("round-trips a value through SecretStorage", () => {
		const store = createMcpSecretStore(fixture.app);
		store.set("env", "srv", "TOKEN", "s3cret");
		expect(store.get("env", "srv", "TOKEN")).toBe("s3cret");
		expect(store.has("env", "srv", "TOKEN")).toBe(true);
	});

	it("never writes the value into localStorage", () => {
		const store = createMcpSecretStore(fixture.app);
		store.set("env", "srv", "TOKEN", "s3cret");
		expect(JSON.stringify(fixture.local)).not.toContain("s3cret");
		expect(Array.from(fixture.secrets.values())).toContain("s3cret");
	});

	it("returns null for an unset credential", () => {
		const store = createMcpSecretStore(fixture.app);
		expect(store.get("env", "srv", "NOPE")).toBeNull();
		expect(store.has("env", "srv", "NOPE")).toBe(false);
	});

	it("clears a credential", () => {
		const store = createMcpSecretStore(fixture.app);
		store.set("header", "srv", "Authorization", "Bearer x");
		store.clear("header", "srv", "Authorization");
		expect(store.get("header", "srv", "Authorization")).toBeNull();
		expect(fixture.app.secretStorage.listSecrets()).toHaveLength(0);
	});

	it("keeps env and header values apart", () => {
		const store = createMcpSecretStore(fixture.app);
		store.set("env", "srv", "AUTH", "env-value");
		store.set("header", "srv", "AUTH", "header-value");
		expect(store.get("env", "srv", "AUTH")).toBe("env-value");
		expect(store.get("header", "srv", "AUTH")).toBe("header-value");
	});

	it("reports availability and encryption state", () => {
		expect(createMcpSecretStore(fixture.app).isAvailable()).toBe(true);
		expect(createMcpSecretStore(fixture.app).isEncrypted()).toBe(true);
		expect(createMcpSecretStore(makeApp({ encryption: false }).app).isEncrypted()).toBe(false);
	});

	// -----------------------------------------------------------------------
	// Legacy migration
	// -----------------------------------------------------------------------

	it("migrates a legacy plaintext env var on read", () => {
		const legacy = makeApp({
			localStorage: { "notor-secret-mcp_env_srv_API_KEY": "legacy-value" },
		});
		const store = createMcpSecretStore(legacy.app);

		expect(store.get("env", "srv", "API_KEY")).toBe("legacy-value");
		// Moved into SecretStorage under the new ID...
		expect(legacy.app.secretStorage.getSecret(mcpSecretId("env", "srv", "API_KEY"))).toBe(
			"legacy-value",
		);
		// ...and the plaintext copy is gone.
		expect(legacy.local["notor-secret-mcp_env_srv_API_KEY"]).toBeUndefined();
		// Still readable after migration, now straight from SecretStorage.
		expect(store.get("env", "srv", "API_KEY")).toBe("legacy-value");
	});

	it("migrates a legacy plaintext header on read", () => {
		const legacy = makeApp({
			localStorage: { "notor-secret-mcp_header_srv_Authorization": "Bearer legacy" },
		});
		const store = createMcpSecretStore(legacy.app);
		expect(store.get("header", "srv", "Authorization")).toBe("Bearer legacy");
		expect(legacy.local["notor-secret-mcp_header_srv_Authorization"]).toBeUndefined();
	});

	it("prefers the SecretStorage value over a stale legacy copy", () => {
		const legacy = makeApp({
			localStorage: { "notor-secret-mcp_env_srv_API_KEY": "stale" },
		});
		const store = createMcpSecretStore(legacy.app);
		store.set("env", "srv", "API_KEY", "current");
		expect(store.get("env", "srv", "API_KEY")).toBe("current");
	});

	it("drops the legacy copy when a new value is written", () => {
		const legacy = makeApp({
			localStorage: { "notor-secret-mcp_env_srv_API_KEY": "stale" },
		});
		const store = createMcpSecretStore(legacy.app);
		store.set("env", "srv", "API_KEY", "current");
		expect(legacy.local["notor-secret-mcp_env_srv_API_KEY"]).toBeUndefined();
	});

	it("ignores an empty legacy value", () => {
		const legacy = makeApp({ localStorage: { "notor-secret-mcp_env_srv_API_KEY": "" } });
		expect(createMcpSecretStore(legacy.app).get("env", "srv", "API_KEY")).toBeNull();
	});
});
