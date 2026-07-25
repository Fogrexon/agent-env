/**
 * Offline smoke for Phase A runtime (no API keys / network).
 */
import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  globSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  BudgetManager,
  InMemoryEventStore,
  RunStateMachine,
  canTransition,
  parseEvaluationSpec,
  parseRunSpec,
  verifyRunSpec,
} from '@agent-env/harness';

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

const store = new InMemoryEventStore();
store.append({
  eventType: 'run.created',
  runId: 'r1',
  attemptId: 'a1',
  tenantId: 't',
  payload: { ok: true },
});
assert(store.size === 1, 'event');

const budget = new BudgetManager({ maxToolCalls: 1, maxWallSeconds: 60 });
budget.consumeToolCall(2);
assert(budget.exhaustionReason() === 'maxToolCalls', 'budget');

const emptySpec = parseRunSpec({
  spec: {
    task: { taskId: 't', objective: 'demo' },
    model: { primary: { provider: 'gemini', model: 'gemini-3.6-flash' } },
  },
});

// --- non-empty grader --------------------------------------------------------
{
  const evaluation = parseEvaluationSpec({
    metadata: { id: 'non-empty', version: '1' },
    graders: [
      { id: 'output', kind: 'deterministic', ref: 'grader://non-empty/v1' },
    ],
    acceptance: {
      all: [{ id: 'a', grader: 'output', assertion: 'non-empty' }],
    },
  });
  const pass = await verifyRunSpec(emptySpec, evaluation, {
    finalText: 'hello',
  });
  assert(pass.passed, 'non-empty pass');
  const fail = await verifyRunSpec(emptySpec, evaluation, { finalText: '  ' });
  assert(!fail.passed, 'non-empty fail');
  console.log('✓ non-empty grader');
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
  const evaluation = parseEvaluationSpec({
    metadata: { id: 'doc', version: '1' },
    artifacts: [
      {
        id: 'report',
        mediaTypes: ['text/markdown'],
        required: true,
        minBytes: 10,
      },
    ],
    graders: [
      {
        id: 'artifacts',
        kind: 'deterministic',
        ref: 'grader://artifact-contract/v1',
      },
      {
        id: 'structure',
        kind: 'deterministic',
        ref: 'grader://document-contract/v1',
        config: {
          artifact: 'report',
          sections: ['Sources', 'Residual uncertainties'],
        },
      },
    ],
    acceptance: {
      all: [
        { id: 'a', grader: 'artifacts', assertion: 'present' },
        { id: 'b', grader: 'structure', assertion: 'sections' },
      ],
    },
  });
  const missing = await verifyRunSpec(emptySpec, evaluation, {
    finalText: 'claimed',
    workspaceDir: join(dir, 'missing'),
  });
  assert(!missing.passed, 'artifact fail when missing');
  const pass = await verifyRunSpec(emptySpec, evaluation, {
    finalText: 'claimed',
    workspaceDir: workspace,
  });
  assert(pass.passed, 'artifact + document pass');

  // Same artifact id, multiple media contracts (deep-research style).
  writeFileSync(join(workspace, 'report.pdf'), Buffer.alloc(600, 1));
  const multi = parseEvaluationSpec({
    metadata: { id: 'doc-multi', version: '1' },
    artifacts: [
      {
        id: 'report',
        mediaTypes: ['text/markdown'],
        required: true,
        minBytes: 10,
      },
      {
        id: 'report',
        mediaTypes: ['application/pdf'],
        required: true,
        minBytes: 500,
      },
    ],
    graders: [
      {
        id: 'artifacts',
        kind: 'deterministic',
        ref: 'grader://artifact-contract/v1',
      },
      {
        id: 'structure',
        kind: 'deterministic',
        ref: 'grader://document-contract/v1',
        config: {
          artifact: 'report',
          sections: ['Sources', 'Residual uncertainties'],
        },
      },
    ],
    acceptance: {
      all: [
        { id: 'a', grader: 'artifacts', assertion: 'present' },
        { id: 'b', grader: 'structure', assertion: 'sections' },
      ],
    },
  });
  const multiPass = await verifyRunSpec(emptySpec, multi, {
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
  const multiFail = await verifyRunSpec(emptySpec, multi, {
    finalText: 'claimed',
    workspaceDir: pdfMissingDir,
  });
  assert(!multiFail.passed, 'pdf contract fails when only md present');

  rmSync(dir, { recursive: true, force: true });
  console.log('✓ artifact / document graders');
}

// --- json_schema grader ------------------------------------------------------
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
  const evaluation = parseEvaluationSpec({
    metadata: { id: 'json', version: '1' },
    graders: [
      {
        id: 'schema',
        kind: 'deterministic',
        ref: 'grader://json-schema/v1',
        config: { schemaRef: schemaPath },
      },
    ],
    acceptance: {
      all: [{ id: 'a', grader: 'schema', assertion: 'schema' }],
    },
  });
  const pass = await verifyRunSpec(emptySpec, evaluation, {
    finalText: '{"status":"verified"}',
    cwd: process.cwd(),
  });
  assert(pass.passed, 'json_schema pass');
  const fail = await verifyRunSpec(emptySpec, evaluation, {
    finalText: '{"status":"nope"}',
    cwd: process.cwd(),
  });
  assert(!fail.passed, 'json_schema fail');
  rmSync(dir, { recursive: true, force: true });
  console.log('✓ json_schema grader');
}

// --- command grader ----------------------------------------------------------
{
  const evaluation = parseEvaluationSpec({
    metadata: { id: 'cmd', version: '1' },
    graders: [
      {
        id: 'cmd',
        kind: 'deterministic',
        ref: 'grader://command/v1',
        config: {
          bin: process.execPath,
          args: ['-e', 'console.log("ok")'],
          baseDir: 'repo',
          outputContains: 'ok',
          timeoutMs: 30_000,
        },
      },
    ],
    acceptance: {
      all: [{ id: 'a', grader: 'cmd', assertion: 'exit-0' }],
    },
  });
  const pass = await verifyRunSpec(emptySpec, evaluation, {
    cwd: process.cwd(),
  });
  assert(pass.passed, 'command pass');
  console.log('✓ command grader');
}

// --- every checked-in RunSpec + EvaluationSpec parse -------------------------
{
  const runspecs = globSync('agents/*/runspec.json').sort();
  const evaluations = globSync('agents/*/evaluation.json').sort();
  assert(runspecs.length > 0, 'expected runspec.json files');
  assert(
    runspecs.length === evaluations.length,
    'each agent needs evaluation.json',
  );
  for (const file of runspecs) {
    const spec = parseRunSpec(JSON.parse(readFileSync(file, 'utf8')));
    assert(
      spec.spec.evaluation.ref === './evaluation.json',
      `${file} evaluation.ref`,
    );
    console.log(`  ${file}: ok`);
  }
  for (const file of evaluations) {
    parseEvaluationSpec(JSON.parse(readFileSync(file, 'utf8')));
    console.log(`  ${file}: ok`);
  }
  console.log(`✓ ${runspecs.length} agent package(s) parse`);
}

console.log('✓ smoke-runtime passed');
