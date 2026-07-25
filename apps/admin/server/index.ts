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
  };
  const values = body.values ?? {};
  const outcome = startAgentRun(id, values, repoRoot, body.model);
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
