import type { BaseAgent } from '@google/adk';

/**
 * Host-injected construction services for `createAgent`.
 * Structured run inputs (from AgentParams) may be supplied so the agent can
 * select graph shape / models at build time (e.g. standard vs max mode).
 */
export interface AgentBuildContext {
  /** Repo root used by repo-local wiring and connector factories. */
  repoRoot: string;
  /** Read non-secret environment configuration supplied by the host. */
  config(name: string): string | undefined;
  /** Read a secret supplied by the host. Packages never read process.env. */
  secret(name: string): string | undefined;
  /**
   * Validated AgentParams values for this run (excludes objective projection).
   * Same keys land in ADK session state; optional here for graph construction.
   */
  inputs?: Readonly<Record<string, unknown>>;
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
