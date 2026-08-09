import {
  appendFoldedProgressEvent,
  clearPartialAgentProgress,
  isPartialAgentProgress,
  type AgentProgressEvent,
  type AgentRunResult,
} from '@agent-env/shared';

export type AdminRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AdminRunResultSummary {
  status: 'finished' | 'error';
  finalText?: string;
  sessionId?: string;
  agentName?: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
  recordState?: string;
  events?: AgentRunResult['events'];
  budgetConsumed?: {
    toolCalls: number;
    tokens: number;
    wallSeconds: number;
    costUsd: number;
  };
}

export interface AdminRunRecord {
  runId: string;
  agentId: string;
  runMode: 'agent';
  status: AdminRunStatus;
  createdAt: string;
  updatedAt: string;
  /** Short preview of the user message for the task list. */
  messagePreview?: string;
  historyDir?: string;
  events: AgentProgressEvent[];
  result?: AdminRunResultSummary;
  error?: string;
  abortController: AbortController;
  listeners: Set<(event: AgentProgressEvent) => void>;
  /**
   * Index of the in-flight streaming row per author, so parallel agents keep
   * one row each instead of interleaving into new rows.
   */
  streamRowByAuthor: Map<string, number>;
}

export interface AdminRunSummary {
  runId: string;
  agentId: string;
  runMode: 'agent';
  status: AdminRunStatus;
  createdAt: string;
  updatedAt: string;
  messagePreview?: string;
  error?: string;
  finalTextPreview?: string;
  /** Absolute path to durable run history directory when persisted. */
  historyDir?: string;
}

export interface CreateAdminRunInput {
  runId: string;
  agentId: string;
  runMode: 'agent';
  messagePreview?: string;
  historyDir?: string;
}

const MAX_COMPLETED_RUNS = 50;
const COMPLETED_TTL_MS = 30 * 60 * 1000;
const PREVIEW_MAX = 120;

export function previewText(text: string, max = PREVIEW_MAX): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return compact;
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

/**
 * In-process run registry for local admin SSE.
 * Not durable across process restarts.
 */
export class AdminRunStore {
  readonly #runs = new Map<string, AdminRunRecord>();

  create(input: CreateAdminRunInput): AdminRunRecord {
    const now = new Date().toISOString();
    const record: AdminRunRecord = {
      runId: input.runId,
      agentId: input.agentId,
      runMode: input.runMode,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      ...(input.messagePreview
        ? { messagePreview: previewText(input.messagePreview) }
        : {}),
      ...(input.historyDir ? { historyDir: input.historyDir } : {}),
      events: [],
      abortController: new AbortController(),
      listeners: new Set(),
      streamRowByAuthor: new Map(),
    };
    this.#runs.set(input.runId, record);
    this.#prune();
    return record;
  }

  get(runId: string): AdminRunRecord | undefined {
    return this.#runs.get(runId);
  }

  list(): AdminRunSummary[] {
    return [...this.#runs.values()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((run) => this.toSummary(run));
  }

  markRunning(runId: string): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    run.status = 'running';
    run.updatedAt = new Date().toISOString();
  }

  append(runId: string, event: AgentProgressEvent): void {
    const run = this.#runs.get(runId);
    if (!run) return;

    const { events, notified } = appendFoldedProgressEvent(
      run.events,
      run.streamRowByAuthor,
      event,
    );
    run.events = events;
    run.updatedAt = event.timestamp;
    if (event.kind === 'run.completed') {
      run.status = 'completed';
      this.#clearPartials(run);
    } else if (event.kind === 'run.failed') {
      run.status = run.abortController.signal.aborted ? 'cancelled' : 'failed';
      this.#clearPartials(run);
    } else if (run.status === 'queued') {
      run.status = 'running';
    }
    this.#notify(run, notified);
  }

  complete(
    runId: string,
    result: AdminRunResultSummary,
    status: AdminRunStatus = result.status === 'finished' ? 'completed' : 'failed',
  ): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    run.status = status;
    run.result = result;
    run.error = result.error;
    run.updatedAt = new Date().toISOString();
    this.#clearPartials(run);
    this.#prune();
  }

  fail(runId: string, error: string): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    run.status = 'failed';
    run.error = error;
    run.updatedAt = new Date().toISOString();
    run.result = {
      status: 'error',
      error,
      startedAt: run.createdAt,
      finishedAt: run.updatedAt,
    };
    this.#clearPartials(run);
    this.#prune();
  }

  cancel(runId: string): boolean {
    const run = this.#runs.get(runId);
    if (!run) return false;
    if (
      run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'cancelled'
    ) {
      return false;
    }
    run.abortController.abort();
    return true;
  }

  /**
   * Drop a finished run from memory. Active (queued/running) runs must be
   * cancelled first — returns false if still in flight.
   */
  remove(runId: string): boolean {
    const run = this.#runs.get(runId);
    if (!run) return false;
    if (run.status === 'queued' || run.status === 'running') {
      return false;
    }
    run.listeners.clear();
    this.#runs.delete(runId);
    return true;
  }

  subscribe(
    runId: string,
    listener: (event: AgentProgressEvent) => void,
    afterSequence = -1,
  ): (() => void) | undefined {
    const run = this.#runs.get(runId);
    if (!run) return undefined;
    for (const event of run.events) {
      if (event.sequence > afterSequence) {
        listener(event);
      }
    }
    run.listeners.add(listener);
    return () => {
      run.listeners.delete(listener);
    };
  }

  toSummary(run: AdminRunRecord): AdminRunSummary {
    return {
      runId: run.runId,
      agentId: run.agentId,
      runMode: run.runMode,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      messagePreview: run.messagePreview,
      error: run.error,
      finalTextPreview: run.result?.finalText
        ? previewText(run.result.finalText)
        : undefined,
      ...(run.historyDir ? { historyDir: run.historyDir } : {}),
    };
  }

  toPublic(run: AdminRunRecord) {
    const stages = deriveStages(run.events, run.result?.recordState);
    return {
      runId: run.runId,
      agentId: run.agentId,
      runMode: run.runMode,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      messagePreview: run.messagePreview,
      events: run.events,
      result: run.result,
      error: run.error,
      stages,
      recordState: run.result?.recordState,
      budgetConsumed: run.result?.budgetConsumed,
      ...(run.historyDir ? { historyDir: run.historyDir } : {}),
    };
  }

  #notify(run: AdminRunRecord, event: AgentProgressEvent): void {
    for (const listener of run.listeners) {
      try {
        listener(event);
      } catch {
        // isolate subscriber errors
      }
    }
  }

  /** Drop sticky partial flags so the UI does not stay on "生成中". */
  #clearPartials(run: AdminRunRecord): void {
    run.streamRowByAuthor.clear();
    for (let i = 0; i < run.events.length; i += 1) {
      const event = run.events[i]!;
      if (!isPartialAgentProgress(event) || !event.agentEvent) continue;
      const cleared = clearPartialAgentProgress(event);
      run.events[i] = cleared;
      this.#notify(run, cleared);
    }
  }

  #prune(): void {
    const now = Date.now();
    const completed: AdminRunRecord[] = [];
    for (const run of this.#runs.values()) {
      if (
        run.status === 'completed' ||
        run.status === 'failed' ||
        run.status === 'cancelled'
      ) {
        const age = now - Date.parse(run.updatedAt);
        if (Number.isFinite(age) && age > COMPLETED_TTL_MS) {
          this.#runs.delete(run.runId);
        } else {
          completed.push(run);
        }
      }
    }
    if (completed.length <= MAX_COMPLETED_RUNS) return;
    completed
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
      .slice(0, completed.length - MAX_COMPLETED_RUNS)
      .forEach((run) => this.#runs.delete(run.runId));
  }
}

/** Project state-machine stages from progress events for Jenkins-like UI. */
export function deriveStages(
  events: AgentProgressEvent[],
  terminalState?: string,
): Array<{ state: string; phase?: string; at: string }> {
  const stages: Array<{ state: string; phase?: string; at: string }> = [];
  for (const event of events) {
    if (event.kind === 'run.state' && event.state) {
      stages.push({
        state: event.state,
        ...(event.phase ? { phase: event.phase } : {}),
        at: event.timestamp,
      });
    }
  }
  if (terminalState && stages.at(-1)?.state !== terminalState) {
    const last = events.at(-1);
    stages.push({
      state: terminalState,
      at: last?.timestamp ?? new Date().toISOString(),
    });
  }
  return stages;
}

export const adminRunStore = new AdminRunStore();
