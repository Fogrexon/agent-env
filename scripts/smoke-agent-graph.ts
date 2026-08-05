/**
 * Offline smoke for describeAgentGraph / buildObservedGraph /
 * provider-bridge Context for AgentTool (Cursor customTools path).
 */
import { LlmAgent, SequentialAgent } from '@google/adk';
import {
  buildObservedGraph,
  createGuardedTool,
  createTrackedAgentTool,
  describeAgentGraph,
} from '@agent-env/harness';
import { createProviderBridgeToolContext } from '@agent-env/llm';
import { z } from 'zod';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const echo = createGuardedTool({
  contract: { name: 'echo', riskClass: 'T0' },
  description: 'Echo',
  parameters: z.object({ text: z.string() }),
  execute: ({ text }) => ({ text }),
});

const child = new LlmAgent({
  name: 'child_agent',
  description: 'Child',
  model: 'gemini:gemini-3.6-flash',
  tools: [echo],
});

const tracked = createTrackedAgentTool({
  agent: child,
  skipSummarization: true,
});

const root = new LlmAgent({
  name: 'root_agent',
  description: 'Root',
  model: 'cursor:auto',
  tools: [echo, tracked],
});

const pipeline = new SequentialAgent({
  name: 'pipeline',
  description: 'Seq',
  subAgents: [root, child],
});

const graph = describeAgentGraph(pipeline, { agentId: 'smoke-graph' });
assert(graph.root === 'pipeline', 'root');
assert(graph.agentId === 'smoke-graph', 'agentId');
assert(graph.nodes.some((n) => n.id === 'root_agent'), 'root node');
assert(graph.nodes.some((n) => n.id === 'child_agent'), 'child node');
assert(
  graph.edges.some((e) => e.kind === 'contains' || e.kind === 'next'),
  'seq edges',
);
assert(
  graph.nodes
    .find((n) => n.id === 'root_agent')
    ?.tools.some((t) => t.kind === 'agent_tool'),
  'tracked agent_tool ref',
);

const observed = buildObservedGraph(graph, []);
assert(observed.executedNodeIds.length === 0, 'no progress → empty executed');
assert(Array.isArray(observed.modelsUsed), 'modelsUsed array');

// Provider-bridged AgentTool needs a real Context (empty {} stub throws on
// invocationContext.sessionService before AgentTool's InMemory fallback).
const bridgeCtx = createProviderBridgeToolContext();
assert(bridgeCtx.invocationContext?.session?.id, 'bridge session id');
assert(bridgeCtx.invocationContext.userId, 'bridge userId');
assert(typeof bridgeCtx.state.toRecord === 'function', 'bridge state');
let stubFailed = false;
try {
  await tracked.runAsync({
    args: { request: 'ping' },
    toolContext: {} as Parameters<typeof tracked.runAsync>[0]['toolContext'],
  });
} catch {
  stubFailed = true;
}
assert(stubFailed, 'empty stub Context must fail for AgentTool');

console.log('✓ smoke-agent-graph passed');
