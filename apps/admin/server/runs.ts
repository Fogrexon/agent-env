/**
 * Admin run execution — validate + execute (worker pool calls execute).
 * Enqueue lives in control/worker-pool.ts.
 */
import { randomUUID } from 'node:crypto';
import { AgentParamsValidationError } from '@agent-env/harness';
import {
  buildRunRequestFromValues,
  getResolvedAgentPackage,
  resolveDiscoveryOptions,
  runDiscoveredAgent,
} from '@agent-env/repo-env';
import {
  isSuccessfulRunState,
  type AgentProgressEvent,
  type AgentProgressSink,
  type RunState,
} from '@agent-env/shared';
import {
  adminRunStore,
  type AdminRunResultSummary,
  type AdminRunStatus,
} from './run-store.js';

export interface EnqueueRunFailure {
  ok: false;
  error: string;
  issues?: string[];
}

export interface ValidateRunSuccess {
  ok: true;
  runId: string;
  agentId: string;
  messagePreview: string;
}

export type ValidateRunResult = ValidateRunSuccess | EnqueueRunFailure;

function isValidationError(err: unknown): err is AgentParamsValidationError {
  return err instanceof AgentParamsValidationError;
}

function isTerminalKind(kind: AgentProgressEvent['kind']): boolean {
  return kind === 'run.completed' || kind === 'run.failed';
}

/**
 * Validate agent + params without starting execution.
 * Allocates a runId for the durable queue row.
 */
export function validateRunRequest(
  agentId: string,
  values: Record<string, unknown>,
  cwd: string = process.cwd(),
): ValidateRunResult {
  const discovery = resolveDiscoveryOptions({ fallbackRoot: cwd });
  const pkg = getResolvedAgentPackage(discovery, agentId);
  if (!pkg) {
    return { ok: false, error: `Unknown agent: ${agentId}` };
  }

  try {
    buildRunRequestFromValues(pkg, values, { cwd });
  } catch (err) {
    if (isValidationError(err)) {
      return { ok: false, error: err.message, issues: err.issues };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const objectivePreview = String(
    values[pkg.params.objectiveField] ??
      pkg.params.fields.find((f) => f.id === pkg.params.objectiveField)
        ?.default ??
      '',
  );

  return {
    ok: true,
    runId: randomUUID(),
    agentId,
    messagePreview: objectivePreview,
  };
}

export interface ExecuteOutcome {
  status: Extract<AdminRunStatus, 'completed' | 'failed' | 'cancelled'>;
  error?: string;
  historyDir?: string;
  recordState?: string;
}

/**
 * Run a claimed queue job. Caller creates the AdminRunStore record first.
 */
export async function executeQueuedRun(input: {
  runId: string;
  agentId: string;
  cwd: string;
  values: Record<string, unknown>;
  abortSignal: AbortSignal;
}): Promise<ExecuteOutcome> {
  const memorySink: AgentProgressSink = (event) => {
    adminRunStore.append(input.runId, event);
  };

  adminRunStore.markRunning(input.runId);
  const startedAt = new Date().toISOString();

  try {
    const fromSpec = await runDiscoveredAgent({
      request: {
        agentId: input.agentId,
        objective: 'pending',
        inputs: {},
        attachments: [],
        metadata: {},
        runId: input.runId,
      },
      values: input.values,
      cwd: input.cwd,
      abortSignal: input.abortSignal,
      onProgress: memorySink,
    });

    const finishedAt = new Date().toISOString();
    const state = fromSpec.record.state as RunState;
    const success = isSuccessfulRunState(state);
    const cancelled = state === 'CANCELLED';
    const summary: AdminRunResultSummary = {
      status: success ? 'finished' : 'error',
      finalText: fromSpec.agentFinalText ?? fromSpec.record.finalText,
      sessionId: fromSpec.record.runId,
      agentName: input.agentId,
      error: fromSpec.record.error,
      startedAt,
      finishedAt,
      recordState: state,
      budgetConsumed: fromSpec.record.budgetConsumed,
    };

    const live = adminRunStore.get(input.runId);
    if (live && fromSpec.historyDir) {
      live.historyDir = fromSpec.historyDir;
    }

    const last = live?.events.at(-1);
    if (!last || !isTerminalKind(last.kind)) {
      memorySink({
        runId: input.runId,
        sequence: (last?.sequence ?? 0) + 1,
        timestamp: finishedAt,
        kind: success ? 'run.completed' : 'run.failed',
        message: success
          ? 'finished'
          : (fromSpec.record.error ?? 'failed'),
        state,
        phase: fromSpec.record.phase,
      });
    }

    const status: ExecuteOutcome['status'] = cancelled
      ? 'cancelled'
      : success
        ? 'completed'
        : 'failed';
    adminRunStore.complete(input.runId, summary, status);
    return {
      status,
      error: fromSpec.record.error,
      historyDir: fromSpec.historyDir,
      recordState: state,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cancelled = input.abortSignal.aborted || /aborted/i.test(message);
    const finishedAt = new Date().toISOString();
    memorySink({
      runId: input.runId,
      sequence:
        (adminRunStore.get(input.runId)?.events.at(-1)?.sequence ?? 0) + 1,
      timestamp: finishedAt,
      kind: 'run.failed',
      message,
    });
    const status: ExecuteOutcome['status'] = cancelled ? 'cancelled' : 'failed';
    adminRunStore.complete(
      input.runId,
      {
        status: 'error',
        error: message,
        startedAt,
        finishedAt,
        sessionId: input.runId,
        agentName: input.agentId,
      },
      status,
    );
    return { status, error: message };
  }
}
