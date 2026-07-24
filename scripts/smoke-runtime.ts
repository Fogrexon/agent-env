/**
 * Offline smoke for Phase A runtime (no API keys / network).
 */
import {
  BudgetManager,
  InMemoryEventStore,
  RunStateMachine,
  canTransition,
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

const spec = parseRunSpec({
  spec: {
    task: {
      taskId: 't',
      objective: 'demo',
      successCriteria: [{ type: 'contains', text: 'verified' }],
    },
    model: { primary: { provider: 'gemini', model: 'gemini-2.5-flash' } },
  },
});

const pass = await verifyRunSpec(spec, { finalText: 'This is verified output' });
assert(pass.passed, 'verify pass');
const fail = await verifyRunSpec(spec, { finalText: 'nope' });
assert(!fail.passed, 'verify fail');

console.log('✓ smoke-runtime passed');
