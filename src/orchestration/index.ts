/**
 * Orchestration module barrel (design Phase 1).
 *
 * Re-exports the orchestration domain types, constants, and the Phase-1 engine
 * components. The run-loop substrate (`src/run-loop/`) is a separate module and
 * is NOT re-exported here.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md
 */

export type {
	OrchestrationFlow,
	StepDefinition,
	OrchestrationEvent,
	OrchestrationSessionMeta,
} from "./types";
export {
	FLOW_COMPLETE,
	FLOW_CANCELLED,
	FLOW_ERROR,
	TERMINAL_TOPICS,
	isTerminalTopic,
	CODE_STEP_ARG_NAMES,
} from "./types";
export {
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_MAX_RUNTIME_MINUTES,
	DEFAULT_MAX_COST_USD,
	STALE_REPEAT_THRESHOLD,
	STALE_WINDOW_SIZE,
	THRASHING_ABANDON_THRESHOLD,
	COMPLETION_NOPROGRESS_THRESHOLD,
	EVENT_HISTORY_PROMPT_LIMIT,
} from "./constants";

export { SessionLog } from "./session-log";
export type {
	SessionLogEntry,
	SessionLogWriter,
} from "./session-log";
export { FlowDefinitionParser, StepNoteParser, FlowParseError } from "./flow-parser";
export type { FlowParseResult, FlowParseWarning } from "./flow-parser";
export { OrchestrationEventEngine } from "./event-engine";
export { FallbackCoordinator } from "./fallback-coordinator";
export { StepPromptBuilder } from "./step-prompt-builder";
export type { StepPromptBuildArgs } from "./step-prompt-builder";
export { LoopSafetyGuards, isStale } from "./safety";
export type { SafetyGuardResult, ThrashingCounters } from "./safety";
export { StepTurnExecutor } from "./step-turn-executor";
export { OrchestrationRunner } from "./runner";
export type { OrchestrationRunResult } from "./runner";
export { CodeStepExecutor } from "./code-step-executor";
export type {
	CodeStepExecutorDeps,
	CodeStepRuntime,
	CodeStepRuntimeFactory,
} from "./code-step-executor";
export {
	buildOrchestrationHelper,
	projectCodeStepEvent,
} from "./orchestration-helper";
export type {
	OrchestrationHelper,
	CodeStepEvent,
	CodeStepResult,
	ScratchpadFs,
	BuildOrchestrationHelperArgs,
} from "./orchestration-helper";
export { OrchestrationSessionManager } from "./session-manager";
export type {
	SessionFs,
	SessionWorkspace,
	CreateSessionArgs,
} from "./session-manager";
export {
	TaskRegistry,
	serializeTaskNote,
	parseTaskNote,
	sanitizeTaskKey,
} from "./task-registry";
export type {
	TaskFs,
	TaskNote,
	TaskStatus,
	EnsureResult,
	MutateResult,
} from "./task-registry";
export { seedMemoriesNote, memoriesPath, MEMORIES_SKELETON } from "./memories";
export { SessionLogReader, SessionLogParseError } from "./session-log-reader";
export type { ParsedSessionLog } from "./session-log-reader";
export { SessionRecovery } from "./session-recovery";
export type {
	RecoveryAction,
	RecoverableSession,
	RecoveryFs,
} from "./session-recovery";
export { VaultStepConversationStore, buildStepConversationHeader } from "./step-conversation-store";
export type {
	StepConversationStore,
	StepConversationRecord,
	StepConversationFs,
} from "./step-conversation-store";
