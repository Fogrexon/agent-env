import {
  isBaseTool,
  isLlmAgent,
  type BaseAgent,
  type BaseTool,
  type InstructionProvider,
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
   * Pre-execution gate for allowed tools (budget, stop conditions, …).
   * Return a denial reason to block the call (fail closed); the tool then
   * responds `{ status: 'policy_denied', message }` without executing.
   */
  gate?: (info: ToolCallInfo) => string | undefined;
  onToolDenied?: (info: ToolCallInfo & { reason: string }) => void;
  onToolStarted?: (info: ToolCallInfo) => void;
  onToolCompleted?: (info: ToolCallInfo & { durationMs: number }) => void;
  onToolFailed?: (info: ToolCallInfo & { durationMs: number; error: string }) => void;
}

export interface ApplyRunSpecToolPolicyOptions {
  /** Root agent; the policy is applied to every LlmAgent in the tree. */
  agent: BaseAgent;
  /**
   * RunSpec `tools.allow` names. Fail closed: tools not listed here never
   * execute, but stay visible as denial stubs so the model learns why.
   */
  allow: readonly { name: string }[];
  hooks?: ToolPolicyHooks;
}

export interface AppliedToolPolicy {
  /** Tools that may execute (wrapped with the gateway). */
  exposed: Array<{ agent: string; tool: string }>;
  /**
   * Tools blocked by the allowlist. They remain callable and return
   * `policy_denied` with an explicit reason (not silently stripped).
   */
  removed: Array<{ agent: string; tool: string }>;
  /** Restore the original tool lists / instructions (module-level agents stay reusable). */
  restore: () => void;
}

export const RUNSPEC_ALLOWLIST_DENIAL =
  'not in RunSpec tools.allow — execution blocked for this run';

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
 * Keep a disallowed tool visible to the model, but never execute it.
 * Calling it returns a structured policy_denied payload the LLM can report.
 */
function wrapToolAsAllowlistDenied(
  tool: BaseTool,
  agentName: string,
  reason: string,
  hooks: ToolPolicyHooks,
): BaseTool {
  const annotatedDescription = `[POLICY BLOCKED: ${reason}] ${tool.description}`;
  const runAsync = async (): Promise<unknown> => {
    hooks.onToolDenied?.({
      agentName,
      toolName: tool.name,
      reason,
    });
    return {
      status: 'policy_denied',
      tool: tool.name,
      reason: 'not_in_allowlist',
      message: `Tool "${tool.name}" is blocked: ${reason}. Do not invent results for this tool; report the policy denial.`,
    };
  };

  return new Proxy(tool, {
    get(target, prop) {
      if (prop === 'runAsync') return runAsync;
      if (prop === 'description') return annotatedDescription;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function withPolicyInstructionNotice(
  current: string | InstructionProvider,
  blocked: Array<{ tool: string; reason: string }>,
): string | InstructionProvider {
  if (blocked.length === 0) return current;

  const notice = [
    '',
    '[Harness RunSpec policy]',
    'These tools are registered on this agent but BLOCKED for this run.',
    'Calling them returns { status: "policy_denied", message, reason } — do NOT invent results; report the denial.',
    ...blocked.map((b) => `- ${b.tool}: ${b.reason}`),
  ].join('\n');

  if (typeof current === 'function') {
    return async (ctx) => {
      const base = await current(ctx);
      return `${base}\n${notice}`;
    };
  }
  return `${current}${notice}`;
}

/**
 * Enforce RunSpec `tools.allow` on an agent tree (research §6.1/§6.3):
 * the spec — not the agent implementation — decides which tools may execute.
 *
 * Fail closed for execution: tools whose name is not in the allowlist never
 * run. They stay exposed as denial stubs (+ an instruction notice) so the
 * model is told *why* instead of silently losing the tool and hallucinating.
 * Toolsets that cannot be allowlist-checked are still stripped.
 *
 * Call `restore()` after the run; agents are module-level singletons.
 */
export function applyRunSpecToolPolicy(
  options: ApplyRunSpecToolPolicyOptions,
): AppliedToolPolicy {
  const allowNames = new Set(options.allow.map((t) => t.name));
  const hooks = options.hooks ?? {};
  const exposed: AppliedToolPolicy['exposed'] = [];
  const removed: AppliedToolPolicy['removed'] = [];
  const originals: Array<{
    agent: LlmAgent;
    tools: ToolUnion[];
    instruction: string | InstructionProvider;
  }> = [];

  for (const agent of collectLlmAgents(options.agent)) {
    if (!isLlmAgent(agent)) continue;
    const llmAgent = agent;
    const next: ToolUnion[] = [];
    const blockedForAgent: Array<{ tool: string; reason: string }> = [];
    let changed = false;

    for (const entry of llmAgent.tools) {
      if (!isBaseTool(entry)) {
        // Toolsets cannot be checked against the allowlist without a
        // context — fail closed and strip them.
        removed.push({ agent: agent.name, tool: '(toolset)' });
        blockedForAgent.push({
          tool: '(toolset)',
          reason:
            'toolset stripped — cannot verify against RunSpec tools.allow',
        });
        changed = true;
        continue;
      }
      if (!allowNames.has(entry.name)) {
        removed.push({ agent: agent.name, tool: entry.name });
        blockedForAgent.push({
          tool: entry.name,
          reason: RUNSPEC_ALLOWLIST_DENIAL,
        });
        next.push(
          wrapToolAsAllowlistDenied(
            entry,
            agent.name,
            RUNSPEC_ALLOWLIST_DENIAL,
            hooks,
          ),
        );
        changed = true;
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
        instruction: llmAgent.instruction,
      });
      llmAgent.tools = next;
      llmAgent.instruction = withPolicyInstructionNotice(
        llmAgent.instruction,
        blockedForAgent,
      );
    }
  }

  return {
    exposed,
    removed,
    restore: () => {
      for (const { agent, tools, instruction } of originals) {
        agent.tools = tools;
        agent.instruction = instruction;
      }
    },
  };
}
