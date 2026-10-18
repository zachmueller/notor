import { describe, it, expect } from "vitest";
import { matchCircuits, matchWorkflows } from "./resolve";
import type { Circuit } from "../circuits/types";
import type { Workflow } from "../types";

const circuit = (name: string, flowDir: string) => ({ name, flowDir }) as Circuit;
const workflow = (display_name: string, file_path: string, aliases: string[] = []) =>
	({ display_name, file_path, file_name: file_path.split("/").pop()!, aliases }) as Workflow;

describe("matchCircuits", () => {
	const circuits = [
		circuit("Meeting wrap-up", "notor/circuits/meeting-wrap-up"),
		circuit("Inbox triage", "notor/circuits/inbox"),
		circuit("Inbox triage", "notor/orchestrations/inbox"),
	];

	it("prefers an exact name", () => {
		expect(matchCircuits(circuits, "Meeting wrap-up")).toEqual([circuits[0]]);
	});

	it("reports every circuit sharing a name", () => {
		expect(matchCircuits(circuits, "Inbox triage")).toHaveLength(2);
	});

	it("falls back to a directory path, then a trailing segment", () => {
		expect(matchCircuits(circuits, "notor/orchestrations/inbox/")).toEqual([circuits[2]]);
		expect(matchCircuits(circuits, "meeting-wrap-up")).toEqual([circuits[0]]);
	});

	it("matches nothing for blank or unknown refs", () => {
		expect(matchCircuits(circuits, "  ")).toEqual([]);
		expect(matchCircuits(circuits, "nope")).toEqual([]);
	});
});

describe("matchWorkflows", () => {
	const workflows = [
		workflow("daily/review", "notor/workflows/daily/review.md", ["Daily"]),
		workflow("weekly/review", "notor/workflows/weekly/review.md"),
		workflow("summarize", "notor/workflows/summarize.md"),
	];

	it("matches by display name before anything else", () => {
		expect(matchWorkflows(workflows, "daily/review")).toEqual([workflows[0]]);
	});

	it("matches a vault path with or without .md", () => {
		expect(matchWorkflows(workflows, "notor/workflows/weekly/review")).toEqual([workflows[1]]);
		expect(matchWorkflows(workflows, "notor/workflows/summarize.md")).toEqual([workflows[2]]);
	});

	it("treats a shared file name as ambiguous", () => {
		expect(matchWorkflows(workflows, "review")).toHaveLength(2);
	});

	it("falls back to aliases", () => {
		expect(matchWorkflows(workflows, "Daily")).toEqual([workflows[0]]);
	});
});
