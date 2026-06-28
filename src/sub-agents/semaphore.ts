/**
 * Reusable counting semaphore for concurrency control.
 *
 * The implementation was generalized into the run-loop layer
 * (`src/run-loop/semaphore.ts`, ARCH-006) so orchestration child-run
 * concurrency can use the same primitive without a sub-agent dependency. This
 * module re-exports it to keep existing sub-agent imports
 * (`use-subagent.ts` → `new Semaphore(SUB_AGENT_CONCURRENCY_CAP)`) unchanged.
 *
 * @see src/run-loop/semaphore.ts — generalized primitive
 * @see specs/ZZ-misc/sub-agents-design.md — Section 9.3
 */

export { Semaphore } from "../run-loop/semaphore";
