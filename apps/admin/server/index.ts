/**
 * Local admin API — Control Plane (queue / slots / schedules / webhooks / auth)
 * + agent discovery + SSE runs. Providers via @agent-env/repo-env.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import {
  applyAgentParams,
  defaultValuesFromParams,
  describeAgentGraph,
  loadAgentParamsFile,
  type RunHistoryListItem,
  type RunHistoryStatus,
} from '@agent-env/harness';
import { listProviderMedia } from '@agent-env/llm';
import {
  bootstrapProvidersFromEnv,
  discoverAgents,
  getResolvedAgentPackage,
  loadAgentDefinition,
  loadDotEnv,
  resolveAgentPackages,
  resolveDiscoveryOptions,
  resolveHostPaths,
  resolvePackageAgentMode,
} from '@agent-env/repo-env';
import type { AgentProgressEvent } from '@agent-env/shared';
import {
  computeNextRunAt,
  createBasicAuthMiddleware,
  createControlStore,
  createWebhookHandler,
  createWorkerPool,
  enqueueAgentJob,
  jobPublic,
  readBasicAuthConfig,
  readMaxSlots,
  startScheduler,
  validateCron,
} from './control/index.js';
import {
  createRunFileServeHandler,
  createRunFilesListHandler,
} from './files.js';
import { getAdminRunHistory } from './run-history.js';
import {
  adminRunStore,
  deriveStages,
  type AdminRunSummary,
} from './run-store.js';
import { createUploadHandler, createUploadPreviewHandler } from './uploads.js';

function readOptionalJson(dir: string, name: string): unknown | undefined {
  const path = join(dir, name);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function historyExtras(dir: string | undefined): Record<string, unknown> {
  if (!dir) return {};
  const effectiveGraph = readOptionalJson(dir, 'effective-graph.json');
  const observedGraph = readOptionalJson(dir, 'observed-graph.json');
  const intent = readOptionalJson(dir, 'intent.json');
  return {
    ...(effectiveGraph !== undefined ? { effectiveGraph } : {}),
    ...(observedGraph !== undefined ? { observedGraph } : {}),
    ...(intent !== undefined ? { intent } : {}),
  };
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));
/** Platform repo root when AGENT_ENV_ROOT is unset (apps/admin/server → ../../..). */
const platformRoot = resolve(__dirname, '../../..');
const host = resolveHostPaths({ fallbackRoot: platformRoot });
const repoRoot = host.root;
const discovery = resolveDiscoveryOptions({ fallbackRoot: platformRoot });

function mapHistoryStatus(
  status: RunHistoryStatus,
): AdminRunSummary['status'] {
  return status;
}

function diskItemToSummary(item: RunHistoryListItem): AdminRunSummary {
  return {
    runId: item.runId,
    agentId: item.agentId,
    runMode: item.runMode,
    status: mapHistoryStatus(item.status),
    createdAt: item.startedAt,
    updatedAt: item.finishedAt ?? item.startedAt,
    messagePreview: item.message,
    error: item.error,
    finalTextPreview: item.finalTextPreview,
    historyDir: item.dir,
  };
}

loadDotEnv(resolve(repoRoot, '.env'));
bootstrapProvidersFromEnv();

const authConfig = readBasicAuthConfig();
const maxSlots = readMaxSlots();
const controlStore = createControlStore(repoRoot);
const orphaned = controlStore.reconcileOrphans();
if (orphaned > 0) {
  console.log(`  reconciled ${orphaned} orphaned in-flight job(s)`);
}

const workerPool = createWorkerPool({
  store: controlStore,
  cwd: repoRoot,
  maxSlots,
});
const scheduler = startScheduler({
  store: controlStore,
  cwd: repoRoot,
  pool: workerPool,
});

const app = express();
const port = Number(process.env['ADMIN_API_PORT'] ?? 8787);

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(createBasicAuthMiddleware(authConfig));

app.post('/api/uploads', createUploadHandler(repoRoot));
app.get('/api/uploads/preview', createUploadPreviewHandler(repoRoot));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    cwd: repoRoot,
    control: {
      maxSlots,
      running: workerPool.runningCount(),
      queueDepth: controlStore.queueDepth(),
      authEnabled: authConfig.enabled,
      dbPath: controlStore.dbPath,
    },
  });
});

app.get('/api/control/settings', (_req, res) => {
  res.json({
    maxSlots,
    running: workerPool.runningCount(),
    queueDepth: controlStore.queueDepth(),
    authEnabled: authConfig.enabled,
    dbPath: controlStore.dbPath,
  });
});

app.get('/api/control/stats', (_req, res) => {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  res.json({
    maxSlots,
    running: workerPool.runningCount(),
    queueDepth: controlStore.queueDepth(),
    pending: controlStore.countByStatus('pending'),
    claimed: controlStore.countByStatus('claimed'),
    runningJobs: controlStore.countByStatus('running'),
    triggers24h: controlStore.countByTrigger(dayAgo),
    failureRate: controlStore.recentFailureRate(50),
  });
});

app.get('/api/control/audit', (req, res) => {
  const limitRaw = req.query['limit'];
  const limit =
    typeof limitRaw === 'string' && limitRaw.trim() !== ''
      ? Number(limitRaw)
      : 100;
  res.json({
    entries: controlStore.listAudit(
      Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 100,
    ),
  });
});

/** Registered providers with the media each one actually forwards to the model. */
app.get('/api/providers', (_req, res) => {
  try {
    res.json({ providers: listProviderMedia() });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get('/api/agents', async (_req, res) => {
  try {
    const packages = resolveAgentPackages(discovery);
    const agents = await Promise.all(
      packages.map(async (pkg) => {
        let title: string | undefined;
        let fieldCount = 0;
        if (pkg.paramsFile) {
          try {
            const params = loadAgentParamsFile(pkg.paramsFile, repoRoot);
            title = params.title;
            fieldCount = params.fields.length;
          } catch {
            // list still works without params detail
          }
        }
        let mode: 'interactive' | 'autonomous' = 'autonomous';
        try {
          mode = await resolvePackageAgentMode(pkg, repoRoot);
        } catch {
          // definition load failure → autonomous default
        }
        return {
          id: pkg.id,
          name: pkg.manifest.name,
          description: pkg.manifest.description,
          entry: pkg.entry,
          paramsFile: pkg.paramsFile,
          models: pkg.manifest.models,
          title,
          mode,
          fieldCount,
        };
      }),
    );
    res.json({ agents });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get('/api/agents/:id/params', (req, res) => {
  const id = req.params.id;
  const pkg = getResolvedAgentPackage(discovery, id);
  if (!pkg) {
    res.status(404).json({ error: `Unknown agent: ${id}` });
    return;
  }
  try {
    res.json({
      manifest: pkg.manifest,
      spec: pkg.params,
      defaults: defaultValuesFromParams(pkg.params),
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Preview the ADK agent graph for current form values (no run). */
app.post('/api/agents/:id/graph', async (req, res) => {
  const id = req.params.id;
  const pkg = getResolvedAgentPackage(discovery, id);
  if (!pkg) {
    res.status(404).json({ error: `Unknown agent: ${id}` });
    return;
  }
  try {
    const body = req.body as { values?: Record<string, unknown> };
    const values = body.values ?? {};
    const applied = applyAgentParams(pkg.params, values, { cwd: repoRoot });
    const definition = await loadAgentDefinition(pkg.entry, repoRoot);
    const agent = await definition.createAgent({
      repoRoot,
      config: (name) => process.env[name]?.trim() || undefined,
      secret: (name) => process.env[name]?.trim() || undefined,
      inputs: applied.inputs,
      async buildSubagent(subId, subOptions) {
        const subPkg = getResolvedAgentPackage(discovery, subId);
        if (!subPkg) throw new Error(`Unknown subagent: ${subId}`);
        const subDef = await loadAgentDefinition(subPkg.entry, repoRoot);
        return subDef.createAgent({
          repoRoot,
          config: (name) => process.env[name]?.trim() || undefined,
          secret: (name) => process.env[name]?.trim() || undefined,
          inputs: subOptions?.inputs ?? applied.inputs,
        });
      },
    });
    const graph = describeAgentGraph(agent, { agentId: id });
    res.json({ graph });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Enqueue a run — worker pool starts when a slot is free. */
app.post('/api/agents/:id/runs', (req, res) => {
  const id = req.params.id;
  const body = req.body as {
    values?: Record<string, unknown>;
    autoApprove?: boolean;
    priority?: number;
  };
  const values = body.values ?? {};
  const outcome = enqueueAgentJob(controlStore, {
    agentId: id,
    values,
    cwd: repoRoot,
    autoApprove: body.autoApprove === true,
    trigger: 'manual',
    priority: typeof body.priority === 'number' ? body.priority : 0,
  });
  if (!outcome.ok) {
    res.status(400).json(outcome);
    return;
  }
  workerPool.kick();
  res.status(202).json({
    ok: true,
    jobId: outcome.jobId,
    runId: outcome.runId,
    agentId: outcome.agentId,
    runMode: 'agent',
    status: outcome.status,
    trigger: outcome.trigger,
    autoApprove: outcome.autoApprove,
    job: outcome.job,
  });
});

/** Backward-compatible sync alias. */
app.post('/api/agents/:id/run', (_req, res) => {
  res.status(409).json({
    ok: false,
    error:
      'Synchronous /run is removed. Use POST /api/agents/:id/runs then GET /api/runs/:runId/events (SSE).',
  });
});

app.get('/api/queue', (req, res) => {
  const statusRaw = req.query['status'];
  const status =
    typeof statusRaw === 'string' && statusRaw.trim() !== ''
      ? (statusRaw.split(',').map((s) => s.trim()) as Array<
          'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled'
        >)
      : (['pending', 'claimed', 'running'] as const);
  const jobs = controlStore
    .listJobs({ status: [...status], limit: 200 })
    .map(jobPublic);
  res.json({
    jobs,
    maxSlots,
    running: workerPool.runningCount(),
    queueDepth: controlStore.queueDepth(),
  });
});

app.get('/api/queue/stats', (_req, res) => {
  res.json({
    maxSlots,
    running: workerPool.runningCount(),
    queueDepth: controlStore.queueDepth(),
    pending: controlStore.countByStatus('pending'),
    claimed: controlStore.countByStatus('claimed'),
    runningJobs: controlStore.countByStatus('running'),
  });
});

app.post('/api/queue/:jobId/cancel', (req, res) => {
  const jobId = req.params.jobId;
  const job = controlStore.getJob(jobId);
  if (!job) {
    res.status(404).json({ ok: false, error: `Unknown job: ${jobId}` });
    return;
  }
  if (job.status === 'pending' || job.status === 'claimed') {
    controlStore.cancelJob(jobId);
    res.json({
      ok: true,
      jobId,
      status: 'cancelled',
      job: jobPublic(controlStore.getJob(jobId)!),
    });
    return;
  }
  if (job.status === 'running') {
    const cancelled = adminRunStore.cancel(job.runId);
    res.json({
      ok: cancelled,
      jobId,
      runId: job.runId,
      status: adminRunStore.get(job.runId)?.status ?? job.status,
    });
    return;
  }
  res.status(409).json({
    ok: false,
    error: `Job is already terminal: ${job.status}`,
    jobId,
    status: job.status,
  });
});

/* ── Schedules ─────────────────────────────────────────────── */

app.get('/api/schedules', (_req, res) => {
  res.json({
    schedules: controlStore.listSchedules().map((s) => ({
      ...s,
      autoApprove: s.autoApprove === 1,
      enabled: s.enabled === 1,
      values: JSON.parse(s.valuesJson) as Record<string, unknown>,
      // Legacy model_json ignored for new UI; keep read for old rows.
    })),
  });
});

app.post('/api/schedules', (req, res) => {
  const body = req.body as {
    agentId?: string;
    cron?: string;
    values?: Record<string, unknown>;
    autoApprove?: boolean;
    enabled?: boolean;
  };
  if (!body.agentId || !body.cron) {
    res.status(400).json({ error: 'agentId and cron are required' });
    return;
  }
  if (!getResolvedAgentPackage(discovery, body.agentId)) {
    res.status(404).json({ error: `Unknown agent: ${body.agentId}` });
    return;
  }
  const cronOk = validateCron(body.cron);
  if (!cronOk.ok) {
    res.status(400).json({ error: `Invalid cron: ${cronOk.error}` });
    return;
  }
  const nextRunAt = computeNextRunAt(body.cron);
  const schedule = controlStore.createSchedule({
    agentId: body.agentId,
    cron: body.cron,
    values: body.values ?? {},
    model: null,
    autoApprove: body.autoApprove === true,
    enabled: body.enabled !== false,
    nextRunAt,
  });
  res.status(201).json({
    schedule: {
      ...schedule,
      autoApprove: schedule.autoApprove === 1,
      enabled: schedule.enabled === 1,
      values: JSON.parse(schedule.valuesJson) as Record<string, unknown>,
    },
  });
});

app.patch('/api/schedules/:id', (req, res) => {
  const body = req.body as {
    cron?: string;
    values?: Record<string, unknown>;
    autoApprove?: boolean;
    enabled?: boolean;
  };
  if (body.cron) {
    const cronOk = validateCron(body.cron);
    if (!cronOk.ok) {
      res.status(400).json({ error: `Invalid cron: ${cronOk.error}` });
      return;
    }
  }
  const patch: Parameters<typeof controlStore.updateSchedule>[1] = {
    ...body,
  };
  if (body.cron) {
    patch.nextRunAt = computeNextRunAt(body.cron);
  }
  const updated = controlStore.updateSchedule(req.params.id, patch);
  if (!updated) {
    res.status(404).json({ error: `Unknown schedule: ${req.params.id}` });
    return;
  }
  res.json({
    schedule: {
      ...updated,
      autoApprove: updated.autoApprove === 1,
      enabled: updated.enabled === 1,
      values: JSON.parse(updated.valuesJson) as Record<string, unknown>,
    },
  });
});

app.delete('/api/schedules/:id', (req, res) => {
  const ok = controlStore.deleteSchedule(req.params.id);
  if (!ok) {
    res.status(404).json({ error: `Unknown schedule: ${req.params.id}` });
    return;
  }
  res.json({ ok: true, id: req.params.id });
});

/* ── Webhooks ──────────────────────────────────────────────── */

app.get('/api/hooks/tokens', (_req, res) => {
  res.json({
    tokens: controlStore.listWebhookTokens().map((t) => ({
      ...t,
      autoApprove: t.autoApprove === 1,
      enabled: t.enabled === 1,
      values: JSON.parse(t.valuesJson) as Record<string, unknown>,
    })),
  });
});

app.post('/api/hooks/tokens', (req, res) => {
  const body = req.body as {
    name?: string;
    agentId?: string;
    values?: Record<string, unknown>;
    autoApprove?: boolean;
  };
  if (!body.name || !body.agentId) {
    res.status(400).json({ error: 'name and agentId are required' });
    return;
  }
  if (!getResolvedAgentPackage(discovery, body.agentId)) {
    res.status(404).json({ error: `Unknown agent: ${body.agentId}` });
    return;
  }
  const created = controlStore.createWebhookToken({
    name: body.name,
    agentId: body.agentId,
    values: body.values ?? {},
    model: null,
    autoApprove: body.autoApprove === true,
  });
  const { tokenHash: _h, ...safe } = created.token;
  res.status(201).json({
    token: {
      ...safe,
      autoApprove: safe.autoApprove === 1,
      enabled: safe.enabled === 1,
      values: JSON.parse(safe.valuesJson) as Record<string, unknown>,
    },
    /** Shown once — store securely; only hash is persisted. */
    rawToken: created.rawToken,
    hookPath: `/api/hooks/${created.rawToken}`,
  });
});

app.patch('/api/hooks/tokens/:id', (req, res) => {
  const body = req.body as { enabled?: boolean };
  if (typeof body.enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled boolean required' });
    return;
  }
  const ok = controlStore.setWebhookEnabled(req.params.id, body.enabled);
  if (!ok) {
    res.status(404).json({ error: `Unknown token: ${req.params.id}` });
    return;
  }
  res.json({ ok: true, id: req.params.id, enabled: body.enabled });
});

app.delete('/api/hooks/tokens/:id', (req, res) => {
  const ok = controlStore.deleteWebhookToken(req.params.id);
  if (!ok) {
    res.status(404).json({ error: `Unknown token: ${req.params.id}` });
    return;
  }
  res.json({ ok: true, id: req.params.id });
});

app.post(
  '/api/hooks/:token',
  createWebhookHandler({
    store: controlStore,
    cwd: repoRoot,
    pool: workerPool,
  }),
);

/* ── Runs ──────────────────────────────────────────────────── */

app.get('/api/runs', (_req, res) => {
  try {
    const memory = adminRunStore.list();
    const memoryIds = new Set(memory.map((r) => r.runId));
    const history = getAdminRunHistory(repoRoot);
    const fromDisk: AdminRunSummary[] = history
      .listRuns()
      .filter((item) => !memoryIds.has(item.runId))
      .map((item) => diskItemToSummary(item));

    const jobsByRun = new Map(
      controlStore.listJobs({ limit: 500 }).map((j) => [j.runId, j] as const),
    );

    const enrich = (run: AdminRunSummary) => {
      const job = jobsByRun.get(run.runId);
      return {
        ...run,
        ...(job
          ? {
              jobId: job.jobId,
              trigger: job.trigger,
              jobStatus: job.status,
            }
          : {}),
      };
    };

    // Pending queue jobs not yet in memory live store
    const pendingOnly = controlStore
      .listJobs({ status: ['pending', 'claimed'], limit: 200 })
      .filter((j) => !memoryIds.has(j.runId))
      .map((j) => ({
        runId: j.runId,
        agentId: j.agentId,
        runMode: 'agent' as const,
        status: 'queued' as const,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        messagePreview: j.messagePreview ?? undefined,
        jobId: j.jobId,
        trigger: j.trigger,
        jobStatus: j.status,
      }));

    const runs = [...memory.map(enrich), ...pendingOnly, ...fromDisk.map(enrich)].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    res.json({ runs });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get('/api/runs/:runId', (req, res) => {
  const run = adminRunStore.get(req.params.runId);
  const job = controlStore.getJobByRunId(req.params.runId);
  if (run) {
    res.json({
      ...adminRunStore.toPublic(run),
      ...historyExtras(run.historyDir),
      ...(job
        ? { jobId: job.jobId, trigger: job.trigger, jobStatus: job.status }
        : {}),
    });
    return;
  }

  // Pending job not started yet
  if (job && (job.status === 'pending' || job.status === 'claimed')) {
    res.json({
      runId: job.runId,
      agentId: job.agentId,
      runMode: 'agent',
      status: 'queued',
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      messagePreview: job.messagePreview,
      events: [],
      jobId: job.jobId,
      trigger: job.trigger,
      jobStatus: job.status,
      stages: [],
      pendingApprovals: [],
    });
    return;
  }

  const disk = getAdminRunHistory(repoRoot).readRun(req.params.runId);
  if (!disk) {
    res.status(404).json({ error: `Unknown run: ${req.params.runId}` });
    return;
  }
  const recordState =
    disk.result && typeof disk.result === 'object'
      ? (disk.result as { state?: string; record?: { state?: string } }).state ??
        (disk.result as { record?: { state?: string } }).record?.state
      : undefined;
  res.json({
    runId: disk.meta.runId,
    agentId: disk.meta.agentId,
    runMode: disk.meta.runMode,
    status: mapHistoryStatus(disk.meta.status),
    createdAt: disk.meta.startedAt,
    updatedAt: disk.meta.finishedAt ?? disk.meta.startedAt,
    messagePreview: disk.meta.message,
    events: disk.events,
    result: disk.result
      ? {
          status: disk.meta.status === 'completed' ? 'finished' : 'error',
          finalText: disk.finalText,
          startedAt: disk.meta.startedAt,
          finishedAt: disk.meta.finishedAt ?? disk.meta.startedAt,
          error: disk.meta.error,
          recordState,
        }
      : undefined,
    error: disk.meta.error,
    historyDir: disk.meta.dir,
    fromDisk: true,
    stages: deriveStages(disk.events, recordState),
    ...historyExtras(disk.meta.dir),
    ...(job
      ? { jobId: job.jobId, trigger: job.trigger, jobStatus: job.status }
      : {}),
  });
});

app.get('/api/runs/:runId/events', (req, res) => {
  const runId = req.params.runId;
  const run = adminRunStore.get(runId);
  if (!run) {
    // Pending queue: no SSE yet — client should poll snapshot
    const job = controlStore.getJobByRunId(runId);
    if (job && (job.status === 'pending' || job.status === 'claimed')) {
      res.status(409).json({
        error: 'Run is still queued; SSE starts when execution begins',
        runId,
        jobStatus: job.status,
      });
      return;
    }
    res.status(404).json({ error: `Unknown run: ${runId}` });
    return;
  }

  const afterRaw = req.query['after'];
  const afterSequence =
    typeof afterRaw === 'string' && afterRaw.trim() !== ''
      ? Number(afterRaw)
      : -1;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const writeEvent = (event: AgentProgressEvent) => {
    res.write(`id: ${event.sequence}\n`);
    res.write(`event: progress\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const writeStatus = () => {
    res.write(
      `event: status\ndata: ${JSON.stringify({
        runId,
        status: run.status,
      })}\n\n`,
    );
  };

  writeStatus();

  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    res.end();
  };

  unsubscribe = adminRunStore.subscribe(
    runId,
    (event) => {
      writeEvent(event);
      if (event.kind === 'run.completed' || event.kind === 'run.failed') {
        res.write(
          `event: terminal\ndata: ${JSON.stringify({
            runId,
            status: adminRunStore.get(runId)?.status,
            kind: event.kind,
          })}\n\n`,
        );
        close();
      }
    },
    Number.isFinite(afterSequence) ? afterSequence : -1,
  );

  if (
    !closed &&
    (run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'cancelled')
  ) {
    res.write(
      `event: terminal\ndata: ${JSON.stringify({
        runId,
        status: run.status,
      })}\n\n`,
    );
    close();
    return;
  }

  heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15000);

  req.on('close', () => {
    close();
  });
});

app.post('/api/runs/:runId/cancel', (req, res) => {
  const runId = req.params.runId;
  const job = controlStore.getJobByRunId(runId);
  if (job && (job.status === 'pending' || job.status === 'claimed')) {
    controlStore.cancelJob(job.jobId);
    res.json({ ok: true, runId, jobId: job.jobId, status: 'cancelled' });
    return;
  }
  const run = adminRunStore.get(runId);
  if (!run) {
    res.status(404).json({ error: `Unknown run: ${runId}` });
    return;
  }
  const ok = adminRunStore.cancel(runId);
  res.json({ ok, runId, status: adminRunStore.get(runId)?.status });
});

app.post('/api/runs/:runId/approvals/:approvalId', (req, res) => {
  const runId = req.params.runId;
  const approvalId = req.params.approvalId;
  const run = adminRunStore.get(runId);
  if (!run) {
    res.status(404).json({ error: `Unknown run: ${runId}` });
    return;
  }
  const body = req.body as { decision?: string };
  const decision =
    body.decision === 'granted' || body.decision === 'denied'
      ? body.decision
      : undefined;
  if (!decision) {
    res.status(400).json({
      ok: false,
      error: `decision must be 'granted' or 'denied'`,
    });
    return;
  }
  const ok = adminRunStore.resolveApproval(runId, approvalId, decision);
  if (!ok) {
    res.status(404).json({
      ok: false,
      error: `Unknown or already resolved approval: ${approvalId}`,
      runId,
      approvalId,
    });
    return;
  }
  res.json({ ok: true, runId, approvalId, decision });
});

app.delete('/api/runs/:runId', (req, res) => {
  const runId = req.params.runId;
  const memory = adminRunStore.get(runId);
  if (memory && (memory.status === 'queued' || memory.status === 'running')) {
    res.status(409).json({
      ok: false,
      error: 'Cannot delete an active run. Cancel it first.',
      runId,
      status: memory.status,
    });
    return;
  }
  const job = controlStore.getJobByRunId(runId);
  if (job && (job.status === 'pending' || job.status === 'claimed' || job.status === 'running')) {
    res.status(409).json({
      ok: false,
      error: 'Cannot delete an active queued job. Cancel it first.',
      runId,
      jobStatus: job.status,
    });
    return;
  }
  const removedMemory = memory ? adminRunStore.remove(runId) : false;
  let removedDisk = false;
  try {
    removedDisk = getAdminRunHistory(repoRoot).deleteRun(runId);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      runId,
    });
    return;
  }
  if (!removedMemory && !removedDisk && !job) {
    res.status(404).json({ ok: false, error: `Unknown run: ${runId}`, runId });
    return;
  }
  res.json({ ok: true, runId, removedMemory, removedDisk });
});

app.delete('/api/runs', (req, res) => {
  const body = req.body as { runIds?: unknown } | undefined;
  const requestedIds = Array.isArray(body?.runIds)
    ? body.runIds.filter((v): v is string => typeof v === 'string')
    : undefined;

  const scope =
    typeof req.query['scope'] === 'string' ? req.query['scope'] : 'terminal';
  if (!requestedIds && scope !== 'terminal' && scope !== 'all') {
    res.status(400).json({
      ok: false,
      error: 'scope must be "terminal" or "all"',
    });
    return;
  }

  const history = getAdminRunHistory(repoRoot);
  const memory = adminRunStore.list();
  const memoryIds = new Set(memory.map((r) => r.runId));
  const fromDisk = history
    .listRuns()
    .filter((item) => !memoryIds.has(item.runId))
    .map((item) => diskItemToSummary(item));
  const known = new Map(
    [...memory, ...fromDisk].map((run) => [run.runId, run] as const),
  );

  const isTerminal = (status: string) =>
    status === 'completed' || status === 'failed' || status === 'cancelled';

  const deleted: string[] = [];
  const skipped: Array<{ runId: string; reason: string }> = [];

  const targets = requestedIds
    ? requestedIds.map((id) => known.get(id) ?? { runId: id, status: 'unknown' })
    : [...known.values()].filter(
        (run) => scope === 'all' || isTerminal(run.status),
      );

  for (const run of targets) {
    if (run.status === 'queued' || run.status === 'running') {
      skipped.push({ runId: run.runId, reason: `active:${run.status}` });
      continue;
    }
    const hadMemory = memoryIds.has(run.runId);
    adminRunStore.remove(run.runId);
    try {
      const removedDisk = history.deleteRun(run.runId);
      if (hadMemory || removedDisk) {
        deleted.push(run.runId);
      } else {
        skipped.push({ runId: run.runId, reason: 'not-found' });
      }
    } catch (err) {
      skipped.push({
        runId: run.runId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  res.json({ ok: true, deleted, skipped, count: deleted.length });
});

app.get('/api/runs/:runId/files', createRunFilesListHandler(repoRoot));
app.get(
  '/api/runs/:runId/files/*rel',
  createRunFileServeHandler(repoRoot),
);

// Express default 404 is plain text "Not found." which breaks admin fetchJson.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: `Not found: ${_req.method} ${_req.originalUrl}` });
});

app.listen(port, () => {
  const ids = discoverAgents(discovery).map((a) => a.id);
  console.log(`agent-env admin API on http://127.0.0.1:${port}`);
  console.log(`  host root: ${repoRoot}`);
  console.log(`  builtin agents: ${host.builtinAgentsDir}`);
  console.log(
    `  plugin packs: ${host.pluginPackDirs.length ? host.pluginPackDirs.join(', ') : '(none)'}`,
  );
  console.log(`  agents: ${ids.join(', ') || '(none)'}`);
  console.log(`  maxSlots: ${maxSlots}`);
  console.log(`  auth: ${authConfig.enabled ? 'basic' : 'disabled'}`);
  console.log(`  control db: ${controlStore.dbPath}`);
});

process.on('SIGINT', () => {
  scheduler.stop();
  workerPool.stop();
  controlStore.close();
  process.exit(0);
});
