/**
 * Unit tests for `VaultEventScheduler` scheduled-orchestration-flow handling.
 *
 * Focuses on the flow job source added for direct flow scheduling: `syncJobs()`
 * registers a cron job for a flow with a `notor-schedule`, respects the
 * `flow_enabled` toggle, and fires the flow launcher when the job triggers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VaultEventScheduler } from "./vault-event-scheduler";
import { circuitEvalJobKey, circuitJobKey } from "../circuits/circuit-enabled";
import type { Circuit } from "../circuits/types";
import type { NotorSettings } from "../settings/types";

function makeFlow(over: Partial<Circuit> = {}): Circuit {
	return {
		name: "Demo",
		description: "",
		flowDir: "notor/orchestrations/demo",
		startingEvent: "start",
		completionEvent: "FLOW_COMPLETE",
		maxIterations: 100,
		maxRuntimeMinutes: 60,
		requiredEvents: [],
		fanoutTopics: [],
		steps: [],
		guardrails: [],
		schedule: "0 9 * * *",
		dailyStart: false,
		evaluators: [],
		evalAuto: "none",
		evalSchedule: null,
		evalMaxCostUsd: null,
		invocable: false,
		flowInputs: null,
		flowReturns: null,
		onCompleteFlow: null,
		handoffIsolation: "isolated",
		maxDepth: null,
		maxCostUsd: 5,
		openNotesInEditor: null,
		allowConcurrent: false,
		...over,
	};
}

function settingsWith(flowEnabled: Record<string, boolean>): NotorSettings {
	return { flow_enabled: flowEnabled, workflow_enabled: {} } as unknown as NotorSettings;
}

describe("VaultEventScheduler — scheduled orchestration flows", () => {
	let scheduler: VaultEventScheduler;

	beforeEach(() => {
		scheduler = new VaultEventScheduler();
		// Dispatch is required for non-flow paths; harmless here.
		scheduler.setDispatch(vi.fn(), () => []);
	});

	afterEach(() => {
		scheduler.destroy();
	});

	it("registers a cron job for a flow with a notor-schedule", () => {
		const flow = makeFlow();
		scheduler.setSettingsAccessor(() => settingsWith({}));
		scheduler.setDiscoveredFlows(() => [flow], vi.fn());

		scheduler.syncJobs([]);

		expect(scheduler.isJobActive(circuitJobKey(flow.flowDir))).toBe(true);
	});

	it("does not register a job for a flow without a schedule", () => {
		const flow = makeFlow({ schedule: null });
		scheduler.setSettingsAccessor(() => settingsWith({}));
		scheduler.setDiscoveredFlows(() => [flow], vi.fn());

		scheduler.syncJobs([]);

		expect(scheduler.isJobActive(circuitJobKey(flow.flowDir))).toBe(false);
	});

	it("skips a flow disabled via flow_enabled", () => {
		const flow = makeFlow();
		scheduler.setSettingsAccessor(() => settingsWith({ [flow.flowDir]: false }));
		scheduler.setDiscoveredFlows(() => [flow], vi.fn());

		scheduler.syncJobs([]);

		expect(scheduler.isJobActive(circuitJobKey(flow.flowDir))).toBe(false);
	});

	it("removes the job when the flow is later disabled", () => {
		const flow = makeFlow();
		let enabled: Record<string, boolean> = {};
		scheduler.setSettingsAccessor(() => settingsWith(enabled));
		scheduler.setDiscoveredFlows(() => [flow], vi.fn());

		scheduler.syncJobs([]);
		expect(scheduler.isJobActive(circuitJobKey(flow.flowDir))).toBe(true);

		enabled = { [flow.flowDir]: false };
		scheduler.syncJobs([]);
		expect(scheduler.isJobActive(circuitJobKey(flow.flowDir))).toBe(false);
	});

	it("fires the flow launcher when a second-resolution cron job triggers", async () => {
		const flow = makeFlow({ schedule: "* * * * * *" }); // every second (croner 6-field)
		const launch = vi.fn().mockResolvedValue(undefined);
		scheduler.setSettingsAccessor(() => settingsWith({}));
		scheduler.setDiscoveredFlows(() => [flow], launch);

		scheduler.syncJobs([]);
		expect(scheduler.isJobActive(circuitJobKey(flow.flowDir))).toBe(true);

		// Real timer: wait just over a second for the cron to fire once.
		await new Promise((resolve) => setTimeout(resolve, 1200));

		expect(launch).toHaveBeenCalledWith(flow);
	});
});

describe("VaultEventScheduler — scheduled circuit evaluation (notor-eval-schedule)", () => {
	let scheduler: VaultEventScheduler;
	const evaluators = [{ name: "judge" }] as unknown as Circuit["evaluators"];

	beforeEach(() => {
		scheduler = new VaultEventScheduler();
		scheduler.setDispatch(vi.fn(), () => []);
	});

	afterEach(() => {
		scheduler.destroy();
	});

	it("registers an eval:{dir} job next to the run job, only when the circuit has evaluators", () => {
		const flow = makeFlow({ evalSchedule: "0 6 * * *", evaluators });
		const inert = makeFlow({ flowDir: "notor/orchestrations/inert", schedule: null, evalSchedule: "0 6 * * *", evaluators: [] });
		scheduler.setSettingsAccessor(() => settingsWith({}));
		scheduler.setDiscoveredFlows(() => [flow, inert], vi.fn());
		scheduler.setCircuitEvaluator(vi.fn());

		scheduler.syncJobs([]);

		expect(scheduler.isJobActive(circuitJobKey(flow.flowDir))).toBe(true);
		expect(scheduler.isJobActive(circuitEvalJobKey(flow.flowDir))).toBe(true);
		expect(scheduler.isJobActive(circuitEvalJobKey(inert.flowDir))).toBe(false);
	});

	it("toggles the evaluation job with its own flow_enabled key", () => {
		const flow = makeFlow({ evalSchedule: "0 6 * * *", evaluators });
		let enabled: Record<string, boolean> = { [circuitEvalJobKey(flow.flowDir)]: false };
		scheduler.setSettingsAccessor(() => settingsWith(enabled));
		scheduler.setDiscoveredFlows(() => [flow], vi.fn());

		scheduler.syncJobs([]);
		expect(scheduler.isJobActive(circuitJobKey(flow.flowDir))).toBe(true);
		expect(scheduler.isJobActive(circuitEvalJobKey(flow.flowDir))).toBe(false);

		enabled = {};
		scheduler.syncJobs([]);
		expect(scheduler.isJobActive(circuitEvalJobKey(flow.flowDir))).toBe(true);
	});

	it("fires the circuit evaluator (not the launcher) when the eval job triggers", async () => {
		const flow = makeFlow({ schedule: null, evalSchedule: "* * * * * *", evaluators });
		const launch = vi.fn().mockResolvedValue(undefined);
		const evaluate = vi.fn().mockResolvedValue(undefined);
		scheduler.setSettingsAccessor(() => settingsWith({}));
		scheduler.setDiscoveredFlows(() => [flow], launch);
		scheduler.setCircuitEvaluator(evaluate);

		scheduler.syncJobs([]);
		expect(scheduler.isJobActive(circuitEvalJobKey(flow.flowDir))).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 1200));

		expect(evaluate).toHaveBeenCalledWith(flow);
		expect(launch).not.toHaveBeenCalled();
	});
});
