import { describe, it, expect } from "vitest";
import { matchCommandPattern } from "./command-pattern-matcher";

describe("matchCommandPattern", () => {
	it("returns no match for empty patterns array", () => {
		expect(matchCommandPattern("git status", [])).toEqual({ matched: false });
	});

	it("matches exact command", () => {
		const result = matchCommandPattern("ls", ["ls"]);
		expect(result).toEqual({ matched: true, pattern: "ls" });
	});

	it("does not match partial prefix without glob", () => {
		expect(matchCommandPattern("lsof", ["ls"])).toEqual({ matched: false });
	});

	it("matches prefix glob pattern", () => {
		const result = matchCommandPattern("git status", ["git *"]);
		expect(result).toEqual({ matched: true, pattern: "git *" });
	});

	it("matches multi-word prefix glob", () => {
		const result = matchCommandPattern("npm run build", ["npm run *"]);
		expect(result).toEqual({ matched: true, pattern: "npm run *" });
	});

	it("does not match command without args when pattern requires space+glob", () => {
		expect(matchCommandPattern("git", ["git *"])).toEqual({ matched: false });
	});

	it("matches command with multiple wildcards", () => {
		const result = matchCommandPattern("npm test --coverage", ["npm * --*"]);
		expect(result).toEqual({ matched: true, pattern: "npm * --*" });
	});

	it("treats regex metacharacters as literals", () => {
		const result = matchCommandPattern("git log | head", ["git log | head"]);
		expect(result).toEqual({ matched: true, pattern: "git log | head" });
	});

	it("does not match when pipe is in pattern but not command", () => {
		expect(matchCommandPattern("git log head", ["git log | head"])).toEqual({ matched: false });
	});

	it("matches first matching pattern and returns it", () => {
		const result = matchCommandPattern("git status", ["npm *", "git *", "ls"]);
		expect(result).toEqual({ matched: true, pattern: "git *" });
	});

	it("returns no match when no pattern matches", () => {
		expect(matchCommandPattern("rm -rf /", ["git *", "ls", "npm *"])).toEqual({ matched: false });
	});

	it("matches catch-all wildcard", () => {
		const result = matchCommandPattern("anything here", ["*"]);
		expect(result).toEqual({ matched: true, pattern: "*" });
	});

	it("matches with ? single-character wildcard", () => {
		const result = matchCommandPattern("ls -a", ["ls -?"]);
		expect(result).toEqual({ matched: true, pattern: "ls -?" });
	});

	it("does not match ? against multiple characters", () => {
		expect(matchCommandPattern("ls -la", ["ls -?"])).toEqual({ matched: false });
	});
});
