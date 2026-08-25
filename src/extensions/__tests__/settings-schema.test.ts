import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	parseSettingsSchema,
	resolveSettings,
	resolveSharedSettings,
} from "../settings-schema";
import { slugifySecretId } from "../../utils/secrets";

// ---------------------------------------------------------------------------
// Mock getSecret (keeping the real slugifySecretId — it has its own tests below)
// ---------------------------------------------------------------------------

const mockGetSecret = vi.fn<[unknown, string], string | null>().mockReturnValue(null);

vi.mock("../../utils/secrets", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../utils/secrets")>()),
	getSecret: (...args: unknown[]) => mockGetSecret(args[0], args[1] as string),
}));

vi.mock("../../utils/logger", () => ({
	logger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	}),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// slugifySecretId
// ---------------------------------------------------------------------------

describe("slugifySecretId", () => {
	it("normalizes to lowercase-alphanumeric-with-dashes", () => {
		expect(slugifySecretId("notor-ext", "Custom Search", "api_key")).toBe(
			"notor-ext-custom-search-api-key",
		);
	});

	it("handles special characters and spaces", () => {
		expect(slugifySecretId("notor-ext", "My Tool!", "API Key #1")).toBe(
			"notor-ext-my-tool-api-key-1",
		);
	});

	it("collapses consecutive dashes", () => {
		expect(slugifySecretId("notor", "test--tool", "key")).toBe("notor-test-tool-key");
	});

	it("strips leading and trailing dashes", () => {
		expect(slugifySecretId("-start", "end-")).toBe("start-end");
	});

	it("handles single part", () => {
		expect(slugifySecretId("simple")).toBe("simple");
	});

	it("converts uppercase to lowercase", () => {
		expect(slugifySecretId("NOTOR", "EXT")).toBe("notor-ext");
	});
});

// ---------------------------------------------------------------------------
// parseSettingsSchema
// ---------------------------------------------------------------------------

describe("parseSettingsSchema", () => {
	it("parses valid settings with required fields", () => {
		const { schemas, errors } = parseSettingsSchema({
			api_key: { name: "API Key", type: "string" },
			max_results: { name: "Max Results", type: "number" },
		});

		expect(errors).toHaveLength(0);
		expect(schemas).toHaveLength(2);

		expect(schemas[0].key).toBe("api_key");
		expect(schemas[0].name).toBe("API Key");
		expect(schemas[0].type).toBe("string");

		expect(schemas[1].key).toBe("max_results");
		expect(schemas[1].name).toBe("Max Results");
		expect(schemas[1].type).toBe("number");
	});

	it("parses all optional properties", () => {
		const { schemas, errors } = parseSettingsSchema({
			api_key: {
				name: "API Key",
				type: "string",
				description: "Your API key for the service",
				default: "none",
				secret: true,
				options: ["key1", "key2"],
			},
			limit: {
				name: "Limit",
				type: "number",
				min: 1,
				max: 100,
				default: 10,
			},
		});

		expect(errors).toHaveLength(0);
		expect(schemas[0].description).toBe("Your API key for the service");
		expect(schemas[0].default).toBe("none");
		expect(schemas[0].secret).toBe(true);
		expect(schemas[0].options).toEqual(["key1", "key2"]);

		expect(schemas[1].min).toBe(1);
		expect(schemas[1].max).toBe(100);
		expect(schemas[1].default).toBe(10);
	});

	it("reports error for non-object value", () => {
		const { schemas, errors } = parseSettingsSchema({
			bad: "just a string" as unknown,
		});

		expect(schemas).toHaveLength(0);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("bad");
	});

	it("reports error for missing name property", () => {
		const { schemas, errors } = parseSettingsSchema({
			key: { type: "string" },
		});

		expect(schemas).toHaveLength(0);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("name");
	});

	it("reports error for missing type property", () => {
		const { schemas, errors } = parseSettingsSchema({
			key: { name: "My Setting" },
		});

		expect(schemas).toHaveLength(0);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("type");
	});

	it("reports error for invalid type value", () => {
		const { schemas, errors } = parseSettingsSchema({
			key: { name: "Setting", type: "object" },
		});

		expect(schemas).toHaveLength(0);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("type");
	});

	it("validates all valid type values", () => {
		const types = ["string", "number", "boolean", "string[]"];
		for (const type of types) {
			const { schemas, errors } = parseSettingsSchema({
				field: { name: "Field", type },
			});
			expect(errors).toHaveLength(0);
			expect(schemas[0].type).toBe(type);
		}
	});

	it("collects multiple errors", () => {
		const { errors } = parseSettingsSchema({
			bad1: "not an object" as unknown,
			bad2: { type: "string" }, // missing name
		});

		expect(errors).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// resolveSettings
// ---------------------------------------------------------------------------

describe("resolveSettings", () => {
	const mockApp = {} as never;

	it("uses schema defaults when no persisted values exist", () => {
		const schemas = [
			{ key: "limit", name: "Limit", type: "number" as const, default: 10 },
			{ key: "format", name: "Format", type: "string" as const, default: "json" },
		];

		const { values, missing } = resolveSettings(schemas, "my_tool", {}, mockApp);

		expect(values.limit).toBe(10);
		expect(values.format).toBe("json");
		expect(missing).toHaveLength(0);
	});

	it("persisted values override defaults", () => {
		const schemas = [
			{ key: "limit", name: "Limit", type: "number" as const, default: 10 },
		];
		const persisted = { limit: 25 };

		const { values } = resolveSettings(schemas, "my_tool", persisted, mockApp);

		expect(values.limit).toBe(25);
	});

	it("reports missing required settings (no default, no persisted)", () => {
		const schemas = [
			{ key: "api_key", name: "API Key", type: "string" as const },
		];

		const { values, missing } = resolveSettings(schemas, "my_tool", {}, mockApp);

		expect(missing).toEqual(["api_key"]);
		expect(values.api_key).toBeUndefined();
	});

	it("reads secret fields from SecretStorage", () => {
		mockGetSecret.mockReturnValueOnce("secret-value-123");

		const schemas = [
			{ key: "api_key", name: "API Key", type: "string" as const, secret: true },
		];

		const { values, missing } = resolveSettings(schemas, "my_tool", {}, mockApp);

		expect(values.api_key).toBe("secret-value-123");
		expect(missing).toHaveLength(0);
		expect(mockGetSecret).toHaveBeenCalledWith(
			mockApp,
			"notor-ext-my-tool-api-key",
		);
	});

	it("falls back to default for secret field when SecretStorage returns null", () => {
		mockGetSecret.mockReturnValueOnce(null);

		const schemas = [
			{ key: "api_key", name: "API Key", type: "string" as const, secret: true, default: "default-key" },
		];

		const { values } = resolveSettings(schemas, "my_tool", {}, mockApp);
		expect(values.api_key).toBe("default-key");
	});

	it("reports missing secret field with no default and no stored value", () => {
		mockGetSecret.mockReturnValueOnce(null);

		const schemas = [
			{ key: "api_key", name: "API Key", type: "string" as const, secret: true },
		];

		const { missing } = resolveSettings(schemas, "my_tool", {}, mockApp);
		expect(missing).toEqual(["api_key"]);
	});

	it("returns empty values and missing for empty schemas", () => {
		const { values, missing } = resolveSettings([], "my_tool", {}, mockApp);
		expect(values).toEqual({});
		expect(missing).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// resolveSharedSettings
// ---------------------------------------------------------------------------

describe("resolveSharedSettings", () => {
	const mockApp = {} as never;

	it("resolves shared settings independently from per-extension", () => {
		const schemas = [
			{ key: "debug", name: "Debug Mode", type: "boolean" as const, default: false },
		];

		const { values } = resolveSharedSettings(schemas, {}, mockApp);
		expect(values.debug).toBe(false);
	});

	it("uses shared secret ID convention (notor-shared-{key})", () => {
		mockGetSecret.mockReturnValueOnce("shared-secret");

		const schemas = [
			{ key: "token", name: "Token", type: "string" as const, secret: true },
		];

		const { values } = resolveSharedSettings(schemas, {}, mockApp);

		expect(values.token).toBe("shared-secret");
		expect(mockGetSecret).toHaveBeenCalledWith(mockApp, "notor-shared-token");
	});

	it("persisted values override defaults for shared settings", () => {
		const schemas = [
			{ key: "debug", name: "Debug", type: "boolean" as const, default: false },
		];
		const persisted = { debug: true };

		const { values } = resolveSharedSettings(schemas, persisted, mockApp);
		expect(values.debug).toBe(true);
	});

	it("reports missing shared settings", () => {
		const schemas = [
			{ key: "required_key", name: "Required", type: "string" as const },
		];

		const { missing } = resolveSharedSettings(schemas, {}, mockApp);
		expect(missing).toEqual(["required_key"]);
	});
});
