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
      'Fan-out / gather with per-branch ModelRef (Gemini + Cursor when configured).',
    entry: 'agents/parallel-pipeline/agent.ts',
    models: [
      { provider: 'gemini', model: 'gemini-2.5-flash' },
      { provider: 'cursor', model: 'composer-2' },
      { provider: 'lm-studio', model: 'local-model' },
    ],
  },
] as const;

export function getAgentManifest(id: string): AgentManifest | undefined {
  return agentRegistry.find((agent) => agent.id === id);
}
