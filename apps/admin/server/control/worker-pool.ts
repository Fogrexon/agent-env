/**
 * Job enqueue validation + worker-pool execution bridge.
 */
import {
  type ControlJob,
  type ControlStore,
  type JobTrigger,
  jobPublic,
} from './store.js';
import {
  executeQueuedRun,
  validateRunRequest,
  type EnqueueRunFailure,
} from '../runs.js';
import { adminRunStore } from '../run-store.js';

export interface EnqueueSuccess {
  ok: true;
  jobId: string;
  runId: string;
  agentId: string;
  status: 'pending';
  trigger: JobTrigger;
  job: ReturnType<typeof jobPublic>;
}

export type EnqueueResult = EnqueueSuccess | EnqueueRunFailure;

export function enqueueAgentJob(
  store: ControlStore,
  input: {
    agentId: string;
    values: Record<string, unknown>;
    cwd: string;
    trigger: JobTrigger;
    priority?: number;
    scheduleId?: string;
    webhookTokenId?: string;
  },
): EnqueueResult {
  const validated = validateRunRequest(input.agentId, input.values, input.cwd);
  if (!validated.ok) return validated;

  const job = store.enqueue({
    agentId: input.agentId,
    values: input.values,
    model: null,
    trigger: input.trigger,
    priority: input.priority ?? 0,
    messagePreview: validated.messagePreview,
    scheduleId: input.scheduleId,
    webhookTokenId: input.webhookTokenId,
    runId: validated.runId,
  });

  return {
    ok: true,
    jobId: job.jobId,
    runId: job.runId,
    agentId: job.agentId,
    status: 'pending',
    trigger: job.trigger,
    job: jobPublic(job),
  };
}

export interface WorkerPool {
  maxSlots: number;
  runningCount: () => number;
  kick: () => void;
  stop: () => void;
}

/**
 * Claims pending jobs up to maxSlots and runs them via executeQueuedRun.
 */
export function createWorkerPool(options: {
  store: ControlStore;
  cwd: string;
  maxSlots: number;
  pollMs?: number;
}): WorkerPool {
  const { store, cwd, maxSlots } = options;
  const pollMs = options.pollMs ?? 750;
  const inFlight = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const runningCount = () => inFlight.size;

  const startJob = (job: ControlJob) => {
    if (inFlight.has(job.jobId)) return;
    inFlight.add(job.jobId);
    store.markRunning(job.jobId);

    let values: Record<string, unknown> = {};
    try {
      values = JSON.parse(job.valuesJson) as Record<string, unknown>;
    } catch {
      values = {};
    }

    adminRunStore.create({
      runId: job.runId,
      agentId: job.agentId,
      runMode: 'agent',
      messagePreview: job.messagePreview ?? undefined,
    });

    const live = adminRunStore.get(job.runId);
    void executeQueuedRun({
      runId: job.runId,
      agentId: job.agentId,
      cwd,
      values,
      abortSignal: live!.abortController.signal,
    })
      .then((outcome) => {
        store.markTerminal(
          job.jobId,
          outcome.status === 'cancelled'
            ? 'cancelled'
            : outcome.status === 'failed'
              ? 'failed'
              : 'completed',
          outcome.error,
        );
      })
      .catch((err) => {
        store.markTerminal(
          job.jobId,
          'failed',
          err instanceof Error ? err.message : String(err),
        );
      })
      .finally(() => {
        inFlight.delete(job.jobId);
        kick();
      });
  };

  const kick = () => {
    if (stopped) return;
    const free = maxSlots - inFlight.size;
    if (free <= 0) return;
    const claimed = store.claimNext(free);
    for (const job of claimed) {
      startJob(job);
    }
  };

  timer = setInterval(kick, pollMs);
  // Do not keep the process alive solely for the poller in tests.
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }
  kick();

  return {
    maxSlots,
    runningCount,
    kick,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
