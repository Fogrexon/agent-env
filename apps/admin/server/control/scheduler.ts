/**
 * Cron schedule ticker — enqueues due schedules into the control queue.
 */
import { Cron } from 'croner';
import type { ControlStore } from './store.js';
import { enqueueAgentJob } from './worker-pool.js';
import type { WorkerPool } from './worker-pool.js';

export function computeNextRunAt(cronExpr: string, from = new Date()): string | null {
  try {
    const job = new Cron(cronExpr, { paused: true });
    const next = job.nextRun(from);
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

export function validateCron(cronExpr: string): { ok: true } | { ok: false; error: string } {
  try {
    // eslint-disable-next-line no-new
    new Cron(cronExpr, { paused: true });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface SchedulerHandle {
  stop: () => void;
  tick: () => number;
}

export function startScheduler(options: {
  store: ControlStore;
  cwd: string;
  pool: WorkerPool;
  intervalMs?: number;
}): SchedulerHandle {
  const { store, cwd, pool } = options;
  const intervalMs = options.intervalMs ?? 60_000;
  let stopped = false;

  const tick = (): number => {
    if (stopped) return 0;
    const now = new Date();
    const due = store.dueSchedules(now.toISOString());
    let enqueued = 0;
    for (const schedule of due) {
      let values: Record<string, unknown> = {};
      try {
        values = JSON.parse(schedule.valuesJson) as Record<string, unknown>;
      } catch {
        values = {};
      }
      const result = enqueueAgentJob(store, {
        agentId: schedule.agentId,
        values,
        cwd,
        autoApprove: schedule.autoApprove === 1,
        trigger: 'schedule',
        scheduleId: schedule.id,
      });
      const nextRunAt = computeNextRunAt(schedule.cron, new Date(now.getTime() + 1000));
      if (result.ok) {
        store.updateSchedule(schedule.id, {
          lastJobId: result.jobId,
          nextRunAt,
        });
        enqueued += 1;
        pool.kick();
      } else {
        store.audit('schedule.enqueue_failed', {
          scheduleId: schedule.id,
          error: result.error,
        });
        // Still advance nextRunAt to avoid tight failure loops.
        store.updateSchedule(schedule.id, { nextRunAt });
      }
    }
    return enqueued;
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }
  // Initial tick shortly after boot.
  setTimeout(tick, 2000).unref?.();

  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
