/**
 * Phase A runtime: RunSpec, state machine, events, budget, verifier, tool gateway.
 * Maps to research doc planes — see docs/ARCHITECTURE.md.
 */
export { BudgetManager, type BudgetExhaustionReason, type BudgetSnapshot } from './budget.js';
export { InMemoryEventStore, type AppendEventInput } from './event-store.js';
export { runFromSpec, parseRunSpec, type RunFromSpecOptions, type RunFromSpecResult } from './run-from-spec.js';
export {
  RunStateMachine,
  assertTransition,
  canTransition,
  phaseForState,
} from './state-machine.js';
export { createGuardedTool, type GuardedToolOptions } from './tool-gateway.js';
export { verifyRunSpec, type VerifyContext } from './verifier.js';
