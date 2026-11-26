import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { readFirstLine, type FirstLineFs } from "./file-head";

/** A fake fs whose files are byte buffers; records how many bytes were requested. */
function fakeFs(files: Record<string, Buffer>) {
	const requested: number[] = [];
	const fs: FirstLineFs = {
		open: async (p) => {
			const data = files[p];
			if (!data) throw new Error(`ENOENT: ${p}`);
			return {
				read: async (buf, offset, length, position) => {
					requested.push(length);
					const n = data.copy(buf, offset, position, Math.min(data.length, position + length));
					return { bytesRead: n };
				},
				close: async () => undefined,
			};
		},
	};
	return { fs, requested };
}

function adapter(files: Record<string, string>, withPaths = true): DataAdapter & { read: ReturnType<typeof vi.fn> } {
	return {
		read: vi.fn(async (p: string) => files[p] ?? ""),
		...(withPaths ? { getFullPath: (p: string) => `/abs/${p}` } : {}),
	} as unknown as DataAdapter & { read: ReturnType<typeof vi.fn> };
}

describe("readFirstLine", () => {
	it("reads only the head of the file and returns the first line", async () => {
		const body = '{"_type":"x","id":"é"}\n' + "y".repeat(100_000);
		const { fs, requested } = fakeFs({ "/abs/h/a.jsonl": Buffer.from(body) });
		const a = adapter({ "h/a.jsonl": body });
		expect(await readFirstLine(a, "h/a.jsonl", 64, fs)).toBe('{"_type":"x","id":"é"}');
		expect(requested).toEqual([64]);
		expect(a.read).not.toHaveBeenCalled();
	});

	it("returns a short file with no newline as-is", async () => {
		const { fs } = fakeFs({ "/abs/b": Buffer.from("only-line") });
		const a = adapter({ b: "only-line" });
		expect(await readFirstLine(a, "b", 64, fs)).toBe("only-line");
		expect(a.read).not.toHaveBeenCalled();
	});

	it("falls back to a full read when the first line is longer than maxBytes", async () => {
		const long = "z".repeat(200) + "\nrest";
		const { fs } = fakeFs({ "/abs/c": Buffer.from(long) });
		const a = adapter({ c: long });
		expect(await readFirstLine(a, "c", 64, fs)).toBe("z".repeat(200));
		expect(a.read).toHaveBeenCalledTimes(1);
	});

	it("uses adapter.read when the adapter has no file-system paths", async () => {
		const a = adapter({ d: "head\nbody" }, false);
		expect(await readFirstLine(a, "d")).toBe("head");
		expect(a.read).toHaveBeenCalledTimes(1);
	});

	it("propagates a missing-file error", async () => {
		const { fs } = fakeFs({});
		await expect(readFirstLine(adapter({}), "missing", 64, fs)).rejects.toThrow("ENOENT");
	});
});
