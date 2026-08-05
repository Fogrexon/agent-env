import { AgentTool, type BaseAgent, type BaseTool } from '@google/adk';
import type { AgentBuildContext } from '../agent-definition.js';

export interface TrackedAgentToolMeta {
  agent: BaseAgent;
  agentName: string;
  definitionId?: string;
}

const META = new WeakMap<BaseTool, TrackedAgentToolMeta>();

export function getTrackedAgentToolMeta(
  tool: BaseTool,
): TrackedAgentToolMeta | undefined {
  return META.get(tool);
}

export interface CreateTrackedAgentToolOptions {
  agent: BaseAgent;
  /** Optional discovered agent definition id for graph labels. */
  definitionId?: string;
  skipSummarization?: boolean;
}

/**
 * Wrap an ADK AgentTool so graph inspectors can see the child agent
 * (ADK keeps `agent` private on AgentTool).
 */
export function createTrackedAgentTool(
  options: CreateTrackedAgentToolOptions,
): AgentTool {
  const tool = new AgentTool({
    agent: options.agent,
    skipSummarization: options.skipSummarization,
  });
  META.set(tool, {
    agent: options.agent,
    agentName: options.agent.name,
    ...(options.definitionId ? { definitionId: options.definitionId } : {}),
  });
  return tool;
}

export interface CreateSubagentToolOptions {
  /** Discovered agent definition id (= `agents/<id>/` directory name). */
  id: string;
  /** Optional AgentParams inputs forwarded into the child `createAgent`. */
  inputs?: Readonly<Record<string, unknown>>;
  /** Default true — return specialist output without an extra parent summary pass. */
  skipSummarization?: boolean;
}

/**
 * Load another discovered `agentDefinition` and expose it as an AgentTool.
 *
 * The child is a normal package under `agents/<id>/` — runnable alone via
 * `npm run run -- <id>`, and reusable here without copying its graph.
 *
 * ```ts
 * const investigator = await createSubagentTool(context, 'investigator');
 * return new LlmAgent({ tools: [investigator], ... });
 * ```
 */
export async function createSubagentTool(
  context: AgentBuildContext,
  options: CreateSubagentToolOptions | string,
): Promise<AgentTool> {
  const id = typeof options === 'string' ? options : options.id;
  const skipSummarization =
    typeof options === 'string' ? true : (options.skipSummarization ?? true);
  const inputs = typeof options === 'string' ? undefined : options.inputs;

  if (!context.buildSubagent) {
    throw new Error(
      'createSubagentTool requires context.buildSubagent (run via runDiscoveredAgent / admin)',
    );
  }

  const agent = await context.buildSubagent(
    id,
    inputs ? { inputs } : undefined,
  );
  return createTrackedAgentTool({
    agent,
    definitionId: id,
    skipSummarization,
  });
}
