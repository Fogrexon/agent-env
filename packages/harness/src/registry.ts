import type { AgentManifest } from '@agent-env/shared';

/**
 * Built-in agent registry.
 * Keep this in sync when adding agents under `agents/`.
 * Future web admin can import this list for discovery.
 */
export const agentRegistry: readonly AgentManifest[] = [
  {
    id: 'hello',
    name: 'hello',
    description: 'Minimal LlmAgent + typed FunctionTool (script integration).',
    entry: 'agents/hello/agent.ts',
  },
  {
    id: 'parallel-pipeline',
    name: 'parallel_pipeline',
    description:
      'Fan-out / gather template using ParallelAgent + SequentialAgent.',
    entry: 'agents/parallel-pipeline/agent.ts',
  },
] as const;

export function getAgentManifest(id: string): AgentManifest | undefined {
  return agentRegistry.find((agent) => agent.id === id);
}
