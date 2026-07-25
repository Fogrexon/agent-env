import { randomUUID } from 'node:crypto';
import type { BaseAgent } from '@google/adk';
import {
  createProgressSequencer,
  runRecordSchema,
  type AgentAttachment,
  type AgentProgressEvent,
  type AgentProgressSink,
  type EvaluationSpec,
  type ModelRef,
  type RunRecord,
  type VerificationResult,
} from '@agent-env/shared';
import { runAgent } from '../runner.js';
import { BudgetManager } from './budget.js';
import { InMemoryEventStore } from './event-store.js';
import {
  applyRunSpecOverrides,
  parseRunSpec,
  resolveRunSpecModel,
} from './run-spec-parse.js';
import { loadEvaluationSpec } from './load-evaluation.js';
import { RUN_WORKSPACE_STATE_KEY } from './run-history.js';
import { applyRunSpecToolPolicy, RUNSPEC_ALLOWLIST_DENIAL } from './spec-tool-policy.js';
import { canTransition, RunStateMachine } from './state-machine.js';
import { verifyRunSpec, type VerifyContext } from './verifier.js';

export {
  applyRunSpecOverrides,
  parseRunSpec,
  resolveRunSpecModel,
  type RunSpecOverrides,
} from './run-spec-parse.js';
export { loadEvaluationSpec, parseEvaluationSpec } from './load-evaluation.js';

export interface RunFromSpecOptions {
  /**
   * RunSpec document (template or already-merged effective spec).
   * Sole source of task/model/budget/tools for the run.
   */
  spec: unknown;
  agent: BaseAgent;
  /**
   * Resolved EvaluationSpec for this attempt. When omitted, loaded from
   * `spec.evaluation.ref` relative to `evaluationBaseDir` / `cwd`.
   */
  evaluation?: EvaluationSpec;
  /** Directory used to resolve `evaluation.ref` (agent package dir). */
  evaluationBaseDir?: string;
  /**
   * Convenience: merged into the effective RunSpec as `task.objective`
   * via {@link applyRunSpecOverrides}. Prefer merging at the call site.
   */
  message?: string;
  /**
   * Convenience: merged into the effective RunSpec as `model.primary`
   * via {@link applyRunSpecOverrides}. Prefer merging at the call site.
   */
  model?: ModelRef;
  /** Convenience: merged into `task.inputs`. Prefer merging at the call site. */
  inputs?: Record<string, unknown>;
  /** Forwarded to runAgent and merged with task.inputs. */
  stateDelta?: Record<string, unknown>;
  /** Forwarded to runAgent (multimodal attachments). */
  attachments?: readonly AgentAttachment[];
  cwd?: string;
  /** Outer correlation id (admin run store). Defaults to a new UUID. */
  runId?: string;
  abortSignal?: AbortSignal;
  eventStore?: InMemoryEventStore;
  verifyContext?: Omit<VerifyContext, 'finalText'>;
  onEvent?: (event: ReturnType<InMemoryEventStore['append']>) => void;
  /** Unified live progress stream (RunSpec + ADK agent events). */
  onProgress?: AgentProgressSink;
}

export interface RunFromSpecResult {
  record: RunRecord;
  /** Effective RunSpec after applying message/model/input overrides. */
  effectiveSpec: ReturnType<typeof parseRunSpec>;
  /** EvaluationSpec snapshot used for verification. */
  effectiveEvaluation: EvaluationSpec;
  events: ReturnType<InMemoryEventStore['list']>;
  agentFinalText?: string;
}

/** Feedback turn for the REPAIRING loop (harness.maxRepairs). */
function buildRepairMessage(
  objective: string,
  previous: string | undefined,
  verification: VerificationResult,
): string {
  const failed = verification.checks
    .filter((check) => !check.passed)
    .map(
      (check) =>
        `- ${check.criterion}${check.detail ? ` (${check.detail})` : ''}`,
    )
    .join('\n');
  const parts = [
    'Your previous answer failed independent verification. Produce a corrected final answer.',
    '',
    `Original objective: ${objective}`,
    '',
    'Failed checks:',
    failed || '- (none reported)',
  ];
  if (previous) {
    parts.push('', 'Previous answer:', previous);
  }
  return parts.join('\n');
}

/**
 * Phase A orchestrator entry: RunSpec → state machine → agent → independent verifier.
 * Orchestrator does not call shell/business APIs; tools go through ADK / tool gateway.
 */
export async function runFromSpec(
  options: RunFromSpecOptions,
): Promise<RunFromSpecResult> {
  // Effective RunSpec is the sole intent: optional message/model/inputs are merged in.
  const spec = applyRunSpecOverrides(options.spec, {
    objective: options.message,
    model: options.model,
    ...(options.inputs ? { inputs: options.inputs } : {}),
  });
  const evaluationBaseDir =
    options.evaluationBaseDir ?? options.cwd ?? process.cwd();
  const evaluation =
    options.evaluation ?? loadEvaluationSpec(spec, evaluationBaseDir);
  const effectiveModel = resolveRunSpecModel(spec);
  const objective = spec.spec.task.objective;
  /** Per-run workspace (set by the entrypoint via stateDelta) — verifier base. */
  const runWorkspaceDir =
    typeof options.stateDelta?.[RUN_WORKSPACE_STATE_KEY] === 'string'
      ? (options.stateDelta[RUN_WORKSPACE_STATE_KEY] as string)
      : undefined;
  const store = options.eventStore ?? new InMemoryEventStore();
  const runId = options.runId ?? randomUUID();
  const attemptId = randomUUID();
  const tenantId = spec.metadata.tenantId;
  const startedAt = new Date().toISOString();
  const sm = new RunStateMachine('QUEUED');
  const budget = new BudgetManager(spec.spec.budget, Date.now());
  const progress = createProgressSequencer(runId, options.onProgress);

  let finalText: string | undefined;
  let error: string | undefined;
  let verification: VerificationResult | undefined;

  // Structured inputs from the effective RunSpec become ADK session state.
  const inputState = {
    ...spec.spec.task.inputs,
    ...(options.stateDelta ?? {}),
  };

  // Internal abort so budget / harness limits can hard-stop the agent loop.
  // The caller's signal chains onto it.
  const controller = new AbortController();
  if (options.abortSignal?.aborted) controller.abort();
  options.abortSignal?.addEventListener('abort', () => controller.abort(), {
    once: true,
  });

  interface StopReason {
    kind: 'budget' | 'maxSteps';
    detail: string;
  }
  let stopReason: StopReason | undefined;
  const stopRun = (reason: StopReason): void => {
    if (stopReason) return;
    stopReason = reason;
    controller.abort();
  };

  const emit = (
    eventType: Parameters<InMemoryEventStore['append']>[0]['eventType'],
    payload: Record<string, unknown> = {},
    actor?: Parameters<InMemoryEventStore['append']>[0]['actor'],
  ) => {
    const event = store.append({
      eventType,
      runId,
      attemptId,
      tenantId,
      payload,
      actor,
    });
    options.onEvent?.(event);
    return event;
  };

  const changeState = (
    to: Parameters<RunStateMachine['transition']>[0],
    reason?: string,
  ) => {
    const from = sm.state;
    sm.transition(to);
    emit('run.state_changed', { from, to, reason, phase: sm.phase });
    progress.emit('run.state', {
      state: sm.state,
      phase: sm.phase,
      message: reason ?? `State ${from} → ${to}`,
      payload: { from, to, reason },
    });
  };

  // harness.maxSteps: one step = one completed (non-partial) agent event.
  const maxSteps = spec.spec.harness.maxSteps;
  let steps = 0;

  const forwardAgentProgress: AgentProgressSink = (event) => {
    if (event.kind === 'agent.event' && !event.agentEvent?.partial) {
      steps += 1;
      if (steps > maxSteps) {
        stopRun({
          kind: 'maxSteps',
          detail: `harness.maxSteps (${maxSteps}) exceeded`,
        });
      }
    }
    // Nested runAgent also emits started/completed/failed; outer owns those.
    if (
      event.kind === 'run.started' ||
      event.kind === 'run.completed' ||
      event.kind === 'run.failed'
    ) {
      return;
    }
    progress.emit(event.kind, {
      message: event.message,
      author: event.author,
      phase: event.phase,
      state: event.state,
      agentEvent: event.agentEvent,
      payload: event.payload,
    });
  };

  // spec.tools.allow enforcement (fail closed) + budget at the tool gateway.
  const toolPolicy = applyRunSpecToolPolicy({
    agent: options.agent,
    allow: spec.spec.tools.allow,
    hooks: {
      gate: ({ toolName }) => {
        if (stopReason) return `${stopReason.kind}: ${stopReason.detail}`;
        budget.consumeToolCall();
        emit('budget.consumed', {
          tool: toolName,
          toolCalls: budget.snapshot.toolCalls,
        });
        const reason = budget.exhaustionReason();
        if (reason) {
          emit('budget.exhausted', { reason, tool: toolName });
          stopRun({ kind: 'budget', detail: `budget exhausted: ${reason}` });
          return `budget exhausted: ${reason}`;
        }
        return undefined;
      },
      onToolDenied: ({ agentName, toolName, reason }) =>
        emit('policy.denied', { agent: agentName, tool: toolName, reason }),
      onToolStarted: ({ agentName, toolName }) =>
        emit(
          'tool.started',
          { agent: agentName, tool: toolName },
          { type: 'agent', id: agentName },
        ),
      onToolCompleted: ({ agentName, toolName, durationMs }) =>
        emit(
          'tool.completed',
          { agent: agentName, tool: toolName, durationMs },
          { type: 'agent', id: agentName },
        ),
      onToolFailed: ({ agentName, toolName, durationMs, error: toolError }) =>
        emit(
          'tool.failed',
          { agent: agentName, tool: toolName, durationMs, error: toolError },
          { type: 'agent', id: agentName },
        ),
    },
  });

  try {
    if (options.abortSignal?.aborted) {
      throw new Error('Run aborted');
    }

    emit('run.created', {
      taskId: spec.spec.task.taskId,
      objective,
      model: effectiveModel,
    });
    progress.emit('run.started', {
      message: objective,
      payload: {
        taskId: spec.spec.task.taskId,
        model: effectiveModel,
      },
    });
    changeState('PROVISIONING');
    emit('budget.reserved', { budget: spec.spec.budget });
    emit('policy.evaluated', {
      toolsAllow: spec.spec.tools.allow.map((t) => `${t.name}@${t.version}`),
      exposed: toolPolicy.exposed,
      removed: toolPolicy.removed,
    });
    if (toolPolicy.removed.length > 0) {
      emit('policy.denied', {
        removed: toolPolicy.removed,
        reason: RUNSPEC_ALLOWLIST_DENIAL,
        mode: 'denial_stub',
      });
    }
    changeState('RUNNING');
    emit('run.started', {});

    const maxRepairs = spec.spec.harness.maxRepairs;
    let repairs = 0;
    let message = objective;

    for (;;) {
      emit('model.requested', {
        provider: effectiveModel.provider,
        model: effectiveModel.model,
        ...(repairs > 0 ? { repairAttempt: repairs } : {}),
      });

      const agentResult = await runAgent({
        agent: options.agent,
        message,
        appName: `runspec-${spec.spec.task.taskId}`,
        runId,
        model: effectiveModel,
        stateDelta: inputState,
        attachments: options.attachments,
        cwd: options.cwd,
        abortSignal: controller.signal,
        onProgress: forwardAgentProgress,
      });

      if (agentResult.status === 'error') {
        if (stopReason?.kind === 'budget') {
          error = stopReason.detail;
          changeState('BUDGET_EXHAUSTED', error);
        } else if (stopReason?.kind === 'maxSteps') {
          error = stopReason.detail;
          emit('model.failed', { error });
          changeState('FAILED', error);
        } else if (options.abortSignal?.aborted) {
          error = agentResult.error ?? 'Run aborted';
          changeState('CANCELLED', error);
        } else {
          error = agentResult.error ?? 'agent error';
          emit('model.failed', { error });
          changeState('FAILED', error);
        }
        break;
      }

      finalText = agentResult.finalText;
      emit('model.completed', {
        finalTextLength: finalText?.length ?? 0,
        modelsUsed: agentResult.modelsUsed,
      });

      // The runner may end the stream gracefully on abort — check the stop
      // reason even when the agent "finished".
      if (stopReason) {
        error = stopReason.detail;
        if (stopReason.kind === 'budget') {
          changeState('BUDGET_EXHAUSTED', error);
        } else {
          changeState('FAILED', error);
        }
        break;
      }

      if (budget.exhausted) {
        error = `budget exhausted: ${budget.exhaustionReason()}`;
        changeState('BUDGET_EXHAUSTED', error);
        break;
      }

      changeState('VERIFYING');
      const graderVersion = `${evaluation.metadata.id}@${evaluation.metadata.version}`;
      emit(
        'verification.started',
        { graderVersion },
        { type: 'verifier', id: 'independent' },
      );

      verification = await verifyRunSpec(spec, evaluation, {
        cwd: options.cwd,
        // Independent evidence: artifacts on disk + the append-only event log.
        workspaceDir: runWorkspaceDir,
        events: store.list(),
        ...options.verifyContext,
        finalText,
      });
      emit(
        'verification.result',
        { ...verification },
        { type: 'verifier', id: 'independent' },
      );
      progress.emit('verification', {
        message: verification.passed
          ? 'Verification passed'
          : 'Verification failed',
        payload: { ...verification } as Record<string, unknown>,
      });

      if (verification.passed) {
        changeState('SUCCEEDED');
        break;
      }

      // harness.maxRepairs: feed failed checks back for another attempt.
      if (repairs < maxRepairs && !stopReason && !budget.exhausted) {
        repairs += 1;
        changeState(
          'REPAIRING',
          `verification failed — repair ${repairs}/${maxRepairs}`,
        );
        message = buildRepairMessage(objective, finalText, verification);
        changeState('RUNNING', `repair attempt ${repairs}/${maxRepairs}`);
        continue;
      }

      error = 'verification failed';
      changeState('FAILED', error);
      break;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    if (stopReason) error = stopReason.detail;
    if (!sm.terminal) {
      try {
        const cancelled =
          !stopReason &&
          (Boolean(options.abortSignal?.aborted) || /aborted/i.test(error));
        if (
          stopReason?.kind === 'budget' &&
          canTransition(sm.state, 'BUDGET_EXHAUSTED')
        ) {
          changeState('BUDGET_EXHAUSTED', error);
        } else if (cancelled) {
          changeState('CANCELLED', error);
        } else if (sm.state === 'PROVISIONING') {
          changeState('FAILED_INFRA', error);
        } else {
          changeState('FAILED', error);
        }
      } catch {
        // already moved
      }
    }
  } finally {
    toolPolicy.restore();
  }

  if (!sm.terminal) {
    try {
      changeState('FAILED', error ?? 'unknown');
    } catch {
      // ignore
    }
  }

  emit(sm.state === 'SUCCEEDED' ? 'run.completed' : 'run.failed', {
    state: sm.state,
    error,
  });

  if (sm.state === 'SUCCEEDED') {
    progress.emit('run.completed', {
      message: 'finished',
      state: sm.state,
      phase: sm.phase,
      payload: {
        state: sm.state,
        ...(finalText ? { finalTextChars: finalText.length } : {}),
      },
    });
  } else {
    progress.emit('run.failed', {
      message: error ?? sm.state,
      state: sm.state,
      phase: sm.phase,
      payload: { state: sm.state, error },
    });
  }

  const record = runRecordSchema.parse({
    runId,
    attemptId,
    parentRunId: spec.metadata.parentRunId ?? null,
    state: sm.state,
    phase: sm.phase,
    startedAt,
    finishedAt: new Date().toISOString(),
    finalText,
    error,
    budgetConsumed: budget.snapshot,
    verification,
    eventCount: store.list(runId).length,
    specDigests: {
      taskRevision: spec.spec.task.revision,
      modelProvider: effectiveModel.provider,
      modelId: effectiveModel.model,
      graderVersion: `${evaluation.metadata.id}@${evaluation.metadata.version}`,
    },
  });

  return {
    record,
    effectiveSpec: spec,
    effectiveEvaluation: evaluation,
    events: store.list(runId),
    agentFinalText: finalText,
  };
}

export type { AgentProgressEvent };
