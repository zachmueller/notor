import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { _resetLoginShellPathCache, resolveExecutable, resolveLoginShellPath } from "./login-shell-path";

let dir: string;
let otherDir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "notor-path-"));
	otherDir = mkdtempSync(join(tmpdir(), "notor-path-other-"));
	writeFileSync(join(dir, "whisper-server"), "#!/bin/sh\necho hi\n");
	chmodSync(join(dir, "whisper-server"), 0o755);
	writeFileSync(join(dir, "not-executable"), "data");
	chmodSync(join(dir, "not-executable"), 0o644);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(otherDir, { recursive: true, force: true });
});

describe("resolveExecutable", () => {
	it("finds a bare name on the given PATH and ignores non-executables", () => {
		const pathEnv = [otherDir, dir].join(delimiter);
		expect(resolveExecutable("whisper-server", pathEnv)).toBe(join(dir, "whisper-server"));
		expect(resolveExecutable("not-executable", pathEnv)).toBeNull();
		expect(resolveExecutable("missing-binary", pathEnv)).toBeNull();
		expect(resolveExecutable("   ", pathEnv)).toBeNull();
	});

	it("checks explicit paths directly, without searching PATH", () => {
		expect(resolveExecutable(join(dir, "whisper-server"), "")).toBe(join(dir, "whisper-server"));
		expect(resolveExecutable(join(otherDir, "whisper-server"), dir)).toBeNull();
		expect(resolveExecutable(`${dir}/not-executable`, "")).toBeNull();
	});
});

describe("resolveLoginShellPath", () => {
	it("returns a PATH-like string and caches it", () => {
		_resetLoginShellPathCache();
		const first = resolveLoginShellPath();
		expect(typeof first).toBe("string");
		expect(first.length).toBeGreaterThan(0);
		expect(resolveLoginShellPath()).toBe(first);
		_resetLoginShellPathCache();
	});
});
