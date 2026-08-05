import { z } from 'zod';

export const agentGraphNodeKindSchema = z.enum([
  'llm',
  'sequential',
  'parallel',
  'loop',
  'routed',
  'custom',
  'review_loop',
  /** External / local data source (connector), not an LLM. */
  'datasource',
]);
export type AgentGraphNodeKind = z.infer<typeof agentGraphNodeKindSchema>;

export const agentGraphEdgeKindSchema = z.enum([
  'contains',
  'next',
  'parallel',
  'route',
  'feedback',
  'delegate',
  'tool-call',
  'review',
  /** Fan-in after Parallel: session/outputKey merge into the next agent. */
  'join',
  /** Typed handoff artifact from emit tool (fromAgent → toAgent). */
  'handoff',
  /** LLM/agent reads from a datasource node. */
  'reads',
]);
export type AgentGraphEdgeKind = z.infer<typeof agentGraphEdgeKindSchema>;

export const agentGraphToolRefSchema = z.object({
  name: z.string().min(1),
  kind: z
    .enum(['function', 'agent_tool', 'connector', 'other'])
    .default('function'),
  /** When kind is agent_tool, the child agent name if known. */
  agentName: z.string().optional(),
  definitionId: z.string().optional(),
  /** When kind is connector, the datasource connector id. */
  connectorId: z.string().optional(),
});
export type AgentGraphToolRef = z.infer<typeof agentGraphToolRefSchema>;

export const agentGraphNodeSchema = z.object({
  id: z.string().min(1),
  kind: agentGraphNodeKindSchema,
  label: z.string().optional(),
  description: z.string().optional(),
  /** Qualified model string (provider:model) when kind is llm. */
  model: z.string().optional(),
  outputKey: z.string().optional(),
  tools: z.array(agentGraphToolRefSchema).default([]),
  maxIterations: z.number().int().positive().optional(),
  /** Extra metadata (review keys, route keys, …). */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type AgentGraphNode = z.infer<typeof agentGraphNodeSchema>;

export const agentGraphEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: agentGraphEdgeKindSchema,
  label: z.string().optional(),
  condition: z.string().optional(),
});
export type AgentGraphEdge = z.infer<typeof agentGraphEdgeSchema>;

export const agentGraphSchema = z.object({
  root: z.string().min(1),
  agentId: z.string().optional(),
  nodes: z.array(agentGraphNodeSchema),
  edges: z.array(agentGraphEdgeSchema).default([]),
});
export type AgentGraph = z.infer<typeof agentGraphSchema>;

/** Observed execution overlay: which nodes actually ran. */
export const observedAgentGraphSchema = agentGraphSchema.extend({
  executedNodeIds: z.array(z.string()).default([]),
  modelsUsed: z.array(z.string()).default([]),
});
export type ObservedAgentGraph = z.infer<typeof observedAgentGraphSchema>;
