/**
 * Offline smoke for Phase A runtime (no API keys / network).
 */
import { LlmAgent, SequentialAgent } from '@google/adk';
import {
  BudgetManager,
  InMemoryEventStore,
  RunStateMachine,
  assertGraphModelsResolvable,
  canTransition,
  createGuardedTool,
  describeAgentGraph,
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
sm.transition('COMPLETED');
assert(sm.terminal, 'terminal');
assert(!canTransition('COMPLETED', 'RUNNING'), 'no revive');

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
});
const budget = BudgetManager.fromLimits(limits);
budget.consumeToolCall(2);
assert(budget.exhaustionReason() === 'maxToolCalls', 'budget');

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
