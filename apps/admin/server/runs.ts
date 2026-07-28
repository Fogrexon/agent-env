/**
 * Admin run start — thin wrapper over runDiscoveredAgent.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AgentParamsValidationError } from '@agent-env/harness';
import {
  buildRunRequestFromValues,
  getResolvedAgentPackage,
  runDiscoveredAgent,
} from '@agent-env/repo-env';
import {
  modelRefSchema,
  type AgentProgressEvent,
  type AgentProgressSink,
  type ModelRef,
} from '@agent-env/shared';
import {
  adminRunStore,
  type AdminRunResultSummary,
} from './run-store.js';

export interface StartRunFailure {
  ok: false;
  error: string;
  issues?: string[];
}

export interface StartRunSuccess {
  ok: true;
  runId: string;
  agentId: string;
  runMode: 'runspec';
  status: 'queued' | 'running';
  historyDir?: string;
  autoApprove: boolean;
}

export type StartRunResponse = StartRunSuccess | StartRunFailure;

export interface StartRunOptions {
  autoApprove?: boolean;
}

function isValidationError(err: unknown): err is AgentParamsValidationError {
  return err instanceof AgentParamsValidationError;
}

function isTerminalKind(kind: AgentProgressEvent['kind']): boolean {
  return kind === 'run.completed' || kind === 'run.failed';
}

function parseModelOverride(
  raw: unknown,
): { ok: true; model?: ModelRef } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, model: undefined };
  }
  const parsed = modelRefSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid model override: ${parsed.error.issues
        .map((i) => i.message)
        .join('; ')}`,
    };
  }
  return { ok: true, model: parsed.data };
}

/**
 * Validate params, create a run record, and start execution asynchronously.
 * Returns immediately with runId for SSE subscription.
 *
 * Default tool approval is interactive (T2 waits for admin POST).
 * `autoApprove: true` auto-grants T2 only (T3 still needs agent approve).
 */
export function startAgentRun(
  agentId: string,
  values: Record<string, unknown>,
  cwd: string = process.cwd(),
  modelOverride?: unknown,
  options: StartRunOptions = {},
): StartRunResponse {
  const discovery = { agentsDir: resolve(cwd, 'agents'), repoRoot: cwd };
  const pkg = getResolvedAgentPackage(discovery, agentId);
  if (!pkg) {
    return { ok: false, error: `Unknown agent: ${agentId}` };
  }

  const modelParsed = parseModelOverride(modelOverride);
  if (!modelParsed.ok) {
    return { ok: false, error: modelParsed.error };
  }

  try {
    buildRunRequestFromValues(pkg, values, {
      cwd,
      model: modelParsed.model,
    });
  } catch (err) {
    if (isValidationError(err)) {
      return { ok: false, error: err.message, issues: err.issues };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const autoApprove = options.autoApprove === true;
  const runId = randomUUID();
  const objectivePreview = String(
    values[pkg.params.objectiveField] ?? pkg.params.fields.find(
      (f) => f.id === pkg.params.objectiveField,
    )?.default ??
      '',
  );

  adminRunStore.create({
    runId,
    agentId,
    runMode: 'runspec',
    messagePreview: objectivePreview,
  });

  void executeRun({
    runId,
    agentId,
    cwd,
    values,
    model: modelParsed.model,
    autoApprove,
    abortSignal: adminRunStore.get(runId)!.abortController.signal,
  });

  return {
    ok: true,
    runId,
    agentId,
    runMode: 'runspec',
    status: 'queued',
    autoApprove,
  };
}

async function executeRun(input: {
  runId: string;
  agentId: string;
  cwd: string;
  values: Record<string, unknown>;
  model?: ModelRef;
  autoApprove: boolean;
  abortSignal: AbortSignal;
}): Promise<void> {
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
        ...(input.model ? { model: input.model } : {}),
      },
      values: input.values,
      cwd: input.cwd,
      abortSignal: input.abortSignal,
      onProgress: memorySink,
      toolApproval: input.autoApprove
        ? { mode: 'auto' }
        : {
            mode: 'interactive',
            requestApproval: (req) =>
              adminRunStore.waitForApproval(input.runId, req),
          },
    });

    const finishedAt = new Date().toISOString();
    const failed = fromSpec.record.state !== 'SUCCEEDED';
    const cancelled = fromSpec.record.state === 'CANCELLED';
    const summary: AdminRunResultSummary = {
      status: failed ? 'error' : 'finished',
      finalText: fromSpec.agentFinalText ?? fromSpec.record.finalText,
      sessionId: fromSpec.record.runId,
      agentName: input.agentId,
      error: fromSpec.record.error,
      startedAt,
      finishedAt,
      recordState: fromSpec.record.state,
      verificationPassed: fromSpec.record.verification?.passed,
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
        kind: failed ? 'run.failed' : 'run.completed',
        message: failed ? fromSpec.record.error ?? 'failed' : 'finished',
        state: fromSpec.record.state,
        phase: fromSpec.record.phase,
      });
    }

    adminRunStore.complete(
      input.runId,
      summary,
      cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cancelled = input.abortSignal.aborted || /aborted/i.test(message);
    const finishedAt = new Date().toISOString();
    memorySink({
      runId: input.runId,
      sequence: (adminRunStore.get(input.runId)?.events.at(-1)?.sequence ?? 0) + 1,
      timestamp: finishedAt,
      kind: 'run.failed',
      message,
    });
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
      cancelled ? 'cancelled' : 'failed',
    );
  }
}
