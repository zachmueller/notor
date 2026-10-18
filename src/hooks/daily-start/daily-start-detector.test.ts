import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ACTIVITY_THROTTLE_MS, DailyStartDetector, type DailyStartUi } from "./daily-start-detector";
import { MemoryDailyStartState } from "./daily-start-state";
import type { NotorSettings } from "../../settings/types";
import type { VaultEventHook, Workflow, WorkflowExecution } from "../../types";
import type { PreflightFailure } from "./preflight";
import type { TriggerDispatchFn, TriggerExecutors } from "../trigger-sources";

vi.mock("../../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const commandHook: VaultEventHook = {
	id: "cmd",
	event: "on_daily_start",
	action_type: "execute_command",
	command: "echo morning",
	workflow_path: null,
	label: "Morning command",
	enabled: true,
	schedule: null,
	delay_ms: null,
};

const dailyWorkflow = {
	file_path: "notor/workflows/brief.md",
	display_name: "Brief",
	trigger: "on-daily-start",
	schedule: null,
} as unknown as Workflow;

const AUTH_FAIL: PreflightFailure = { providerId: "bedrock", providerLabel: "Bedrock", kind: "auth", message: "expired" };

function makeSettings(over: Partial<NotorSettings> = {}): NotorSettings {
	return {
		vault_event_hooks: { on_daily_start: [commandHook] },
		workflow_enabled: {},
		flow_enabled: {},
		daily_start_reset_time: "04:00",
		daily_start_retry_max_attempts: 5,
		daily_start_retry_base_minutes: 3,
		daily_start_retry_max_minutes: 30,
		...over,
	} as unknown as NotorSettings;
}

function makeUi() {
	return {
		runChanged: vi.fn<DailyStartUi["runChanged"]>(),
		preflightFailed: vi.fn<DailyStartUi["preflightFailed"]>(),
		preflightCleared: vi.fn<DailyStartUi["preflightCleared"]>(),
	};
}

describe("DailyStartDetector", () => {
	let state: MemoryDailyStartState;
	let settings: NotorSettings;
	let workflows: Workflow[];
	let dispatchFn: Mock<TriggerDispatchFn>;
	let preflightRun: Mock<(ids: string[]) => Promise<PreflightFailure | null>>;
	let ui: ReturnType<typeof makeUi>;
	let detector: DailyStartDetector;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 9, 18, 8, 0));
		state = new MemoryDailyStartState();
		settings = makeSettings();
		workflows = [];
		dispatchFn = vi.fn<TriggerDispatchFn>();
		preflightRun = vi.fn<(ids: string[]) => Promise<PreflightFailure | null>>().mockResolvedValue(null);
		ui = makeUi();
		const executors: TriggerExecutors = { dispatchFn, executeAutomation: null, launchCircuit: null };
		detector = new DailyStartDetector({
			getSettings: () => settings,
			state,
			sources: {
				getSettings: () => settings,
				getDiscoveredWorkflows: () => workflows,
				getAutomations: null,
				getDiscoveredCircuits: null,
			},
			executors,
			preflight: { resolveProviders: async () => ["bedrock"], run: preflightRun },
			ui,
		});
	});

	afterEach(() => {
		detector.destroy();
		vi.useRealTimers();
	});

	it("fires on start and only once per logical day", async () => {
		detector.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(dispatchFn).toHaveBeenCalledTimes(1);
		expect(dispatchFn.mock.calls[0]![1]).toMatchObject({ hookEvent: "on_daily_start", notePath: null });
		expect(state.data.lastFiredDay).toBe("2026-10-18");

		// Later the same day (past the throttle) — no second fire.
		vi.setSystemTime(new Date(2026, 9, 18, 23, 0));
		detector.noteActivity();
		await vi.advanceTimersByTimeAsync(0);
		expect(dispatchFn).toHaveBeenCalledTimes(1);

		// 02:00 next calendar day is still the same logical day (reset 04:00).
		vi.setSystemTime(new Date(2026, 9, 19, 2, 0));
		detector.noteActivity();
		await vi.advanceTimersByTimeAsync(0);
		expect(dispatchFn).toHaveBeenCalledTimes(1);

		// First activity after the reset fires again.
		vi.setSystemTime(new Date(2026, 9, 19, 7, 30));
		detector.noteActivity();
		await vi.advanceTimersByTimeAsync(0);
		expect(dispatchFn).toHaveBeenCalledTimes(2);
		expect(state.data.lastFiredDay).toBe("2026-10-19");
	});

	it("persists the fired day before dispatching", async () => {
		dispatchFn.mockImplementation(() => {
			expect(state.data.lastFiredDay).toBe("2026-10-18");
		});
		detector.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(dispatchFn).toHaveBeenCalledTimes(1);
	});

	it("throttles activity checks", async () => {
		detector.start();
		await vi.advanceTimersByTimeAsync(0);
		vi.setSystemTime(new Date(2026, 9, 19, 7, 0));
		state.data.lastFiredDay = "2026-10-18";
		// Well past the start() check's throttle window — this check runs.
		detector.noteActivity();
		await vi.advanceTimersByTimeAsync(0);
		expect(dispatchFn).toHaveBeenCalledTimes(2);
		// A second report right after is throttled even on a fresh day.
		state.data.lastFiredDay = null;
		vi.setSystemTime(new Date(Date.now() + ACTIVITY_THROTTLE_MS - 1));
		detector.noteActivity();
		await vi.advanceTimersByTimeAsync(0);
		expect(dispatchFn).toHaveBeenCalledTimes(2);
	});

	it("does not consume the day when nothing is configured", async () => {
		settings = makeSettings({ vault_event_hooks: { on_daily_start: [] } as unknown as NotorSettings["vault_event_hooks"] });
		detector.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(state.data.lastFiredDay).toBeNull();
		expect(detector.hasTargets()).toBe(false);
	});

	it("fires again on runNow regardless of the fired day", async () => {
		detector.start();
		await vi.advanceTimersByTimeAsync(0);
		await detector.runNow();
		expect(dispatchFn).toHaveBeenCalledTimes(2);
	});

	it("launches a workflow after its provider pre-flight passes and tracks the run", async () => {
		workflows = [dailyWorkflow];
		settings = makeSettings({ vault_event_hooks: { on_daily_start: [] } as unknown as NotorSettings["vault_event_hooks"] });
		detector.start();
		await vi.advanceTimersByTimeAsync(0);

		expect(preflightRun).toHaveBeenCalledWith(["bedrock"]);
		expect(dispatchFn).toHaveBeenCalledTimes(1);
		const observer = dispatchFn.mock.calls[0]![3]!;
		const exec = { status: "running", conversation_id: "", error_message: null } as unknown as WorkflowExecution;
		let finish: () => void = () => {};
		observer.onWorkflowSubmitted!(exec, new Promise<void>((r) => { finish = r; }));
		exec.conversation_id = "conv-1";
		expect(detector.conversationFor(detector.recentRuns()[0]!)).toBe("conv-1");

		exec.status = "completed";
		finish();
		await vi.advanceTimersByTimeAsync(0);
		const [record] = detector.recentRuns();
		expect(record).toMatchObject({ key: "workflow:notor/workflows/brief.md", status: "completed", conversationId: "conv-1" });
		expect(ui.runChanged).toHaveBeenCalled();
	});

	it("reports a pre-flight failure, retries with backoff, and launches once it passes", async () => {
		workflows = [dailyWorkflow];
		preflightRun.mockResolvedValueOnce(AUTH_FAIL);
		detector.start();
		await vi.advanceTimersByTimeAsync(0);

		// The command hook fired immediately; the workflow is waiting.
		expect(dispatchFn).toHaveBeenCalledTimes(1);
		expect(ui.preflightFailed).toHaveBeenCalledTimes(1);
		const report = ui.preflightFailed.mock.calls[0]![0];
		expect(report).toMatchObject({ reason: "credentials expired or invalid", attempt: 1, maxAttempts: 5, labels: ["Brief"] });
		const delay = report.retryAt! - Date.now();
		expect(delay).toBeGreaterThanOrEqual(0.8 * 3 * 60_000);
		expect(delay).toBeLessThanOrEqual(1.2 * 3 * 60_000);
		expect(state.data.pendingRetry).toMatchObject({ attempt: 1, targetKeys: ["workflow:notor/workflows/brief.md"] });
		expect(detector.recentRuns()[0]).toMatchObject({ status: "pending_retry" });

		await vi.advanceTimersByTimeAsync(delay);
		expect(dispatchFn).toHaveBeenCalledTimes(2);
		expect(dispatchFn.mock.calls[1]![0]).toEqual([dailyWorkflow]);
		expect(state.data.pendingRetry).toBeNull();
		expect(ui.preflightCleared).toHaveBeenCalled();
	});

	it("gives up after the configured number of retries", async () => {
		workflows = [dailyWorkflow];
		settings = makeSettings({
			vault_event_hooks: { on_daily_start: [] } as unknown as NotorSettings["vault_event_hooks"],
			daily_start_retry_max_attempts: 1,
		});
		preflightRun.mockResolvedValue(AUTH_FAIL);
		detector.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(4 * 60_000);

		expect(ui.preflightFailed).toHaveBeenCalledTimes(2);
		expect(ui.preflightFailed.mock.calls[1]![0]).toMatchObject({ retryAt: null, attempt: 1 });
		expect(state.data.pendingRetry).toBeNull();
		expect(detector.recentRuns()[0]).toMatchObject({ status: "gave_up" });
		expect(dispatchFn).not.toHaveBeenCalled();
	});

	it("does not retry when retries are disabled", async () => {
		workflows = [dailyWorkflow];
		settings = makeSettings({ daily_start_retry_max_attempts: 0 });
		preflightRun.mockResolvedValue(AUTH_FAIL);
		detector.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(ui.preflightFailed.mock.calls[0]![0]).toMatchObject({ retryAt: null, maxAttempts: 0 });
		expect(state.data.pendingRetry).toBeNull();
	});

	it("retries immediately on retryNow", async () => {
		workflows = [dailyWorkflow];
		preflightRun.mockResolvedValueOnce(AUTH_FAIL);
		detector.start();
		await vi.advanceTimersByTimeAsync(0);
		detector.retryNow();
		await vi.advanceTimersByTimeAsync(0);
		expect(dispatchFn).toHaveBeenCalledTimes(2);
		expect(state.data.pendingRetry).toBeNull();
	});

	it("resumes a persisted retry after a reload instead of firing fresh", async () => {
		workflows = [dailyWorkflow];
		state.data = {
			lastFiredDay: "2026-10-18",
			runs: [],
			pendingRetry: { attempt: 2, nextAt: Date.now() + 60_000, targetKeys: ["workflow:notor/workflows/brief.md"], reason: "x" },
		};
		detector.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(dispatchFn).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(60_000);
		expect(dispatchFn).toHaveBeenCalledTimes(1);
		expect(dispatchFn.mock.calls[0]![0]).toEqual([dailyWorkflow]);
	});
});
