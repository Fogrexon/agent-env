import { randomUUID } from 'node:crypto';
import type { BaseAgent } from '@google/adk';
import {
  runRecordSchema,
  runSpecSchema,
  type RunRecord,
  type RunSpec,
  type VerificationResult,
} from '@agent-env/shared';
import { runAgent } from '../runner.js';
import { BudgetManager } from './budget.js';
import { InMemoryEventStore } from './event-store.js';
import { RunStateMachine } from './state-machine.js';
import { verifyRunSpec, type VerifyContext } from './verifier.js';

export interface RunFromSpecOptions {
  spec: unknown;
  agent: BaseAgent;
  /** User message; defaults to task.objective */
  message?: string;
  eventStore?: InMemoryEventStore;
  verifyContext?: Omit<VerifyContext, 'finalText'>;
  onEvent?: (event: ReturnType<InMemoryEventStore['append']>) => void;
}

export interface RunFromSpecResult {
  record: RunRecord;
  events: ReturnType<InMemoryEventStore['list']>;
  agentFinalText?: string;
}

export function parseRunSpec(raw: unknown): RunSpec {
  return runSpecSchema.parse(raw);
}

/**
 * Phase A orchestrator entry: RunSpec → state machine → agent → independent verifier.
 * Orchestrator does not call shell/business APIs; tools go through ADK / tool gateway.
 */
export async function runFromSpec(
  options: RunFromSpecOptions,
): Promise<RunFromSpecResult> {
  const spec = parseRunSpec(options.spec);
  const store = options.eventStore ?? new InMemoryEventStore();
  const runId = randomUUID();
  const attemptId = randomUUID();
  const tenantId = spec.metadata.tenantId;
  const startedAt = new Date().toISOString();
  const sm = new RunStateMachine('QUEUED');
  const budget = new BudgetManager(spec.spec.budget, Date.now());

  let finalText: string | undefined;
  let error: string | undefined;
  let verification: VerificationResult | undefined;

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
  };

  try {
    emit('run.created', {
      taskId: spec.spec.task.taskId,
      objective: spec.spec.task.objective,
      model: spec.spec.model.primary,
    });
    changeState('PROVISIONING');
    emit('budget.reserved', { budget: spec.spec.budget });
    changeState('RUNNING');
    emit('run.started', {});

    emit('model.requested', {
      provider: spec.spec.model.primary.provider,
      model: spec.spec.model.primary.model,
    });

    const agentResult = await runAgent({
      agent: options.agent,
      message: options.message ?? spec.spec.task.objective,
      appName: `runspec-${spec.spec.task.taskId}`,
    });

    if (agentResult.status === 'error') {
      error = agentResult.error ?? 'agent error';
      emit('model.failed', { error });
      changeState('FAILED', error);
    } else {
      finalText = agentResult.finalText;
      emit('model.completed', {
        finalTextLength: finalText?.length ?? 0,
        modelsUsed: agentResult.modelsUsed,
      });

      if (budget.exhausted) {
        changeState('BUDGET_EXHAUSTED', budget.exhaustionReason());
        error = budget.exhaustionReason();
      } else {
        changeState('VERIFYING');
        emit(
          'verification.started',
          { graderVersion: spec.spec.evaluation.graderVersion },
          { type: 'verifier', id: 'independent' },
        );

        verification = await verifyRunSpec(spec, {
          finalText,
          ...options.verifyContext,
        });
        emit(
          'verification.result',
          { ...verification },
          { type: 'verifier', id: 'independent' },
        );

        if (verification.passed) {
          changeState('SUCCEEDED');
        } else {
          error = 'verification failed';
          changeState('FAILED', error);
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    if (!sm.terminal) {
      try {
        changeState('FAILED_INFRA', error);
      } catch {
        // already moved
      }
    }
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
      modelProvider: spec.spec.model.primary.provider,
      modelId: spec.spec.model.primary.model,
      graderVersion: spec.spec.evaluation.graderVersion,
    },
  });

  return {
    record,
    events: store.list(runId),
    agentFinalText: finalText,
  };
}
