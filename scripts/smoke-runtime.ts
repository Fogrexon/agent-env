/**
 * Offline smoke for Phase A runtime (no API keys / network).
 */
import {
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { LlmAgent, SequentialAgent } from '@google/adk';
import {
  BudgetManager,
  InMemoryEventStore,
  RunStateMachine,
  assertGraphModelsResolvable,
  canTransition,
  createGuardedTool,
  describeAgentGraph,
  executeVerificationPlan,
  verify,
} from '@agent-env/harness';
import { agentExecutionLimitsSchema } from '@agent-env/shared';
import { z } from 'zod';
import { listAgents } from './agent-catalog.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const sm = new RunStateMachine();
assert(sm.state === 'QUEUED', 'initial');
sm.transition('PROVISIONING');
sm.transition('RUNNING');
sm.transition('VERIFYING');
sm.transition('SUCCEEDED');
assert(sm.terminal, 'terminal');
assert(!canTransition('SUCCEEDED', 'RUNNING'), 'no revive');

const completed = new RunStateMachine();
completed.transition('PROVISIONING');
completed.transition('RUNNING');
completed.transition('VERIFYING');
completed.transition('COMPLETED');
assert(completed.terminal, 'COMPLETED is terminal');
assert(!canTransition('COMPLETED', 'RUNNING'), 'no revive from COMPLETED');

const store = new InMemoryEventStore();
store.append({
  eventType: 'run.created',
  runId: 'r1',
  attemptId: 'a1',
  tenantId: 't',
  payload: { ok: true },
});
assert(store.size === 1, 'event');

const limits = agentExecutionLimitsSchema.parse({
  maxToolCalls: 1,
  maxWallSeconds: 60,
  maxSteps: 10,
  maxRepairs: 0,
});
const budget = BudgetManager.fromLimits(limits);
budget.consumeToolCall(2);
assert(budget.exhaustionReason() === 'maxToolCalls', 'budget');

// --- nonEmpty check ----------------------------------------------------------
{
  const plan = { checks: [verify.nonEmpty()] };
  const pass = await executeVerificationPlan(plan, { finalText: 'hello' });
  assert(pass.passed && pass.outcome === 'passed', 'nonEmpty pass');
  const fail = await executeVerificationPlan(plan, { finalText: '  ' });
  assert(!fail.passed, 'nonEmpty fail');
  console.log('✓ nonEmpty check');
}

// --- empty / advisory-only → not-gated ---------------------------------------
{
  const empty = await executeVerificationPlan({ checks: [] }, {
    finalText: 'anything',
  });
  assert(empty.outcome === 'not-gated', 'empty plan not-gated');
  const advisory = await executeVerificationPlan(
    { checks: [verify.nonEmpty({ severity: 'advisory' })] },
    { finalText: '' },
  );
  assert(advisory.outcome === 'not-gated', 'advisory-only not-gated');
  console.log('✓ not-gated / COMPLETED mapping inputs');
}

// --- artifact + document contract --------------------------------------------
{
  const dir = join(process.cwd(), '.tmp-smoke-runtime-workspace');
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, 'report.md'),
    '## Sources\n\nok\n\n## Residual uncertainties\n\nok\n',
    'utf8',
  );
  const plan = {
    checks: [
      verify.artifact({
        artifactId: 'report',
        mediaTypes: ['text/markdown'],
        minBytes: 10,
      }),
      verify.document({
        artifactId: 'report',
        sections: ['Sources', 'Residual uncertainties'],
      }),
    ],
  };
  const missing = await executeVerificationPlan(plan, {
    finalText: 'claimed',
    workspaceDir: join(dir, 'missing'),
  });
  assert(!missing.passed, 'artifact fail when missing');
  const pass = await executeVerificationPlan(plan, {
    finalText: 'claimed',
    workspaceDir: workspace,
  });
  assert(pass.passed, 'artifact + document pass');

  writeFileSync(join(workspace, 'report.pdf'), Buffer.alloc(600, 1));
  const multi = {
    checks: [
      verify.artifact({
        artifactId: 'report',
        mediaTypes: ['text/markdown'],
        minBytes: 10,
      }),
      verify.artifact({
        id: 'artifact:report:pdf',
        artifactId: 'report',
        mediaTypes: ['application/pdf'],
        minBytes: 500,
      }),
      verify.document({
        artifactId: 'report',
        sections: ['Sources', 'Residual uncertainties'],
      }),
    ],
  };
  const multiPass = await executeVerificationPlan(multi, {
    finalText: 'claimed',
    workspaceDir: workspace,
  });
  assert(multiPass.passed, 'md+pdf same id contracts pass');
  const pdfMissingDir = join(dir, 'md-only');
  mkdirSync(pdfMissingDir, { recursive: true });
  writeFileSync(
    join(pdfMissingDir, 'report.md'),
    '## Sources\n\nok\n\n## Residual uncertainties\n\nok\n',
    'utf8',
  );
  const multiFail = await executeVerificationPlan(multi, {
    finalText: 'claimed',
    workspaceDir: pdfMissingDir,
  });
  assert(!multiFail.passed, 'pdf contract fails when only md present');

  rmSync(dir, { recursive: true, force: true });
  console.log('✓ artifact / document checks');
}

// --- jsonSchema check --------------------------------------------------------
{
  const dir = join(process.cwd(), '.tmp-smoke-runtime-schema');
  mkdirSync(dir, { recursive: true });
  const schemaPath = join(dir, 'demo.schema.json');
  writeFileSync(
    schemaPath,
    JSON.stringify({
      type: 'object',
      required: ['status'],
      properties: { status: { const: 'verified' } },
      additionalProperties: false,
    }),
    'utf8',
  );
  const plan = {
    checks: [verify.jsonSchema({ schemaRef: schemaPath, baseDir: 'repo' })],
  };
  const pass = await executeVerificationPlan(plan, {
    finalText: '{"status":"verified"}',
    cwd: process.cwd(),
  });
  assert(pass.passed, 'jsonSchema pass');
  const fail = await executeVerificationPlan(plan, {
    finalText: '{"status":"nope"}',
    cwd: process.cwd(),
  });
  assert(!fail.passed, 'jsonSchema fail');
  rmSync(dir, { recursive: true, force: true });
  console.log('✓ jsonSchema check');
}

// --- command check -----------------------------------------------------------
{
  const plan = {
    checks: [
      verify.command({
        bin: process.execPath,
        args: ['-e', 'console.log("ok")'],
        baseDir: 'repo',
        outputContains: 'ok',
        timeoutMs: 30_000,
      }),
    ],
  };
  const pass = await executeVerificationPlan(plan, {
    cwd: process.cwd(),
  });
  assert(pass.passed, 'command pass');
  console.log('✓ command check');
}

// --- agent graph + model resolvability ---------------------------------------
{
  const note = createGuardedTool({
    contract: { name: 'note', riskClass: 'T0' },
    description: 'note',
    parameters: z.object({ text: z.string() }),
    execute: ({ text }) => ({ text }),
  });
  const leaf = new LlmAgent({
    name: 'leaf',
    model: 'gemini:gemini-3.6-flash',
    tools: [note],
  });
  const root = new SequentialAgent({
    name: 'root',
    subAgents: [leaf],
  });
  const graph = describeAgentGraph(root, { agentId: 'smoke' });
  assert(graph.root === 'root', 'graph root');
  assert(graph.nodes.some((n) => n.id === 'leaf' && n.kind === 'llm'), 'llm node');
  assert(
    graph.nodes.some((n) => n.id === 'leaf' && n.model === 'gemini:gemini-3.6-flash'),
    'provider-qualified model',
  );
  assertGraphModelsResolvable(graph);

  const bare = describeAgentGraph(
    new LlmAgent({ name: 'bare', model: 'gemini-3.6-flash' }),
  );
  let rejected = false;
  try {
    assertGraphModelsResolvable(bare);
  } catch {
    rejected = true;
  }
  assert(rejected, 'bare model ids rejected');
  console.log('✓ describeAgentGraph / assertGraphModelsResolvable');
}

// --- discovered agent packages still exist -----------------------------------
{
  const agents = listAgents();
  assert(agents.length > 0, 'expected discovered agents');
  for (const agent of agents) {
    assert(agent.id.length > 0, 'agent id');
    console.log(`  ${agent.id}: ok`);
  }
  console.log(`✓ ${agents.length} agent package(s) discovered`);
}

console.log('✓ smoke-runtime passed');
