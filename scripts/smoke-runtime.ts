/**
 * Offline smoke for Phase A runtime + evaluation plane (no API keys / network).
 */
import { z } from 'zod';
import {
  BudgetManager,
  InMemoryEventStore,
  RunStateMachine,
  canTransition,
  createCommandTestSuite,
  createTextLlmGrader,
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

const briefSchema = z.object({
  title: z.string(),
  findings: z.array(z.string()).min(1),
  recommendation: z.string(),
});

// --- oracle pass: structured artifact + external process ---
const oracleSpec = parseRunSpec({
  spec: {
    task: {
      taskId: 'oracle',
      objective: 'demo',
      successCriteria: [
        {
          type: 'json_schema',
          schemaRef: 'brief-v1',
          artifactKey: 'brief',
        },
        { type: 'test_suite', ref: 'oracle-process' },
        { type: 'custom', verifierId: 'has_rec' },
      ],
    },
    model: { primary: { provider: 'gemini', model: 'gemini-2.5-flash' } },
    evaluation: { graderVersion: 'smoke-v1' },
  },
});

const oraclePass = await verifyRunSpec(oracleSpec, {
  finalText: 'done',
  artifacts: {
    brief: {
      title: 'Harness',
      findings: ['measure runs'],
      recommendation: 'Use independent verifiers',
    },
  },
  jsonSchemas: { 'brief-v1': briefSchema },
  testSuites: {
    'oracle-process': createCommandTestSuite({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    }),
  },
  custom: {
    has_rec: (ctx) =>
      Boolean(
        (ctx.artifacts?.['brief'] as { recommendation?: string } | undefined)
          ?.recommendation,
      ),
  },
});
assert(oraclePass.passed, 'oracle pass');

// --- no-op rejection: empty artifacts must fail ---
const noopFail = await verifyRunSpec(oracleSpec, {
  finalText: 'I verified everything!',
  artifacts: {},
  jsonSchemas: { 'brief-v1': briefSchema },
  testSuites: {
    'oracle-process': createCommandTestSuite({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    }),
  },
  custom: { has_rec: () => true },
});
assert(!noopFail.passed, 'no-op rejection');
assert(
  noopFail.checks.some((c) => c.criterion.startsWith('json_schema:') && !c.passed),
  'json_schema failed on missing artifact',
);

// --- empty successCriteria: refuse agent self-success ---
const emptyCriteria = parseRunSpec({
  spec: {
    task: { taskId: 'e', objective: 'x', successCriteria: [] },
    model: { primary: { provider: 'gemini', model: 'g' } },
  },
});
const empty = await verifyRunSpec(emptyCriteria, { finalText: 'looks done' });
assert(!empty.passed, 'no criteria => not success');

// --- llm_grade alone: fail closed ---
const llmAlone = parseRunSpec({
  spec: {
    task: {
      taskId: 'g',
      objective: 'x',
      successCriteria: [
        { type: 'llm_grade', rubric: 'Was the task done?', passLabel: 'PASS' },
      ],
    },
    model: { primary: { provider: 'gemini', model: 'g' } },
    evaluation: { allowLlmGradeAlone: false },
  },
});
const llmAloneResult = await verifyRunSpec(llmAlone, {
  finalText: 'perfect',
  llmGrade: createTextLlmGrader({
    generate: async () => 'PASS',
  }),
});
assert(!llmAloneResult.passed, 'llm alone blocked');
assert(
  llmAloneResult.checks.some((c) => c.criterion === 'policy:allowLlmGradeAlone'),
  'policy check present',
);

// --- llm_grade + deterministic companion ---
const llmWithSuite = parseRunSpec({
  spec: {
    task: {
      taskId: 'g2',
      objective: 'x',
      successCriteria: [
        { type: 'test_suite', ref: 'ok' },
        { type: 'llm_grade', rubric: 'Quality ok?', passLabel: 'PASS' },
      ],
    },
    model: { primary: { provider: 'gemini', model: 'g' } },
  },
});
const llmCombo = await verifyRunSpec(llmWithSuite, {
  finalText: 'solid work',
  testSuites: {
    ok: createCommandTestSuite({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    }),
  },
  llmGrade: createTextLlmGrader({ generate: async () => 'PASS — meets rubric' }),
});
assert(llmCombo.passed, 'llm + deterministic');

// --- artifact_equals ---
const eqSpec = parseRunSpec({
  spec: {
    task: {
      taskId: 'eq',
      objective: 'x',
      successCriteria: [
        { type: 'artifact_equals', key: 'flag', expected: { ok: true } },
      ],
    },
    model: { primary: { provider: 'gemini', model: 'g' } },
  },
});
assert(
  (await verifyRunSpec(eqSpec, { artifacts: { flag: { ok: true } } })).passed,
  'artifact equals',
);
assert(
  !(await verifyRunSpec(eqSpec, { artifacts: { flag: { ok: false } } })).passed,
  'artifact mismatch',
);

console.log('✓ smoke-runtime passed');
