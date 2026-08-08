/**
 * Offline smoke for file-backed run history (no network / LLM).
 *
 * Also covers the extra per-run snapshot files that
 * agents/dev-env/run-discovered-agent.ts writes alongside the
 * RunHistoryWriter output (intent.json, effective-graph.json,
 * verification-plan.json, observed-graph.json): writing them must not
 * break `readRun` / `listRuns`, and older run directories that predate
 * those snapshots must still read back fine (backward compatible).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildObservedGraph,
  composeProgressSinks,
  createRunHistoryStore,
  describeAgentGraph,
  RUN_WORKSPACE_STATE_KEY,
  verify,
} from '@agent-env/harness';
import { LlmAgent } from '@google/adk';
import { createProgressSequencer } from '@agent-env/shared';
import type { AgentProgressEvent, AgentRunResult } from '@agent-env/shared';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const baseDir = mkdtempSync(join(tmpdir(), 'agent-env-run-history-'));

try {
{
  const store = createRunHistoryStore({ baseDir });
  const writer = store.open({
    runId: '11111111-2222-3333-4444-555555555555',
    agentId: 'demo-agent',
    runMode: 'agent',
    message: 'smoke message',
  });

  assert(writer.dir.includes('demo-agent'), 'dir includes agent id');
  assert(
    writer.workspaceDir.endsWith('workspace') ||
      writer.workspaceDir.endsWith('workspace\\') ||
      writer.workspaceDir.includes(`${join('workspace')}`),
    'workspaceDir set',
  );
  assert(RUN_WORKSPACE_STATE_KEY === 'runWorkspaceDir', 'state key');

  const memory: AgentProgressEvent[] = [];
  const sink = composeProgressSinks(writer.progressSink, (e) => memory.push(e));
  const progress = createProgressSequencer(writer.runId, sink);

  progress.emit('run.started', { message: 'start' });
  // Streaming partials reach live sinks but must not land on disk.
  progress.emit('agent.event', {
    author: 'demo',
    message: 'hel',
    agentEvent: {
      author: 'demo',
      isFinal: false,
      partial: true,
      text: 'hel',
    },
  });
  progress.emit('agent.event', {
    author: 'demo',
    message: 'hello world',
    agentEvent: { author: 'demo', isFinal: true, text: 'hello world' },
  });
  progress.emit('run.completed', { message: 'done' });

  assert(memory.length === 4, 'memory sink got all 4 (incl. partial)');

  const progressRaw = readFileSync(join(writer.dir, 'progress.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert(progressRaw.length === 3, 'progress.jsonl skips partials');
  const diskMiddle = JSON.parse(progressRaw[1]!) as AgentProgressEvent;
  assert(
    diskMiddle.message === undefined &&
      diskMiddle.agentEvent?.text === 'hello world',
    'disk line drops duplicate message',
  );

  const result: AgentRunResult = {
    status: 'finished',
    finalText: 'hello world',
    events: [{ author: 'demo', isFinal: true, text: 'hello world' }],
    sessionId: writer.runId,
    userId: 'u',
    appName: 'smoke',
    agentName: 'demo',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
  writer.writeResult(result);

  const listed = store.listRuns();
  assert(listed.length === 1, 'listRuns length 1');
  assert(listed[0]?.runId === writer.runId, 'listRuns runId');
  assert(listed[0]?.status === 'completed', 'listRuns status');
  assert(listed[0]?.finalTextPreview?.includes('hello'), 'preview');

  const read = store.readRun(writer.runId);
  assert(read, 'readRun');
  assert(read.events.length === 3, 'read events');
  assert(read.finalText?.includes('hello world'), 'final.md');
  assert(read.meta.workspaceDir === writer.workspaceDir, 'workspace meta');

  const missing = store.readRun('does-not-exist');
  assert(missing === undefined, 'missing run');

  console.log('✓ readRun / listRuns / writeResult');
}

// --- intent.json / effective-graph / verification-plan / observed-graph -------
{
  // Mirrors run-discovered-agent.ts: these snapshots are written directly
  // into writer.dir (not through a RunHistoryWriter method), alongside the
  // usual run.json / progress.jsonl / result.json / final.md.
  const store = createRunHistoryStore({ baseDir });
  const writer = store.open({
    runId: '66666666-7777-8888-9999-000000000000',
    agentId: 'demo-agent',
    runMode: 'agent',
    message: 'snapshot smoke message',
  });

  const agent = new LlmAgent({ name: 'demo_leaf', model: 'gemini:gemini-3.6-flash' });
  const effectiveGraph = describeAgentGraph(agent, { agentId: 'demo-agent' });
  const verificationPlan = { checks: [verify.nonEmpty()] };
  const intent = {
    agentId: 'demo-agent',
    objective: 'snapshot smoke message',
    inputs: {},
    attachmentPaths: [],
    limits: {
      maxSteps: 10,
      maxToolCalls: 10,
      maxWallSeconds: 60,
      maxRepairs: 0,
      maxSubagentDepth: 3,
    },
    verificationPlanId: 'verification',
  };
  const observedGraph = buildObservedGraph(effectiveGraph, []);

  writeFileSync(
    join(writer.dir, 'intent.json'),
    `${JSON.stringify(intent, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(writer.dir, 'effective-graph.json'),
    `${JSON.stringify(effectiveGraph, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(writer.dir, 'verification-plan.json'),
    `${JSON.stringify(verificationPlan, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(writer.dir, 'observed-graph.json'),
    `${JSON.stringify(observedGraph, null, 2)}\n`,
    'utf8',
  );

  const result: AgentRunResult = {
    status: 'finished',
    finalText: 'snapshot done',
    events: [{ author: 'demo_leaf', isFinal: true, text: 'snapshot done' }],
    sessionId: writer.runId,
    userId: 'u',
    appName: 'smoke',
    agentName: 'demo_leaf',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
  writer.writeResult(result);

  // The extra snapshot files must not confuse readRun / listRuns.
  const read = store.readRun(writer.runId);
  assert(read, 'readRun still works alongside new snapshot files');
  assert(read.finalText?.includes('snapshot done'), 'final.md unaffected');

  const listed = store.listRuns();
  assert(
    listed.some((r) => r.runId === writer.runId),
    'listRuns still finds the run',
  );

  const rereadIntent = JSON.parse(
    readFileSync(join(writer.dir, 'intent.json'), 'utf8'),
  ) as typeof intent;
  const rereadEffectiveGraph = JSON.parse(
    readFileSync(join(writer.dir, 'effective-graph.json'), 'utf8'),
  ) as typeof effectiveGraph;
  const rereadVerificationPlan = JSON.parse(
    readFileSync(join(writer.dir, 'verification-plan.json'), 'utf8'),
  ) as typeof verificationPlan;
  const rereadObservedGraph = JSON.parse(
    readFileSync(join(writer.dir, 'observed-graph.json'), 'utf8'),
  ) as typeof observedGraph;
  assert(rereadIntent.agentId === 'demo-agent', 'intent.json round-trips');
  assert(rereadEffectiveGraph.root === 'demo_leaf', 'effective-graph.json round-trips');
  assert(
    rereadVerificationPlan.checks[0]?.kind === 'nonEmpty',
    'verification-plan.json round-trips',
  );
  assert(
    Array.isArray(rereadObservedGraph.executedNodeIds),
    'observed-graph.json round-trips',
  );
  console.log('✓ intent.json / effective-graph / verification-plan / observed-graph snapshots');
}

// --- old run directories (pre-snapshot files) still read back fine ------------
{
  // A run created before intent.json / effective-graph.json /
  // verification-plan.json / observed-graph.json existed only has
  // run.json / progress.jsonl / result.json / final.md. readRun must not
  // require the newer snapshot files.
  const store = createRunHistoryStore({ baseDir });
  const writer = store.open({
    runId: '11112222-3333-4444-5555-666677778888',
    agentId: 'demo-agent',
    runMode: 'agent',
    message: 'old history message',
  });
  const result: AgentRunResult = {
    status: 'finished',
    finalText: 'old history final',
    events: [{ author: 'demo', isFinal: true, text: 'old history final' }],
    sessionId: writer.runId,
    userId: 'u',
    appName: 'smoke',
    agentName: 'demo',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
  writer.writeResult(result);

  const read = store.readRun(writer.runId);
  assert(read, 'old-format run (no new snapshots) still reads');
  assert(read.finalText?.includes('old history final'), 'old history final.md read');
  console.log('✓ old run history (pre-snapshot files) reads back fine');
}

console.log('✓ smoke-run-history passed');
} finally {
  rmSync(baseDir, { recursive: true, force: true });
}
