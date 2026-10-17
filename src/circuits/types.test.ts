import { describe, it, expect } from "vitest";
import {
	CIRCUIT_CANCELLED,
	CIRCUIT_COMPLETE,
	CIRCUIT_ERROR,
	CODE_STEP_ARG_NAMES,
	FLOW_CANCELLED,
	FLOW_COMPLETE,
	FLOW_ERROR,
	canonicalTopic,
	isTerminalTopic,
} from "./types";

describe("circuit topic aliases", () => {
	it.each([
		[CIRCUIT_COMPLETE, FLOW_COMPLETE],
		[CIRCUIT_CANCELLED, FLOW_CANCELLED],
		[CIRCUIT_ERROR, FLOW_ERROR],
		["circuit.tasks_remaining", "flow.tasks_remaining"],
		["circuit.requirements_unmet", "flow.requirements_unmet"],
		[" CIRCUIT_COMPLETE ", FLOW_COMPLETE],
	])("canonicalTopic(%j) === %j", (alias, canonical) => {
		expect(canonicalTopic(alias)).toBe(canonical);
	});

	it("leaves canonical and ordinary topics untouched (not even trimmed)", () => {
		for (const topic of [FLOW_COMPLETE, "review.passed", " padded ", "circuit_complete", "CIRCUIT_COMPLETE_X"]) {
			expect(canonicalTopic(topic)).toBe(topic);
		}
	});

	it("treats both spellings as terminal", () => {
		for (const t of [FLOW_COMPLETE, FLOW_CANCELLED, FLOW_ERROR, CIRCUIT_COMPLETE, CIRCUIT_CANCELLED, CIRCUIT_ERROR]) {
			expect(isTerminalTopic(t)).toBe(true);
		}
		expect(isTerminalTopic("circuit.tasks_remaining")).toBe(false);
		expect(isTerminalTopic("review.passed")).toBe(false);
	});

	it("code steps receive both `orchestration` and its alias `circuit`", () => {
		expect(CODE_STEP_ARG_NAMES).toEqual(["app", "obsidian", "utils", "libs", "event", "orchestration", "circuit"]);
	});
});
