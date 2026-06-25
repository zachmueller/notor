import { describe, it, expect, vi } from "vitest";
import { EXECUTE_COMMAND } from "../builtin-tool-scaffolds/execute-command";
import { extractCodeFence } from "../parser";
import { compileExtension } from "../compiler";

// ---------------------------------------------------------------------------
// Helpers: compile the execute_command scaffold's real code body and run it
// with mocks. compileExtension strips TS types then builds the AsyncFunction.
// Invocation order: fn(app, obsidian, utils, libs, settings, shared, params).
// ---------------------------------------------------------------------------

function compileScaffold(scaffoldContent: string) {
	const fence = extractCodeFence(scaffoldContent);
	if (!fence) throw new Error("No code fence found in scaffold");
	const compiled = compileExtension(fence.code, "tool");
	if ("error" in compiled) throw new Error(compiled.error);
	return compiled.fn;
}

const noopLogger = () => ({ debug() {}, info() {}, warn() {}, error() {} });

const DEFAULT_SETTINGS = {
	execute_command_allowed_paths: [] as string[],
	execute_command_timeout: 30,
	execute_command_max_output_chars: 50000,
};

interface RunOpts {
	workingDirectory: string;
	/** Mock implementation for libs.fs.promises.stat. */
	stat?: () => Promise<unknown>;
	/** Mock implementation for utils.executeShellCommand. */
	exec?: (cmd: string, opts: unknown) => Promise<unknown>;
}

function runExecuteCommand(opts: RunOpts) {
	const fn = compileScaffold(EXECUTE_COMMAND.scaffoldContent);

	const resolvedPath = `/abs/${opts.workingDirectory || "vault-root"}`;
	const obsidian = { Platform: { isDesktopApp: true } };

	const statMock = vi.fn(opts.stat ?? (async () => ({ isDirectory: () => true })));
	const execMock = vi.fn(
		opts.exec ??
			(async () => ({
				stdout: "ok",
				exitCode: 0,
				timedOut: false,
				truncated: false,
			})),
	);

	const utils = {
		logger: noopLogger,
		resolveAndValidatePath: vi.fn(() => ({ valid: true, resolvedPath })),
		executeShellCommand: execMock,
		tempOutputSpiller: undefined,
	};

	const libs = { fs: { promises: { stat: statMock } } };

	const params = { command: "echo hi", working_directory: opts.workingDirectory };

	return {
		result: fn({}, obsidian, utils, libs, DEFAULT_SETTINGS, {}, params) as Promise<string>,
		statMock,
		execMock,
		resolvedPath,
	};
}

// ---------------------------------------------------------------------------
// Working-directory validation
// ---------------------------------------------------------------------------

describe("execute_command — working directory validation", () => {
	it("missing cwd → clear 'does not exist' error, no shell-config hint, no spawn", async () => {
		const { result, execMock } = runExecuteCommand({
			workingDirectory: "does-not-exist",
			stat: async () => {
				const err: NodeJS.ErrnoException = new Error("ENOENT");
				err.code = "ENOENT";
				throw err;
			},
		});

		await expect(result).rejects.toThrow(/does not exist/);
		await expect(result).rejects.not.toThrow(/Shell not found/);
		await expect(result).rejects.not.toThrow(/Check your shell configuration/);
		expect(execMock).not.toHaveBeenCalled();
	});

	it("cwd is a file, not a directory → 'is not a directory' error", async () => {
		const { result, execMock } = runExecuteCommand({
			workingDirectory: "some-file.txt",
			stat: async () => ({ isDirectory: () => false }),
		});

		await expect(result).rejects.toThrow(/is not a directory/);
		expect(execMock).not.toHaveBeenCalled();
	});

	it("empty working_directory → skips stat check and runs in the vault root", async () => {
		const { result, statMock, execMock } = runExecuteCommand({
			workingDirectory: "",
		});

		await expect(result).resolves.toBe("ok");
		expect(statMock).not.toHaveBeenCalled();
		expect(execMock).toHaveBeenCalledTimes(1);
	});

	it("valid existing directory → runs with cwd = resolvedPath and returns output", async () => {
		const { result, statMock, execMock, resolvedPath } = runExecuteCommand({
			workingDirectory: "real-dir",
			stat: async () => ({ isDirectory: () => true }),
		});

		await expect(result).resolves.toBe("ok");
		expect(statMock).toHaveBeenCalledWith(resolvedPath);
		expect(execMock).toHaveBeenCalledTimes(1);
		expect(execMock.mock.calls[0][1]).toMatchObject({ cwd: resolvedPath });
	});
});
