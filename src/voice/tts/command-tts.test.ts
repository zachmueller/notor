import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

vi.mock("../../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { CommandTts, buildTtsArgs } from "./command-tts";

/** Minimal child-process stand-in: records stdin, exits on demand or when killed. */
class FakeChild extends EventEmitter {
	stdinText = "";
	exitCode: number | null = null;
	killed = false;
	stderr = new EventEmitter();
	stdin = {
		on: vi.fn(),
		end: vi.fn((text: string) => {
			this.stdinText += text;
		}),
	};
	kill = vi.fn((signal?: string) => {
		this.killed = true;
		queueMicrotask(() => this.finish(null, signal ?? "SIGTERM"));
		return true;
	});

	finish(code: number | null, signal: string | null = null): void {
		this.exitCode = code;
		this.emit("exit", code, signal);
		this.emit("close", code, signal);
	}
}

function makeTts(config = { command: "say", voice: "", rate: 0 }) {
	const children: FakeChild[] = [];
	const spawnFn = vi.fn((_exe: string, _args: string[]) => {
		const child = new FakeChild();
		children.push(child);
		return child as unknown as ChildProcess;
	});
	const tts = new CommandTts(config, {
		spawnFn: spawnFn as never,
		resolveExe: (name) => `/usr/bin/${name}`,
		loginPath: () => "/usr/bin:/bin",
	});
	return { tts, spawnFn, children };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("buildTtsArgs", () => {
	it("adds voice and rate flags only when configured", () => {
		expect(buildTtsArgs({ command: "say", voice: "", rate: 0 })).toEqual([]);
		expect(buildTtsArgs({ command: "say", voice: "Samantha", rate: 190.4 })).toEqual(["-v", "Samantha", "-r", "190"]);
	});
});

describe("CommandTts", () => {
	it("spawns the resolved command with the text on stdin and resolves when it exits", async () => {
		const { tts, spawnFn, children } = makeTts({ command: "say", voice: "Alex", rate: 0 });
		const pending = tts.speak("  Hello there.  ");
		expect(tts.isSpeaking).toBe(true);
		const [exe, args, options] = spawnFn.mock.calls[0]! as unknown as [string, string[], { env: Record<string, string> }];
		expect(exe).toBe("/usr/bin/say");
		expect(args).toEqual(["-v", "Alex"]);
		expect(options.env.PATH).toBe("/usr/bin:/bin");
		expect(children[0]!.stdinText).toBe("Hello there.\n");

		children[0]!.finish(0);
		expect(await pending).toEqual({ interrupted: false });
		expect(tts.isSpeaking).toBe(false);
	});

	it("stop() kills the current process and reports the utterance as interrupted", async () => {
		const { tts, children } = makeTts();
		const pending = tts.speak("A long sentence that will be interrupted.");
		tts.stop();
		expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
		expect(await pending).toEqual({ interrupted: true });
		expect(tts.isSpeaking).toBe(false);
	});

	it("skips blank text and survives a spawn failure", async () => {
		const { tts, spawnFn } = makeTts();
		expect(await tts.speak("   ")).toEqual({ interrupted: false });
		expect(spawnFn).not.toHaveBeenCalled();

		const broken = new CommandTts({ command: "nope", voice: "", rate: 0 }, {
			spawnFn: (() => { throw new Error("ENOENT"); }) as never,
			resolveExe: () => null,
			loginPath: () => "",
		});
		expect(await broken.speak("hi")).toEqual({ interrupted: false });
		expect(broken.isSpeaking).toBe(false);
	});

	it("a new speak() replaces an utterance still playing", async () => {
		const { tts, children } = makeTts();
		const first = tts.speak("first");
		const second = tts.speak("second");
		await tick();
		expect(await first).toEqual({ interrupted: true });
		expect(children).toHaveLength(2);
		children[1]!.finish(0);
		expect(await second).toEqual({ interrupted: false });
	});
});
