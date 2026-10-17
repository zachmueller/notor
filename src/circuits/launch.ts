/**
 * Orchestration launch barrel (FEAT-011). The former 1.5k-line `launch.ts` was
 * split by responsibility (F6) into launch-wiring / run-lifecycle / child-spawn /
 * recovery-boot and the ui-side circuit-modals. This barrel re-exports the
 * five public symbols so existing importers (main.ts, commands) stay untouched and
 * dynamic imports keep lazy-loading the layer.
 *
 * @see specs/ZZ-misc/arch-review-july-2026/F6-launch-ts-decomposition.md
 */

export { VaultSessionFs } from "./launch-wiring";
export { launchCircuit } from "./run-lifecycle";
export { makeChildCircuitSpawner } from "./child-spawn";
export { recoverCircuits } from "./recovery-boot";
export { showCircuitPicker } from "../ui/circuit-modals";
