/**
 * Inbound webhook helpers — token resolves to agentId + values and enqueues.
 */
import type { Request, Response } from 'express';
import type { ControlStore } from './store.js';
import { enqueueAgentJob, type WorkerPool } from './worker-pool.js';
import { jobPublic } from './store.js';

export function createWebhookHandler(options: {
  store: ControlStore;
  cwd: string;
  pool: WorkerPool;
}) {
  const { store, cwd, pool } = options;

  return (req: Request, res: Response): void => {
    const tokenParam = req.params['token'];
    const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;
    if (!token) {
      res.status(400).json({ error: 'Missing webhook token' });
      return;
    }
    const hook = store.findWebhookByRawToken(token);
    if (!hook || hook.enabled !== 1) {
      res.status(404).json({ error: 'Unknown or disabled webhook' });
      return;
    }

    let values: Record<string, unknown> = {};
    try {
      values = JSON.parse(hook.valuesJson) as Record<string, unknown>;
    } catch {
      values = {};
    }
    // Optional body override: merge shallow values from POST body.values
    const body = req.body as { values?: Record<string, unknown>; priority?: number } | undefined;
    if (body?.values && typeof body.values === 'object') {
      values = { ...values, ...body.values };
    }

    const result = enqueueAgentJob(store, {
      agentId: hook.agentId,
      values,
      cwd,
      trigger: 'webhook',
      priority: typeof body?.priority === 'number' ? body.priority : 0,
      webhookTokenId: hook.id,
    });

    if (!result.ok) {
      res.status(400).json(result);
      return;
    }

    store.touchWebhook(hook.id);
    pool.kick();
    res.status(202).json({
      ok: true,
      jobId: result.jobId,
      runId: result.runId,
      agentId: result.agentId,
      job: jobPublic(store.getJob(result.jobId)!),
    });
  };
}
