/**
 * Admin control-plane bootstrap (queue / slots / auth / schedules / webhooks).
 */
export {
  createControlStore,
  jobPublic,
  jobPublicWithValues,
  parseJobValues,
  type ChatSession,
  type ChatSessionSummary,
  type ChatSessionTurn,
  type ControlJob,
  type ControlStore,
  type ControlSchedule,
  type JobStatus,
  type JobTrigger,
} from './store.js';
export {
  createBasicAuthMiddleware,
  readBasicAuthConfig,
  type BasicAuthConfig,
} from './auth.js';
export {
  createWorkerPool,
  enqueueAgentJob,
  type EnqueueResult,
  type WorkerPool,
} from './worker-pool.js';
export {
  computeNextRunAt,
  startScheduler,
  validateCron,
  type SchedulerHandle,
} from './scheduler.js';
export { createWebhookHandler } from './webhooks.js';

export function readMaxSlots(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['ADMIN_MAX_SLOTS'];
  if (!raw) return 2;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 2;
  return Math.floor(n);
}
