import type { BaseAgent } from '@google/adk';

/** Static construction services. Per-run user input is intentionally absent. */
export interface AgentBuildContext {
  /** Repo root used by repo-local wiring and connector factories. */
  repoRoot: string;
  /** Read non-secret environment configuration supplied by the host. */
  config(name: string): string | undefined;
  /** Read a secret supplied by the host. Packages never read process.env. */
  secret(name: string): string | undefined;
}

/**
 * Pure agent graph definition. The host calls createAgent once per run so
 * mutable tool/workflow state cannot leak between concurrent invocations.
 */
export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  createAgent(context: AgentBuildContext): BaseAgent | Promise<BaseAgent>;
}

export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return Object.freeze(definition);
}
