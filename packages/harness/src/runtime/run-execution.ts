import { randomUUID } from 'node:crypto';
import type { BaseAgent } from '@google/adk';
import {
  agentRunIntentSchema,
  createProgressSequencer,
  formatModelRef,
  runRecordSchema,
  type AgentAttachment,
  type AgentExecutionLimits,
  type AgentProgressEvent,
  type AgentProgressSink,
  type AgentRunIntent,
  type RunRecord,
  type VerificationPlan,
  type VerificationResult,
} from '@agent-env/shared';
import { runAgent } from '../runner.js';
import {
  executeVerificationPlan,
  type ExecuteVerificationContext,
} from '../verification/execute.js';
import { BudgetManager } from './budget.js';
import { InMemoryEventStore } from './event-store.js';
import { RUN_WORKSPACE_STATE_KEY } from './run-history.js';
import { canTransition, RunStateMachine } from './state-machine.js';
import {
  runWithToolApproval,
  type ToolApprovalPolicy,
} from './tool-approval.js';
import { applyToolRuntimePolicy } from './tool-runtime-policy.js';

/**
 * Host-side execution policy. Limits are hard caps; verification is appended
 * after the agent plan (required host checks cannot be removed by the agent).
 */
export interface HostExecutionPolicy {
  limits: AgentExecutionLimits;
  verification?: VerificationPlan;
}

export interface ExecuteAgentRunOptions {
  agent: BaseAgent;
  agentId: string;
  objective: string;
  inputs?: Record<string, unknown>;
  limits: AgentExecutionLimits;
  /** Already-merged agent + host verification plan. */
  verification: VerificationPlan;
  stateDelta?: Record<string, unknown>;
  attachments?: readonly AgentAttachment[];
  cwd?: string;
  runId?: string;
  abortSignal?: AbortSignal;
  toolApproval?: ToolApprovalPolicy;
  onProgress?: AgentProgressSink;
  eventStore?: InMemoryEventStore;
  onEvent?: (event: ReturnType<InMemoryEventStore['append']>) => void;
  tenantId?: string;
  verifyContext?: Omit<
    ExecuteVerificationContext,
    'finalText' | 'workspaceDir' | 'events'
  >;
}

export interface ExecuteAgentRunResult {
  record: RunRecord;
  intent: AgentRunIntent;
  events: ReturnType<InMemoryEventStore['list']>;
  agentFinalText?: string;
  effectiveVerification: VerificationPlan;
}

/** Feedback turn for the REPAIRING loop (limits.maxRepairs). */
function buildRepairMessage(
  objective: string,
  previous: string | undefined,
  verification: VerificationResult,
): string {
  const failed = verification.checks
    .filter((check) => check.severity === 'required' && !check.passed)
    .map(
      (check) =>
        `- ${check.id}${check.detail ? ` (${check.detail})` : ''}`,
    )
    .join('\n');
  const parts = [
    'Your previous answer failed independent verification. Produce a corrected final answer.',
    '',
    `Original objective: ${objective}`,
    '',
    'Failed required checks:',
    failed || '- (none reported)',
  ];
  if (previous) {
    parts.push('', 'Previous answer:', previous);
  }
  return parts.join('\n');
}

function terminalFromVerification(
  verification: VerificationResult,
): 'SUCCEEDED' | 'COMPLETED' | 'FAILED' {
  if (verification.outcome === 'passed') return 'SUCCEEDED';
  if (verification.outcome === 'not-gated') return 'COMPLETED';
  return 'FAILED';
}

/**
 * Orchestrator entry: limits + verification plan → state machine → agent → verifier.
 * Does not override the agent tree's models; tools go through the runtime gateway.
 */
export async function executeAgentRun(
  options: ExecuteAgentRunOptions,
): Promise<ExecuteAgentRunResult> {
  const objective = options.objective;
  const limits = options.limits;
  const verificationPlan = options.verification;
  const runWorkspaceDir =
    typeof options.stateDelta?.[RUN_WORKSPACE_STATE_KEY] === 'string'
      ? (options.stateDelta[RUN_WORKSPACE_STATE_KEY] as string)
      : undefined;
  const store = options.eventStore ?? new InMemoryEventStore();
  const runId = options.runId ?? randomUUID();
  const attemptId = randomUUID();
  const tenantId = options.tenantId ?? 'local';
  const startedAt = new Date().toISOString();
  const sm = new RunStateMachine('QUEUED');
  const budget = BudgetManager.fromLimits(limits);
  const progress = createProgressSequencer(runId, options.onProgress);

  const intent = agentRunIntentSchema.parse({
    agentId: options.agentId,
    objective,
    inputs: options.inputs ?? {},
    attachmentPaths: (options.attachments ?? []).map((a) => a.path),
    limits,
    verificationPlanId: 'verification',
  });

  let finalText: string | undefined;
  let error: string | undefined;
  let verification: VerificationResult | undefined;
  const modelsUsed = new Set<string>();

  const inputState = {
    ...(options.inputs ?? {}),
    ...(options.stateDelta ?? {}),
  };

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

  const maxSteps = limits.maxSteps;
  let steps = 0;

  const forwardAgentProgress: AgentProgressSink = (event) => {
    if (event.kind === 'agent.event' && !event.agentEvent?.partial) {
      steps += 1;
      if (steps > maxSteps) {
        stopRun({
          kind: 'maxSteps',
          detail: `limits.maxSteps (${maxSteps}) exceeded`,
        });
      }
    }
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
      parentAuthor: event.parentAuthor,
      phase: event.phase,
      state: event.state,
      agentEvent: event.agentEvent,
      payload: event.payload,
    });
  };

  const toolPolicy = applyToolRuntimePolicy({
    agent: options.agent,
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
      agentId: options.agentId,
      objective,
    });
    progress.emit('run.started', {
      message: objective,
      payload: { agentId: options.agentId },
    });
    changeState('PROVISIONING');
    emit('budget.reserved', { limits });
    emit('policy.evaluated', {
      exposed: toolPolicy.exposed,
    });
    changeState('RUNNING');
    emit('run.started', {});

    const maxRepairs = limits.maxRepairs;
    let repairs = 0;
    let message = objective;

    const baseApproval: ToolApprovalPolicy = options.toolApproval ?? {
      mode: 'deny',
    };
    const approvalPolicy: ToolApprovalPolicy = {
      ...baseApproval,
      onWaitingChange: (waiting, request) => {
        baseApproval.onWaitingChange?.(waiting, request);
        if (waiting) {
          if (canTransition(sm.state, 'WAITING_APPROVAL')) {
            changeState(
              'WAITING_APPROVAL',
              request
                ? `approval required: ${request.contract.name}`
                : 'approval required',
            );
          }
        } else if (sm.state === 'WAITING_APPROVAL') {
          if (canTransition(sm.state, 'RUNNING')) {
            changeState('RUNNING', 'approval resolved');
          }
        }
      },
    };

    await runWithToolApproval(approvalPolicy, async () => {
      for (;;) {
        emit('model.requested', {
          ...(repairs > 0 ? { repairAttempt: repairs } : {}),
        });

        const agentResult = await runAgent({
          agent: options.agent,
          message,
          appName: `agent-${options.agentId}`,
          runId,
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
        for (const model of agentResult.modelsUsed ?? []) {
          modelsUsed.add(formatModelRef(model));
        }
        emit('model.completed', {
          finalTextLength: finalText?.length ?? 0,
          modelsUsed: [...modelsUsed],
        });

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
        emit(
          'verification.started',
          { planId: 'verification', checkCount: verificationPlan.checks.length },
          { type: 'verifier', id: 'independent' },
        );

        verification = await executeVerificationPlan(verificationPlan, {
          cwd: options.cwd,
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
          message:
            verification.outcome === 'passed'
              ? 'Verification passed'
              : verification.outcome === 'not-gated'
                ? 'Verification not gated'
                : 'Verification failed',
          payload: { ...verification } as Record<string, unknown>,
        });

        if (verification.outcome === 'passed') {
          changeState('SUCCEEDED');
          break;
        }
        if (verification.outcome === 'not-gated') {
          changeState('COMPLETED');
          break;
        }

        // Required failures only: feed failed checks back for another attempt.
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
    });
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

  const successful =
    sm.state === 'SUCCEEDED' || sm.state === 'COMPLETED';
  emit(successful ? 'run.completed' : 'run.failed', {
    state: sm.state,
    error,
  });

  if (successful) {
    progress.emit('run.completed', {
      message: 'finished',
      state: sm.state,
      phase: sm.phase,
      payload: {
        state: sm.state,
        ...(finalText ? { finalTextChars: finalText.length } : {}),
        ...(verification ? { verificationOutcome: verification.outcome } : {}),
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
    parentRunId: null,
    state: sm.state,
    phase: sm.phase,
    startedAt,
    finishedAt: new Date().toISOString(),
    finalText,
    error,
    budgetConsumed: budget.snapshot,
    verification,
    eventCount: store.list(runId).length,
    modelsUsed: [...modelsUsed],
  });

  return {
    record,
    intent,
    events: store.list(runId),
    agentFinalText: finalText,
    effectiveVerification: verificationPlan,
  };
}

export type { AgentProgressEvent };

/** Re-export for callers that branch on verification terminal mapping. */
export { terminalFromVerification };
