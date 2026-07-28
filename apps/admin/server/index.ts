/**
 * Local admin API for agent discovery + parameterized async runs with SSE.
 * Providers: @agent-env/repo-env. Agents: filesystem scan under agents/.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import {
  defaultValuesFromParams,
  loadAgentParamsFile,
  type RunHistoryListItem,
  type RunHistoryStatus,
} from '@agent-env/harness';
import { listProviderMedia } from '@agent-env/llm';
import {
  bootstrapProvidersFromEnv,
  discoverAgents,
  getDiscoveredAgent,
  getResolvedAgentPackage,
  loadDotEnv,
} from '@agent-env/repo-env';
import type { AgentProgressEvent, ModelRef } from '@agent-env/shared';
import {
  createRunFileServeHandler,
  createRunFilesListHandler,
} from './files.js';
import { getAdminRunHistory } from './run-history.js';
import { startAgentRun } from './runs.js';
import {
  adminRunStore,
  type AdminRunSummary,
} from './run-store.js';
import { createUploadHandler, createUploadPreviewHandler } from './uploads.js';

function loadRunSpecModels(
  runSpec: { spec: { model: { primary: ModelRef; allowed?: ModelRef[] } } },
): { primary: ModelRef; allowed: ModelRef[] } {
  const primary = runSpec.spec.model.primary;
  const allowed = runSpec.spec.model.allowed?.length
    ? runSpec.spec.model.allowed
    : [primary];
  const keys = new Set(allowed.map((m) => `${m.provider}:${m.model}`));
  const primaryKey = `${primary.provider}:${primary.model}`;
  const models = keys.has(primaryKey) ? allowed : [primary, ...allowed];
  return { primary, allowed: models };
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));
/** Monorepo root (apps/admin/server → ../../..). */
const repoRoot = resolve(__dirname, '../../..');
const agentsRoot = resolve(repoRoot, 'agents');
const discovery = { agentsDir: agentsRoot, repoRoot };

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

const app = express();
const port = Number(process.env['ADMIN_API_PORT'] ?? 8787);

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.post('/api/uploads', createUploadHandler(repoRoot));
app.get('/api/uploads/preview', createUploadPreviewHandler(repoRoot));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, cwd: repoRoot });
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

app.get('/api/agents', (_req, res) => {
  try {
    const agents = discoverAgents(discovery).map((m) => {
      let title: string | undefined;
      let fieldCount = 0;
      if (m.paramsFile) {
        try {
          const params = loadAgentParamsFile(m.paramsFile, repoRoot);
          title = params.title;
          fieldCount = params.fields.length;
        } catch {
          // list still works without params detail
        }
      }
      return {
        id: m.id,
        name: m.name,
        description: m.description,
        entry: m.entry,
        paramsFile: m.paramsFile,
        models: m.models,
        title,
        runMode: 'runspec',
        fieldCount,
      };
    });
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
      runspecModels: loadRunSpecModels(pkg.runSpec),
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Async start — returns runId immediately for SSE subscription. */
app.post('/api/agents/:id/runs', (req, res) => {
  const id = req.params.id;
  const body = req.body as {
    values?: Record<string, unknown>;
    model?: ModelRef;
    autoApprove?: boolean;
  };
  const values = body.values ?? {};
  const outcome = startAgentRun(id, values, repoRoot, body.model, {
    autoApprove: body.autoApprove === true,
  });
  if (!outcome.ok) {
    res.status(400).json(outcome);
    return;
  }
  res.status(202).json(outcome);
});

/** Backward-compatible sync alias kept as 410-style redirect to async API docs. */
app.post('/api/agents/:id/run', (req, res) => {
  res.status(409).json({
    ok: false,
    error:
      'Synchronous /run is removed. Use POST /api/agents/:id/runs then GET /api/runs/:runId/events (SSE).',
  });
});

app.get('/api/runs', (_req, res) => {
  try {
    const memory = adminRunStore.list();
    const memoryIds = new Set(memory.map((r) => r.runId));
    const history = getAdminRunHistory(repoRoot);
    const fromDisk: AdminRunSummary[] = history
      .listRuns()
      .filter((item) => !memoryIds.has(item.runId))
      .map((item) => diskItemToSummary(item));
    const runs = [...memory, ...fromDisk].sort(
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
  if (run) {
    res.json(adminRunStore.toPublic(run));
    return;
  }
  const disk = getAdminRunHistory(repoRoot).readRun(req.params.runId);
  if (!disk) {
    res.status(404).json({ error: `Unknown run: ${req.params.runId}` });
    return;
  }
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
          status:
            disk.meta.status === 'completed' ? 'finished' : 'error',
          finalText: disk.finalText,
          startedAt: disk.meta.startedAt,
          finishedAt: disk.meta.finishedAt ?? disk.meta.startedAt,
          error: disk.meta.error,
        }
      : undefined,
    error: disk.meta.error,
    historyDir: disk.meta.dir,
    fromDisk: true,
  });
});

app.get('/api/runs/:runId/events', (req, res) => {
  const runId = req.params.runId;
  const run = adminRunStore.get(runId);
  if (!run) {
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

  // Already terminal before subscribe (race): end after replay.
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
  const run = adminRunStore.get(runId);
  if (!run) {
    res.status(404).json({ error: `Unknown run: ${runId}` });
    return;
  }
  const ok = adminRunStore.cancel(runId);
  res.json({ ok, runId, status: adminRunStore.get(runId)?.status });
});

/**
 * Resolve an interactive T2/T3 tool approval for an in-flight run.
 * Body: `{ decision: 'granted' | 'denied' }`
 */
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

/** Delete a finished run from memory + durable history (`.runs/runs/`). */
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
  if (!removedMemory && !removedDisk) {
    res.status(404).json({ ok: false, error: `Unknown run: ${runId}`, runId });
    return;
  }
  res.json({ ok: true, runId, removedMemory, removedDisk });
});

/**
 * Bulk-delete finished runs. Either pass a JSON body `{ runIds: [...] }` to
 * delete specific runs, or query `scope=terminal` (default) to remove all
 * completed / failed / cancelled runs. Active runs are always skipped.
 */
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
/** Wildcard file serve — path relative to the run history directory. */
app.get(
  '/api/runs/:runId/files/*rel',
  createRunFileServeHandler(repoRoot),
);

app.listen(port, () => {
  const ids = discoverAgents(discovery).map((a) => a.id);
  console.log(`agent-env admin API on http://127.0.0.1:${port}`);
  console.log(`  repo root: ${repoRoot}`);
  console.log(`  agents: ${ids.join(', ') || '(none)'}`);
});
