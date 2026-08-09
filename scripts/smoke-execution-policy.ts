/**
 * Offline smoke for host execution policy wired in executeAgentRun (no network / LLM):
 *   - applyToolRuntimePolicy gateway (gate / deny / restore)
 *   - limits.maxToolCalls → hard stop at the tool gateway (BUDGET_EXHAUSTED)
 *   - limits.maxSteps → bounded agent loop (FAILED)
 *   - successful agent completion → COMPLETED
 *   - describeAgentGraph / assertGraphModelsResolvable
 *   - ADK provider:model routing via registerAdkLlmRouting
 *
 * Uses a scripted LlmAgent whose runAsyncImpl never calls a model; a
 * dummy-key Gemini provider satisfies materialize / routing assertions.
 */
import {
  LlmAgent,
  createEvent,
  type BaseAgent,
  type BaseTool,
  type Event,
  type InvocationContext,
} from '@google/adk';
import {
  applyToolRuntimePolicy,
  assertGraphModelsResolvable,
  createGuardedTool,
  describeAgentGraph,
  executeAgentRun,
} from '@agent-env/harness';
import {
  clearAdkLlmRouting,
  clearProviders,
  createGeminiProvider,
  formatModelRef,
  materializeAgentModel,
  parseProviderModelId,
  registerAdkLlmRouting,
  registerProvider,
  resolveModel,
} from '@agent-env/llm';
import type { AgentExecutionLimits, RunEvent } from '@agent-env/shared';
import { z } from 'zod';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

clearProviders();
registerProvider(createGeminiProvider({ apiKey: 'offline-smoke' }));

type Script = (
  self: ScriptedAgent,
  ctx: InvocationContext,
) => AsyncGenerator<Event, void, void>;

/** LlmAgent whose run is scripted — tools still flow through agent.tools. */
class ScriptedAgent extends LlmAgent {
  readonly #script: Script;

  constructor(config: { name: string; tools?: BaseTool[]; script: Script }) {
    super({
      name: config.name,
      model: 'gemini:gemini-3.6-flash',
      tools: config.tools ?? [],
    });
    this.#script = config.script;
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.#script(this, ctx);
  }
}

function textEvent(author: string, invocationId: string, text: string): Event {
  return createEvent({
    invocationId,
    author,
    content: { role: 'model', parts: [{ text }] },
  });
}

function makeNoteTool(): BaseTool {
  return createGuardedTool({
    contract: { name: 'note', riskClass: 'T0' },
    description: 'Record a note',
    parameters: z.object({ text: z.string() }),
    execute: ({ text }) => ({ status: 'success', noted: text }),
  });
}

function baseLimits(
  overrides: Partial<AgentExecutionLimits> = {},
): AgentExecutionLimits {
  return {
    maxSteps: overrides.maxSteps ?? 20,
    maxToolCalls: overrides.maxToolCalls ?? 40,
    maxWallSeconds: overrides.maxWallSeconds ?? 120,
    maxSubagentDepth: overrides.maxSubagentDepth ?? 3,
  };
}

function runSmoke(options: {
  agent: BaseAgent;
  agentId: string;
  limits: AgentExecutionLimits;
}): Promise<Awaited<ReturnType<typeof executeAgentRun>>> {
  return executeAgentRun({
    agent: options.agent,
    agentId: options.agentId,
    objective: 'offline smoke objective',
    limits: options.limits,
  });
}

const toolCtx = {} as Parameters<BaseTool['runAsync']>[0]['toolContext'];

function eventTypes(events: readonly RunEvent[]): string[] {
  return events.map((e) => e.eventType);
}

// --- 1. applyToolRuntimePolicy: gate + restore --------------------------------
{
  const note = makeNoteTool();
  const agent = new ScriptedAgent({
    name: 'scripted',
    tools: [note],
    script: async function* () {
      // never run
    },
  });
  let deniedReason = '';
  const policy = applyToolRuntimePolicy({
    agent,
    hooks: {
      gate: ({ toolName }) => {
        deniedReason = `blocked:${toolName}`;
        return deniedReason;
      },
    },
  });
  assert(policy.exposed.length === 1, 'note wrapped');
  assert(policy.exposed[0]?.tool === 'note', 'exposed note');
  const denied = (await (agent.tools as BaseTool[])[0]!.runAsync({
    args: { text: 'x' },
    toolContext: toolCtx,
  })) as { status?: string; message?: string };
  assert(denied.status === 'policy_denied', 'gate denies execution');
  assert(
    (denied.message ?? '').includes('blocked:note'),
    `denial message: ${denied.message}`,
  );
  assert(deniedReason === 'blocked:note', 'gate invoked');
  policy.restore();
  const restored = (await (agent.tools as BaseTool[])[0]!.runAsync({
    args: { text: 'ok' },
    toolContext: toolCtx,
  })) as { status?: string; noted?: string };
  assert(restored.status === 'success', 'restore puts original tool back');
  console.log('✓ applyToolRuntimePolicy gate + restore');
}

// --- 2. limits.maxToolCalls: hard stop at the gateway -------------------------
{
  let thirdCall: { status?: string } = {};
  const agent = new ScriptedAgent({
    name: 'scripted',
    tools: [makeNoteTool()],
    script: async function* (self, ctx) {
      const tool = (self.tools as BaseTool[])[0]!;
      await tool.runAsync({ args: { text: '1' }, toolContext: toolCtx });
      await tool.runAsync({ args: { text: '2' }, toolContext: toolCtx });
      thirdCall = (await tool.runAsync({
        args: { text: '3' },
        toolContext: toolCtx,
      })) as { status?: string };
      yield textEvent(self.name, ctx.invocationId, 'should not matter');
    },
  });

  const result = await runSmoke({
    agent,
    agentId: 'budget',
    limits: baseLimits({ maxToolCalls: 2 }),
  });

  assert(
    result.record.state === 'BUDGET_EXHAUSTED',
    `budget run: ${result.record.state} (${result.record.error})`,
  );
  assert(thirdCall.status === 'policy_denied', 'third call denied at gateway');
  assert(
    eventTypes(result.events).includes('budget.exhausted'),
    'budget.exhausted emitted',
  );
  assert(result.record.budgetConsumed.toolCalls === 3, 'tool calls counted');
  console.log('✓ limits.maxToolCalls hard stop');
}

// --- 3. limits.maxSteps: bounded agent loop -----------------------------------
{
  const agent = new ScriptedAgent({
    name: 'scripted',
    script: async function* (self, ctx) {
      for (let i = 0; i < 5; i += 1) {
        yield textEvent(self.name, ctx.invocationId, `step ${i}`);
      }
    },
  });

  const result = await runSmoke({
    agent,
    agentId: 'steps',
    limits: baseLimits({ maxSteps: 2 }),
  });

  assert(
    result.record.state === 'FAILED',
    `maxSteps run: ${result.record.state}`,
  );
  assert(
    (result.record.error ?? '').includes('maxSteps'),
    `maxSteps error surfaced: ${result.record.error}`,
  );
  console.log('✓ limits.maxSteps bounded loop');
}

// --- 4. successful completion → COMPLETED -------------------------------------
{
  const agent = new ScriptedAgent({
    name: 'scripted',
    script: async function* (self, ctx) {
      yield textEvent(self.name, ctx.invocationId, 'done');
    },
  });

  const result = await runSmoke({
    agent,
    agentId: 'completed',
    limits: baseLimits(),
  });

  assert(
    result.record.state === 'COMPLETED',
    `completed run: ${result.record.state} (${result.record.error})`,
  );
  console.log('✓ successful agent completion → COMPLETED');
}

// --- 5. graph helpers ---------------------------------------------------------
{
  const agent = new ScriptedAgent({
    name: 'graph_agent',
    tools: [makeNoteTool()],
    script: async function* () {
      // unused
    },
  });
  const graph = describeAgentGraph(agent, { agentId: 'graph-smoke' });
  assert(graph.agentId === 'graph-smoke', 'agentId stamped');
  assert(
    graph.nodes.some((n) => n.model === 'gemini:gemini-3.6-flash'),
    'model on graph',
  );
  assertGraphModelsResolvable(graph);
  console.log('✓ describeAgentGraph / assertGraphModelsResolvable');
}

// --- 6. materializeAgentModel + ADK provider:model routing --------------------
{
  registerAdkLlmRouting();
  const wired = formatModelRef({
    provider: 'gemini',
    model: 'gemini-3.6-flash',
  });
  assert(wired === 'gemini:gemini-3.6-flash', 'formatModelRef');
  assert(
    parseProviderModelId(wired).model === 'gemini-3.6-flash',
    'parseProviderModelId',
  );
  const asInstance = materializeAgentModel(wired);
  assert(typeof asInstance.model === 'string', 'materialized has model id');
  assert(
    asInstance.model.includes('gemini') ||
      (asInstance as { providerId?: string }).providerId === 'gemini',
    'materialized gemini provider',
  );
  const already = resolveModel({
    provider: 'gemini',
    model: 'gemini-3.6-flash',
  });
  assert(materializeAgentModel(already) === already, 'BaseLlm passthrough');
  clearAdkLlmRouting();
  console.log('✓ materializeAgentModel + ADK routing helpers');
}

console.log('✓ smoke-execution-policy passed');
