import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildFileUtils } from "./file-utils";
import { TOOL_PATH_PARAMS } from "../../tool-config/path-enforcer";
import type { ResolvedToolConfigEntry } from "../../tool-config/types";

function makeEntry(overrides: Partial<ResolvedToolConfigEntry> = {}): ResolvedToolConfigEntry {
	return {
		enabled: true,
		auto_approve: false,
		allowed_paths: [],
		blocked_paths: [],
		allowed_command_patterns: [],
		blocked_command_patterns: [],
		auto_approve_paths: [],
		never_auto_approve_paths: [],
		path_scopes: {},
		...overrides,
	};
}

/** Minimal plugin/context stand-in — only what the pathEnforcer wrapper reads. */
function buildEnforcer() {
	const ctx = {
		plugin: {
			app: {
				vault: { getAbstractFileByPath: () => null },
				metadataCache: { getFirstLinkpathDest: () => null },
			},
			settings: { user_shared_settings: {} },
			getTempOutputSpiller: () => undefined,
		},
		vaultRootPath: "/vault",
	} as unknown as Parameters<typeof buildFileUtils>[0];

	return buildFileUtils(ctx).pathEnforcer;
}

describe("utils.pathEnforcer — sessionAllowedPaths forwarding", () => {
	beforeEach(() => {
		TOOL_PATH_PARAMS["write_note"] = [
			{ paramName: "path", namespace: "vault", resolveAs: "note", access: "write" },
		];
	});
	afterEach(() => {
		delete TOOL_PATH_PARAMS["write_note"];
	});

	// The wrapper previously stopped at `entry`, silently dropping the 6th
	// argument, so a scaffold checking an orchestration scratchpad path against a
	// restricted config would over-block.
	it("forwards session-allowed prefixes so a scratchpad path is not over-blocked", () => {
		const enforcer = buildEnforcer();
		const entry = makeEntry({ allowed_paths: ["notes/"] });
		const scratchpad = "notor/orchestrations/sessions/s1/scratchpad";

		// Without the session prefix the path is out of bounds.
		expect(
			enforcer.enforcePathConstraints("write_note", { path: `${scratchpad}/plan.md` }, entry),
		).not.toBeNull();

		// With it, the call is permitted.
		expect(
			enforcer.enforcePathConstraints("write_note", { path: `${scratchpad}/plan.md` }, entry, [
				scratchpad,
			]),
		).toBeNull();
	});

	it("still lets blocked_paths win over a session-allowed prefix", () => {
		const enforcer = buildEnforcer();
		const entry = makeEntry({ blocked_paths: ["secret/"] });
		expect(
			enforcer.enforcePathConstraints("write_note", { path: "secret/x.md" }, entry, ["secret/"]),
		).not.toBeNull();
	});

	it("behaves as before when the argument is omitted", () => {
		const enforcer = buildEnforcer();
		const entry = makeEntry({ allowed_paths: ["notes/"] });
		expect(
			enforcer.enforcePathConstraints("write_note", { path: "notes/a.md" }, entry),
		).toBeNull();
	});
});
