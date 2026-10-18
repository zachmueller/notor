/**
 * Live observation seam for a single circuit run (not inherited by children).
 *
 * Today it powers the external API's follow mode (load each step conversation
 * into a chat panel as it is saved). Live streaming of step turns into a panel
 * can extend this interface with turn-start / stream events later.
 */

import type { StepProgressNotifier } from "./step-turn-executor";

/** A conversation-step turn whose step conversation has just been persisted. */
export type StepTurnSaved = Parameters<StepProgressNotifier>[0];

export interface CircuitRunObserver {
	/** Called after each conversation-step turn completes and its conversation is saved. */
	onStepTurnSaved?(turn: StepTurnSaved): void;
}
