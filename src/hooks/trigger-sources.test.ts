/**
 * Unit tests for `collectTriggerTargets()` / `fireTriggerTarget()` — the
 * source collection + routing shared by `VaultEventScheduler` and the
 * daily-start detector.
 */

import { describe, expect, it, vi } from "vitest";
import { collectTriggerTargets, fireTriggerTarget, type TriggerSourceSpec } from "./trigger-sources";
import type { VaultEventHook, Workflow } from "../types";
import type { NotorSettings } from "../settings/types";
import type { UserAutomationDefinition } from "../extensions/types";
import type { Circuit } from "../circuits/types";
import { circuitEvalJobKey, circuitJobKey } from "../circuits/circuit-enabled";

const DAILY: TriggerSourceSpec = {
	hookEvent: "on_daily_start",
	workflowTrigger: "on-daily-start",
	circuitMatches: (c) => c.dailyStart,
	requireSchedule: false,
};

const SCHEDULE: TriggerSourceSpec = {
	hookEvent: "on_schedule",
	workflowTrigger: "on-schedule",
	circuitMatches: (c) => !!c.schedule,
	requireSchedule: true,
};

function hook(over: Partial<VaultEventHook> = {}): VaultEventHook {
	return {
		id: "h1",
		event: "on_daily_start",
		action_type: "execute_command",
		command: "echo hi",
		workflow_path: null,
		label: "Morning",
		enabled: true,
		schedule: null,
		delay_ms: null,
		...over,
	};
}

function workflow(path: string, trigger: string, schedule: string | null = null): Workflow {
	return { file_path: path, display_name: path, trigger, schedule } as unknown as Workflow;
}

function circuit(flowDir: string, over: Partial<Circuit> = {}): Circuit {
	return { name: flowDir, flowDir, schedule: null, dailyStart: false, ...over } as unknown as Circuit;
}

function settings(over: Partial<NotorSettings> = {}): NotorSettings {
	return { workflow_enabled: {}, flow_enabled: {}, ...over } as unknown as NotorSettings;
}

describe("collectTriggerTargets", () => {
	it("collects all four source kinds for on_daily_start", () => {
		const automation = { filePath: "auto.md", displayName: "Auto", schedule: null } as UserAutomationDefinition;
		const getAutomations = vi.fn().mockReturnValue([automation]);
		const targets = collectTriggerTargets(DAILY, [hook()], {
			getSettings: () => settings(),
			getDiscoveredWorkflows: () => [workflow("wf.md", "on-daily-start"), workflow("other.md", "on-save")],
			getAutomations,
			getDiscoveredCircuits: () => [circuit("c/daily", { dailyStart: true }), circuit("c/other")],
		});

		expect(targets.map((t) => [t.kind, t.key])).toEqual([
			["hook", "h1"],
			["workflow", "workflow:wf.md"],
			["automation", "ext-auto:auto.md"],
			["circuit", circuitJobKey("c/daily")],
		]);
		expect(getAutomations).toHaveBeenCalledWith("on_daily_start");
	});

	it("skips disabled hooks, hooks for other events, and disabled workflows and circuits", () => {
		const targets = collectTriggerTargets(DAILY, [hook({ enabled: false }), hook({ id: "h2", event: "on_save" })], {
			getSettings: () => settings({
				workflow_enabled: { "wf.md": false },
				flow_enabled: { "c/daily": false },
			}),
			getDiscoveredWorkflows: () => [workflow("wf.md", "on-daily-start")],
			getAutomations: null,
			getDiscoveredCircuits: () => [circuit("c/daily", { dailyStart: true })],
		});
		expect(targets).toEqual([]);
	});

	it("requires a schedule on every source for on_schedule", () => {
		const targets = collectTriggerTargets(
			SCHEDULE,
			[hook({ event: "on_schedule" }), hook({ id: "h2", event: "on_schedule", schedule: " 0 9 * * * " })],
			{
				getSettings: () => settings(),
				getDiscoveredWorkflows: () => [
					workflow("a.md", "on-schedule"),
					workflow("b.md", "on-schedule", "0 9 * * *"),
				],
				getAutomations: () => [
					{ filePath: "x.md", displayName: null, schedule: null } as UserAutomationDefinition,
				],
				getDiscoveredCircuits: () => [circuit("c/s", { schedule: "0 9 * * *" }), circuit("c/none")],
			},
		);
		expect(targets.map((t) => t.key)).toEqual(["h2", "workflow:b.md", circuitJobKey("c/s")]);
	});
});

describe("fireTriggerTarget", () => {
	it("dispatches hooks with a note-less context for the given event", () => {
		const dispatchFn = vi.fn();
		const h = hook();
		fireTriggerTarget({ kind: "hook", key: h.id, label: h.label, hook: h }, "on_daily_start", "Daily start", {
			dispatchFn,
			executeAutomation: null,
			launchCircuit: null,
		});
		expect(dispatchFn).toHaveBeenCalledTimes(1);
		const [hooks, context, chain] = dispatchFn.mock.calls[0]!;
		expect(hooks).toEqual([h]);
		expect(context).toMatchObject({ hookEvent: "on_daily_start", notePath: null });
		expect(chain).toBeNull();
	});

	it("runs automations with the event context (schedule only when set)", async () => {
		const executeAutomation = vi.fn().mockResolvedValue(undefined);
		const automation = { filePath: "auto.md", displayName: null, schedule: null } as UserAutomationDefinition;
		fireTriggerTarget({ kind: "automation", key: "ext-auto:auto.md", label: "auto.md", automation }, "on_daily_start", "Daily start", {
			dispatchFn: null,
			executeAutomation,
			launchCircuit: null,
		});
		await vi.waitFor(() => expect(executeAutomation).toHaveBeenCalled());
		const context = executeAutomation.mock.calls[0]![1] as Record<string, unknown>;
		expect(context.hookEvent).toBe("on_daily_start");
		expect("schedule" in context).toBe(false);
	});

	it("launches circuits through the circuit launcher", async () => {
		const launchCircuit = vi.fn().mockResolvedValue(undefined);
		const c = circuit("c/daily", { dailyStart: true });
		fireTriggerTarget({ kind: "circuit", key: circuitJobKey(c.flowDir), label: c.name, circuit: c }, "on_daily_start", "Daily start", {
			dispatchFn: null,
			executeAutomation: null,
			launchCircuit,
		});
		await vi.waitFor(() => expect(launchCircuit).toHaveBeenCalledWith(c));
	});

	it("passes the run observer to circuit launches and dispatches", async () => {
		const launchCircuit = vi.fn().mockResolvedValue(undefined);
		const dispatchFn = vi.fn();
		const observer = { circuit: { sessionId: "s1", origin: "daily_start" as const }, onWorkflowSubmitted: vi.fn() };
		const c = circuit("c/daily", { dailyStart: true });
		const executors = { dispatchFn, executeAutomation: null, launchCircuit };
		fireTriggerTarget({ kind: "circuit", key: "k", label: c.name, circuit: c }, "on_daily_start", "Daily start", executors, observer);
		const w = workflow("wf.md", "on-daily-start");
		fireTriggerTarget({ kind: "workflow", key: "workflow:wf.md", label: "wf", workflow: w }, "on_daily_start", "Daily start", executors, observer);

		await vi.waitFor(() => expect(launchCircuit).toHaveBeenCalledWith(c, observer.circuit));
		expect(dispatchFn.mock.calls[0]![3]).toBe(observer);
	});
});

describe("circuit evaluation targets (notor-eval-schedule)", () => {
	const SCHEDULE_WITH_EVAL: TriggerSourceSpec = {
		...SCHEDULE,
		circuitEvalMatches: (c) => !!c.evalSchedule && c.evaluators.length > 0,
	};
	const evaluated = (flowDir: string, over: Partial<Circuit> = {}) =>
		circuit(flowDir, { evalSchedule: "0 6 * * *", evaluators: [{ name: "j" }] as Circuit["evaluators"], ...over });

	it("collects circuit_eval targets only when the spec opts in, keyed eval:{dir}, alongside the run job", () => {
		const accessors = {
			getSettings: () => settings(),
			getDiscoveredWorkflows: null,
			getAutomations: null,
			getDiscoveredCircuits: () => [
				evaluated("c/both", { schedule: "0 9 * * *" }),
				evaluated("c/eval-only"),
				evaluated("c/no-evaluators", { evaluators: [] }),
				circuit("c/run-only", { schedule: "0 9 * * *" }),
			],
		};
		expect(collectTriggerTargets(SCHEDULE_WITH_EVAL, [], accessors).map((t) => [t.kind, t.key])).toEqual([
			["circuit", circuitJobKey("c/both")],
			["circuit", circuitJobKey("c/run-only")],
			["circuit_eval", circuitEvalJobKey("c/both")],
			["circuit_eval", circuitEvalJobKey("c/eval-only")],
		]);
		// The daily-start spec has no eval opt-in: no circuit_eval targets ever.
		expect(collectTriggerTargets(SCHEDULE, [], accessors).some((t) => t.kind === "circuit_eval")).toBe(false);
	});

	it("honors the separate eval:{dir} enable key", () => {
		const targets = collectTriggerTargets(SCHEDULE_WITH_EVAL, [], {
			getSettings: () => settings({ flow_enabled: { "eval:c/eval-only": false } }),
			getDiscoveredWorkflows: null,
			getAutomations: null,
			getDiscoveredCircuits: () => [evaluated("c/eval-only", { schedule: "0 9 * * *" })],
		});
		// The run job survives; only the evaluation job is switched off.
		expect(targets.map((t) => t.kind)).toEqual(["circuit"]);
	});

	it("fires circuit_eval through evaluateCircuit, and skips without an evaluator", async () => {
		const evaluateCircuit = vi.fn().mockResolvedValue(undefined);
		const c = evaluated("c/e");
		fireTriggerTarget({ kind: "circuit_eval", key: circuitEvalJobKey(c.flowDir), label: c.name, circuit: c }, "on_schedule", "Scheduled", {
			dispatchFn: null,
			executeAutomation: null,
			launchCircuit: null,
			evaluateCircuit,
		});
		await vi.waitFor(() => expect(evaluateCircuit).toHaveBeenCalledWith(c));

		const launchCircuit = vi.fn();
		fireTriggerTarget({ kind: "circuit_eval", key: "k", label: c.name, circuit: c }, "on_schedule", "Scheduled", {
			dispatchFn: null,
			executeAutomation: null,
			launchCircuit,
		});
		expect(launchCircuit).not.toHaveBeenCalled();
	});
});
