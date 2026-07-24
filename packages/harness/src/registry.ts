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
    description: 'Minimal LlmAgent on Cursor SDK (Gemini fallback).',
    entry: 'agents/hello/agent.ts',
    models: [{ provider: 'cursor', model: 'composer-2' }],
  },
  {
    id: 'parallel-pipeline',
    name: 'parallel_pipeline',
    description:
      'Fan-out / gather with per-branch ModelRef (Cursor by default).',
    entry: 'agents/parallel-pipeline/agent.ts',
    models: [
      { provider: 'cursor', model: 'composer-2' },
      { provider: 'gemini', model: 'gemini-2.5-flash' },
      { provider: 'lm-studio', model: 'local-model' },
    ],
  },
  {
    id: 'runspec-demo',
    name: 'runspec_demo',
    description:
      'Phase A RunSpec demo: guarded tools (T0/T2), events, independent verifier (Gemini + FunctionTools).',
    entry: 'agents/runspec-demo/agent.ts',
    models: [{ provider: 'gemini', model: 'gemini-2.5-flash' }],
  },
  {
    id: 'collector',
    name: 'collector',
    description:
      'Multi-source collector: Gemini tool workers + Cursor synthesizer when configured.',
    entry: 'agents/collector/agent.ts',
    models: [
      { provider: 'gemini', model: 'gemini-2.5-flash' },
      { provider: 'cursor', model: 'composer-2' },
    ],
  },
] as const;

export function getAgentManifest(id: string): AgentManifest | undefined {
  return agentRegistry.find((agent) => agent.id === id);
}
