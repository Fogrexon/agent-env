/**
 * Offline smoke for RunSpec enforcement wired in runFromSpec (no network / LLM):
 *   - spec.tools.allow → fail-closed execution via denial stubs + gateway events
 *   - spec.budget.maxToolCalls → hard stop at the tool gateway (BUDGET_EXHAUSTED)
 *   - spec.harness.maxSteps → bounded agent loop (FAILED)
 *   - spec.harness.maxRepairs → verify → repair → re-run loop (SUCCEEDED)
 *
 * Uses a scripted LlmAgent whose runAsyncImpl never calls a model; a
 * dummy-key Gemini provider satisfies the provider-configured assertion.
 */
import {
  LlmAgent,
  SequentialAgent,
  createEvent,
  type BaseAgent,
  type BaseTool,
  type Event,
  type InvocationContext,
} from '@google/adk';
import {
  applyRunSpecOverrides,
  applyRunSpecToolPolicy,
  createGuardedTool,
  parseEvaluationSpec,
  runFromSpec,
  withAgentModel,
} from '@agent-env/harness';
import {
  clearProviders,
  createGeminiProvider,
  registerProvider,
  resolveModel,
} from '@agent-env/llm';
import type { RunEvent } from '@agent-env/shared';
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
    super({ name: config.name, tools: config.tools ?? [] });
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

function makeTools(): { note: BaseTool; secret: BaseTool } {
  return {
    note: createGuardedTool({
      contract: { name: 'note', riskClass: 'T0' },
      description: 'Record a note',
      parameters: z.object({ text: z.string() }),
      execute: ({ text }) => ({ status: 'success', noted: text }),
    }),
    secret: createGuardedTool({
      contract: { name: 'secret', riskClass: 'T0' },
      description: 'Should never be exposed',
      parameters: z.object({}),
      execute: () => ({ status: 'success' }),
    }),
  };
}

function baseSpec(overrides: {
  taskId: string;
  maxSteps?: number;
  maxRepairs?: number;
  maxToolCalls?: number;
}): unknown {
  return {
    metadata: { tenantId: 'smoke' },
    spec: {
      task: {
        taskId: overrides.taskId,
        objective: 'offline smoke objective',
      },
      harness: {
        maxSteps: overrides.maxSteps ?? 20,
        maxRepairs: overrides.maxRepairs ?? 0,
      },
      model: { primary: { provider: 'gemini', model: 'gemini-3.6-flash' } },
      tools: { allow: [{ name: 'note' }] },
      budget: {
        maxToolCalls: overrides.maxToolCalls ?? 40,
        maxWallSeconds: 120,
      },
      evaluation: { ref: './evaluation.json' },
    },
  };
}

const smokeEvaluation = {
  metadata: { id: 'smoke-contains', version: '1' },
  graders: [
    {
      id: 'contains',
      kind: 'deterministic' as const,
      ref: 'grader://contains/v1',
      config: { text: 'verified' },
    },
  ],
  acceptance: {
    all: [{ id: 'a', grader: 'contains', assertion: 'contains-verified' }],
  },
};

function runSmoke(options: {
  spec: unknown;
  agent: BaseAgent;
}): Promise<Awaited<ReturnType<typeof runFromSpec>>> {
  return runFromSpec({
    ...options,
    evaluation: parseEvaluationSpec(smokeEvaluation),
  });
}

const toolCtx = {} as Parameters<BaseTool['runAsync']>[0]['toolContext'];

function eventTypes(events: readonly RunEvent[]): string[] {
  return events.map((e) => e.eventType);
}

// --- 1. tools.allow: fail-closed execution + denial stubs + restore -----
{
  const tools = makeTools();
  let secretDenial: { status?: string; message?: string; reason?: string } = {};
  const agent = new ScriptedAgent({
    name: 'scripted',
    tools: [tools.note, tools.secret],
    script: async function* (self, ctx) {
      const exposed = self.tools as BaseTool[];
      assert(exposed.length === 2, 'blocked tools stay visible as denial stubs');
      const note = exposed.find((t) => t.name === 'note');
      const secret = exposed.find((t) => t.name === 'secret');
      assert(note, 'note tool present');
      assert(secret, 'secret tool present as denial stub');
      assert(
        String(self.instruction).includes('secret'),
        'instruction should name the blocked tool',
      );
      assert(
        String(secret.description).includes('POLICY BLOCKED'),
        'blocked tool description should announce policy',
      );
      secretDenial = (await secret.runAsync({
        args: {},
        toolContext: toolCtx,
      })) as typeof secretDenial;
      assert(secretDenial.status === 'policy_denied', 'secret must not execute');
      assert(
        (secretDenial.message ?? '').includes('tools.allow'),
        `denial message should cite allowlist: ${secretDenial.message}`,
      );
      const result = (await note.runAsync({
        args: { text: 'hi' },
        toolContext: toolCtx,
      })) as { status: string; noted?: string };
      assert(result.status === 'success', 'allowed tool should execute');
      yield textEvent(self.name, ctx.invocationId, 'note ok — verified');
    },
  });

  const result = await runSmoke({
    spec: baseSpec({ taskId: 'allowlist' }),
    agent,
  });

  assert(result.record.state === 'SUCCEEDED', `allowlist run: ${result.record.state} (${result.record.error})`);
  const types = eventTypes(result.events);
  assert(types.includes('policy.evaluated'), 'policy.evaluated emitted');
  assert(types.includes('policy.denied'), 'policy.denied emitted for blocked tool');
  assert(types.includes('tool.started'), 'tool.started emitted');
  assert(types.includes('tool.completed'), 'tool.completed emitted');
  const denied = result.events.find((e) => e.eventType === 'policy.denied');
  assert(
    JSON.stringify(denied?.payload).includes('secret'),
    'secret tool should be reported as blocked',
  );
  assert(agent.tools.length === 2, 'original tool list restored after run');
  assert(
    !String(agent.instruction).includes('[Harness RunSpec policy]'),
    'policy instruction notice restored away',
  );
  console.log('✓ tools.allow fail-closed enforcement (denial stubs visible to LLM)');
}

// --- 2. budget.maxToolCalls: hard stop at the gateway ----------------------
{
  const tools = makeTools();
  let thirdCall: { status?: string } = {};
  const agent = new ScriptedAgent({
    name: 'scripted',
    tools: [tools.note],
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
    spec: baseSpec({ taskId: 'budget', maxToolCalls: 2 }),
    agent,
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
  console.log('✓ budget.maxToolCalls hard stop');
}

// --- 3. harness.maxSteps: bounded agent loop -------------------------------
{
  const agent = new ScriptedAgent({
    name: 'scripted',
    script: async function* (self, ctx) {
      for (let i = 0; i < 5; i += 1) {
        yield textEvent(self.name, ctx.invocationId, `step ${i} … verified`);
      }
    },
  });

  const result = await runSmoke({
    spec: baseSpec({ taskId: 'steps', maxSteps: 2 }),
    agent,
  });

  assert(
    result.record.state === 'FAILED',
    `maxSteps run: ${result.record.state}`,
  );
  assert(
    (result.record.error ?? '').includes('harness.maxSteps'),
    `maxSteps error surfaced: ${result.record.error}`,
  );
  console.log('✓ harness.maxSteps bounded loop');
}

// --- 4. harness.maxRepairs: verify → repair → re-run -----------------------
{
  let attempt = 0;
  let repairMessageSeen = false;
  const agent = new ScriptedAgent({
    name: 'scripted',
    script: async function* (self, ctx) {
      attempt += 1;
      const userText = JSON.stringify(ctx.userContent ?? {});
      if (attempt > 1 && userText.includes('failed independent verification')) {
        repairMessageSeen = true;
      }
      yield textEvent(
        self.name,
        ctx.invocationId,
        attempt === 1 ? 'first draft (incomplete)' : 'fixed — verified',
      );
    },
  });

  const result = await runSmoke({
    spec: baseSpec({ taskId: 'repair', maxRepairs: 1 }),
    agent,
  });

  assert(
    result.record.state === 'SUCCEEDED',
    `repair run: ${result.record.state} (${result.record.error})`,
  );
  assert(attempt === 2, `agent should run twice, ran ${attempt}`);
  assert(repairMessageSeen, 'repair attempt should receive failed checks');
  assert(result.record.verification?.passed === true, 'verification passed');
  const states = result.events
    .filter((e) => e.eventType === 'run.state_changed')
    .map((e) => e.payload['to']);
  assert(states.includes('REPAIRING'), 'REPAIRING state visited');
  console.log('✓ harness.maxRepairs repair loop');
}

// --- 5. applyRunSpecToolPolicy unit: empty allowlist denies everything -----
{
  const tools = makeTools();
  const agent = new ScriptedAgent({
    name: 'scripted',
    tools: [tools.note, tools.secret],
    script: async function* () {
      // never run
    },
  });
  const policy = applyRunSpecToolPolicy({ agent, allow: [] });
  assert(agent.tools.length === 2, 'empty allowlist keeps denial stubs visible');
  assert(policy.removed.length === 2, 'both tools reported blocked');
  assert(policy.exposed.length === 0, 'nothing executable');
  const denied = (await (agent.tools as BaseTool[])[0]!.runAsync({
    args: { text: 'x' },
    toolContext: toolCtx,
  })) as { status?: string; message?: string };
  assert(denied.status === 'policy_denied', 'empty allowlist denies execution');
  assert(
    String(agent.instruction).includes('[Harness RunSpec policy]'),
    'instruction notice present while policy applied',
  );
  policy.restore();
  const restoredCount: number = agent.tools.length;
  assert(restoredCount === 2, 'restore puts tools back');
  console.log('✓ empty allowlist fails closed (denial stubs)');
}

// --- 6. applyRunSpecOverrides merges into an effective RunSpec -------------
{
  const base = {
    spec: {
      task: {
        taskId: 't',
        objective: 'from-file',
      },
      model: {
        primary: { provider: 'gemini', model: 'gemini-3.6-flash' },
        allowed: [
          { provider: 'gemini', model: 'gemini-3.6-flash' },
          { provider: 'gemini', model: 'gemini-override' },
        ],
      },
      budget: { maxToolCalls: 5, maxWallSeconds: 60 },
      harness: { maxSteps: 5, maxRepairs: 0 },
      evaluation: { ref: './evaluation.json' },
    },
  };
  const effective = applyRunSpecOverrides(base, {
    objective: 'from-admin',
    model: { provider: 'gemini', model: 'gemini-override' },
  });
  assert(effective.spec.task.objective === 'from-admin', 'objective merged');
  assert(
    effective.spec.model.primary.model === 'gemini-override',
    'model.primary merged',
  );
  // Template-shaped fields untouched.
  assert(effective.spec.budget.maxToolCalls === 5, 'budget unchanged');
  let denied = false;
  try {
    applyRunSpecOverrides(base, {
      model: { provider: 'gemini', model: 'not-allowed' },
    });
  } catch {
    denied = true;
  }
  assert(denied, 'disallowed model rejected');
  console.log('✓ applyRunSpecOverrides builds effective RunSpec');
}

// --- 7. withAgentModel applies to nested LlmAgents under SequentialAgent -----
{
  const original = resolveModel({
    provider: 'gemini',
    model: 'gemini-3.6-flash',
  });
  const childA = new LlmAgent({ name: 'child_a', model: original });
  const childB = new LlmAgent({ name: 'child_b', model: original });
  const root = new SequentialAgent({
    name: 'seq_root',
    subAgents: [childA, childB],
  });
  const overrideRef = {
    provider: 'gemini' as const,
    model: 'gemini-override',
  };
  let boundDuring: unknown;
  await withAgentModel(root, overrideRef, async () => {
    boundDuring = childA.model;
    assert(childA.model === childB.model, 'both children share override');
    assert(childA.model !== original, 'child_a left original model');
  });
  assert(boundDuring !== undefined, 'withAgentModel ran');
  assert(childA.model === original, 'child_a restored');
  assert(childB.model === original, 'child_b restored');
  console.log('✓ withAgentModel walks SequentialAgent tree');
}

console.log('✓ smoke-spec-policy passed');
