import type { BaseAgent } from '@google/adk';
import type {
  AgentExecutionLimits,
  AgentExecutionLimitsInput,
  AgentMode,
} from '@agent-env/shared';

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
  /**
   * Build another discovered agent as a sub-agent graph.
   * Host (repo-env) injects discovery; packages never hold an agent registry.
   * Throws on unknown id, circular dependency, or depth overflow.
   */
  buildSubagent?(
    id: string,
    options?: { inputs?: Readonly<Record<string, unknown>> },
  ): Promise<BaseAgent>;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  /**
   * Host presentation / run shape.
   * - interactive: chat-style turns; tools/subagents bound the agent's purpose
   * - autonomous: batch / one-shot / scheduled jobs
   * Default when omitted: autonomous.
   */
  mode?: AgentMode;
  /** Soft limits; host policy takes the min per field. */
  limits?: Partial<AgentExecutionLimitsInput>;
  createAgent(context: AgentBuildContext): BaseAgent | Promise<BaseAgent>;
}

/** Resolve agent mode with autonomous as the default. */
export function resolveAgentMode(
  definition: Pick<AgentDefinition, 'mode'>,
): AgentMode {
  return definition.mode ?? 'autonomous';
}

export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return Object.freeze(definition);
}

export function mergeExecutionLimits(
  host: AgentExecutionLimits,
  agent?: Partial<AgentExecutionLimitsInput>,
): AgentExecutionLimits {
  if (!agent) return host;
  return {
    maxSteps: Math.min(host.maxSteps, agent.maxSteps ?? host.maxSteps),
    maxToolCalls: Math.min(
      host.maxToolCalls,
      agent.maxToolCalls ?? host.maxToolCalls,
    ),
    maxWallSeconds: Math.min(
      host.maxWallSeconds,
      agent.maxWallSeconds ?? host.maxWallSeconds,
    ),
    maxSubagentDepth: Math.min(
      host.maxSubagentDepth,
      agent.maxSubagentDepth ?? host.maxSubagentDepth,
    ),
  };
}
