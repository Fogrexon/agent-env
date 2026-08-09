import {
  isBaseTool,
  isLlmAgent,
  type BaseAgent,
  type BaseTool,
  type LlmAgent,
  type ToolUnion,
} from '@google/adk';
import { collectLlmAgents } from './agent-tree.js';

/** Identity of one tool call routed through the gateway. */
export interface ToolCallInfo {
  agentName: string;
  toolName: string;
}

export interface ToolPolicyHooks {
  /**
   * Pre-execution gate (budget, stop conditions, …).
   * Return a denial reason to block the call (fail closed); the tool then
   * responds `{ status: 'policy_denied', message }` without executing.
   */
  gate?: (info: ToolCallInfo) => string | undefined;
  onToolDenied?: (info: ToolCallInfo & { reason: string }) => void;
  onToolStarted?: (info: ToolCallInfo) => void;
  onToolCompleted?: (info: ToolCallInfo & { durationMs: number }) => void;
  onToolFailed?: (info: ToolCallInfo & { durationMs: number; error: string }) => void;
}

export interface ApplyToolRuntimePolicyOptions {
  /** Root agent; the policy is applied to every LlmAgent in the tree. */
  agent: BaseAgent;
  hooks?: ToolPolicyHooks;
}

export interface AppliedToolPolicy {
  /** Tools wrapped with the gateway (all BaseTools on the tree). */
  exposed: Array<{ agent: string; tool: string }>;
  /** Restore the original tool lists (module-level agents stay reusable). */
  restore: () => void;
}

/**
 * Wrap one ADK tool so every `runAsync` goes through the gateway hooks.
 * Uses a Proxy so declaration building (`_getDeclaration`, `processLlmRequest`)
 * keeps working for both the ADK-native and the Cursor `customTools` paths.
 */
function wrapToolWithGateway(
  tool: BaseTool,
  agentName: string,
  hooks: ToolPolicyHooks,
): BaseTool {
  const runAsync = async (
    request: Parameters<BaseTool['runAsync']>[0],
  ): Promise<unknown> => {
    const info: ToolCallInfo = { agentName, toolName: tool.name };
    const denial = hooks.gate?.(info);
    if (denial) {
      hooks.onToolDenied?.({ ...info, reason: denial });
      return {
        status: 'policy_denied',
        tool: tool.name,
        reason: 'gateway_gate',
        message: denial,
      };
    }
    hooks.onToolStarted?.(info);
    const startedAt = Date.now();
    try {
      const result = await tool.runAsync(request);
      hooks.onToolCompleted?.({ ...info, durationMs: Date.now() - startedAt });
      return result;
    } catch (err) {
      hooks.onToolFailed?.({
        ...info,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  return new Proxy(tool, {
    get(target, prop) {
      if (prop === 'runAsync') return runAsync;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * Wrap every BaseTool on an agent tree with the runtime gateway (budget / events).
 * Does not strip or allowlist tools — host budget / maxToolCalls still apply.
 *
 * Call `restore()` after the run; agents are module-level singletons.
 */
export function applyToolRuntimePolicy(
  options: ApplyToolRuntimePolicyOptions,
): AppliedToolPolicy {
  const hooks = options.hooks ?? {};
  const exposed: AppliedToolPolicy['exposed'] = [];
  const originals: Array<{
    agent: LlmAgent;
    tools: ToolUnion[];
  }> = [];

  for (const agent of collectLlmAgents(options.agent)) {
    if (!isLlmAgent(agent)) continue;
    const llmAgent = agent;
    const next: ToolUnion[] = [];
    let changed = false;

    for (const entry of llmAgent.tools) {
      if (!isBaseTool(entry)) {
        // Toolsets cannot be wrapped without a context — leave as-is.
        next.push(entry);
        continue;
      }
      exposed.push({ agent: agent.name, tool: entry.name });
      next.push(wrapToolWithGateway(entry, agent.name, hooks));
      changed = true;
    }

    if (changed) {
      originals.push({
        agent: llmAgent,
        tools: llmAgent.tools,
      });
      llmAgent.tools = next;
    }
  }

  return {
    exposed,
    restore: () => {
      for (const { agent, tools } of originals) {
        agent.tools = tools;
      }
    },
  };
}
