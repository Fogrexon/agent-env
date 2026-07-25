/**
 * Phase A runtime: RunSpec, state machine, events, budget, verifier, tool gateway.
 * Maps to research doc planes — see docs/ARCHITECTURE.md.
 */
export { collectLlmAgents } from './agent-tree.js';
export { BudgetManager, type BudgetExhaustionReason, type BudgetSnapshot } from './budget.js';
export { InMemoryEventStore, type AppendEventInput } from './event-store.js';
export {
  applyRunSpecOverrides,
  parseRunSpec,
  resolveRunSpecModel,
  runFromSpec,
  type RunFromSpecOptions,
  type RunFromSpecResult,
  type RunSpecOverrides,
} from './run-from-spec.js';
export {
  RunStateMachine,
  assertTransition,
  canTransition,
  phaseForState,
} from './state-machine.js';
export { createGuardedTool, type GuardedToolOptions } from './tool-gateway.js';
export {
  applyRunSpecToolPolicy,
  RUNSPEC_ALLOWLIST_DENIAL,
  type AppliedToolPolicy,
  type ApplyRunSpecToolPolicyOptions,
  type ToolCallInfo,
  type ToolPolicyHooks,
} from './spec-tool-policy.js';
export {
  emitToolProgress,
  getLlmProgressAuthor,
  runWithLlmProgressAuthor,
  runWithProgressEmit,
} from './progress-context.js';
export {
  bindLlmProgressAuthor,
  ProgressScopedLlm,
} from './llm-progress-scope.js';
export {
  composeProgressSinks,
  createRunHistoryStore,
  RUN_WORKSPACE_STATE_KEY,
  type CreateRunHistoryStoreOptions,
  type OpenRunHistoryInput,
  type RunHistoryListItem,
  type RunHistoryMeta,
  type RunHistoryMode,
  type RunHistoryReadResult,
  type RunHistoryStatus,
  type RunHistoryStore,
  type RunHistoryWriter,
} from './run-history.js';
export { verifyRunSpec, hasMarkdownHeading, hasHtmlHeading, type VerifyContext, type GraderOutcome } from './verifier.js';
export {
  loadEvaluationSpec,
  parseEvaluationSpec,
} from './load-evaluation.js';
export {
  assertInsideRoot,
  createDefaultProcessRunner,
  minimalChildEnv,
  resolveTsInvoke,
  truncateUtf8,
  type ProcessRunRequest,
  type ProcessRunResult,
  type ProcessRunner,
  type TsInvokeOptions,
} from './process-runner.js';
export {
  createTsCodeRunnerTool,
  runGeneratedTsCode,
  type CodeExecResult,
  type CreateTsCodeRunnerToolOptions,
} from './code-exec.js';
export {
  createExecEnvGuard,
  ensureExecEnv,
  execEnvManifestHash,
  type EnsureExecEnvOptions,
  type ExecEnvResult,
  type ExecEnvStatus,
} from './exec-env.js';
