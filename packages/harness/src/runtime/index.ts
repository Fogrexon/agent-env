/**

 * Runtime: state machine, events, budget, tool gateway.

 * Maps to research doc planes — see docs/ARCHITECTURE.md.

 */

export { collectLlmAgents } from './agent-tree.js';
export {
  assertGraphModelsResolvable,
  buildObservedGraph,
  describeAgentGraph,
} from './agent-graph.js';

export { BudgetManager, type BudgetExhaustionReason, type BudgetSnapshot } from './budget.js';

export { InMemoryEventStore, type AppendEventInput } from './event-store.js';

export {

  executeAgentRun,

  type ExecuteAgentRunOptions,

  type ExecuteAgentRunResult,

} from './run-execution.js';

export {

  RunStateMachine,

  assertTransition,

  canTransition,

  phaseForState,

} from './state-machine.js';

export { createGuardedTool, type GuardedToolOptions } from './tool-gateway.js';

export {

  getToolApprovalPolicy,

  resolveToolApproval,

  runWithToolApproval,

  type ToolApprovalDecision,

  type ToolApprovalMode,

  type ToolApprovalPolicy,

  type ToolApprovalRequest,

} from './tool-approval.js';

export {

  applyToolRuntimePolicy,

  type AppliedToolPolicy,

  type ApplyToolRuntimePolicyOptions,

  type ToolCallInfo,

  type ToolPolicyHooks,

} from './tool-runtime-policy.js';

export {

  emitApprovalProgress,

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

export {

  bootstrapPythonCandidates,

  createPythonEnvGuard,

  ensurePythonEnv,

  pythonEnvManifestHash,

  resolvePythonBin,

  resolveUvBin,

  type EnsurePythonEnvOptions,

  type PythonEnvResult,

  type PythonEnvStatus,

} from './python-env.js';

export {

  createPythonCodeRunnerTool,

  createPythonScriptTool,

  runGeneratedPythonCode,

  runPythonScript,

  type CreatePythonCodeRunnerToolOptions,

  type CreatePythonScriptToolOptions,

  type RunPythonScriptOptions,

} from './python-exec.js';


