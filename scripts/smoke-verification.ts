/**
 * Offline smoke for verification wired through executeAgentRun (no network / LLM):
 *   - required check pass → SUCCEEDED / outcome "passed"
 *   - advisory-only failure → COMPLETED (not-gated, not blocking)
 *   - required check fail → FAILED / outcome "failed"
 *   - limits.maxRepairs: required fails once then passes via a custom check
 *   - host required checks appended after the agent plan cannot be removed
 *     by a same-id, weaker-severity entry on the agent side
 *
 * Uses the same scripted LlmAgent pattern as scripts/smoke-execution-policy.ts.
 */
import {
  LlmAgent,
  createEvent,
  type Event,
  type InvocationContext,
} from '@google/adk';
import { executeAgentRun, verify } from '@agent-env/harness';
import {
  clearProviders,
  createGeminiProvider,
  registerProvider,
} from '@agent-env/llm';
import { verificationPlanSchema } from '@agent-env/shared';
import type { AgentExecutionLimits, VerificationPlan } from '@agent-env/shared';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

clearProviders();
registerProvider(createGeminiProvider({ apiKey: 'offline-smoke' }));

type Script = (
  self: ScriptedAgent,
  ctx: InvocationContext,
) => AsyncGenerator<Event, void, void>;

class ScriptedAgent extends LlmAgent {
  readonly #script: Script;

  constructor(config: { name: string; script: Script }) {
    super({
      name: config.name,
      model: 'gemini:gemini-3.6-flash',
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

function baseLimits(
  overrides: Partial<AgentExecutionLimits> = {},
): AgentExecutionLimits {
  return {
    maxSteps: overrides.maxSteps ?? 20,
    maxToolCalls: overrides.maxToolCalls ?? 40,
    maxWallSeconds: overrides.maxWallSeconds ?? 120,
    maxRepairs: overrides.maxRepairs ?? 0,
    maxSubagentDepth: overrides.maxSubagentDepth ?? 3,
  };
}

function agentThatSays(name: string, text: string): ScriptedAgent {
  return new ScriptedAgent({
    name,
    script: async function* (self, ctx) {
      yield textEvent(self.name, ctx.invocationId, text);
    },
  });
}

// --- 1. required check pass → SUCCEEDED ---------------------------------------
{
  const agent = agentThatSays('scripted_pass', 'the answer is verified');
  const result = await executeAgentRun({
    agent,
    agentId: 'verify-pass',
    objective: 'offline smoke objective',
    limits: baseLimits(),
    verification: { checks: [verify.contains({ text: 'verified' })] },
  });
  assert(
    result.record.state === 'SUCCEEDED',
    `required pass run: ${result.record.state} (${result.record.error})`,
  );
  assert(
    result.record.verification?.outcome === 'passed',
    'verification outcome passed',
  );
  console.log('✓ required check pass → SUCCEEDED');
}

// --- 2. advisory-only failure → COMPLETED / not blocking -----------------------
{
  const agent = agentThatSays('scripted_advisory', 'no rainbows here');
  const result = await executeAgentRun({
    agent,
    agentId: 'verify-advisory',
    objective: 'offline smoke objective',
    limits: baseLimits(),
    verification: {
      checks: [verify.contains({ text: 'unicorn', severity: 'advisory' })],
    },
  });
  assert(
    result.record.state === 'COMPLETED',
    `advisory-only run: ${result.record.state} (${result.record.error})`,
  );
  assert(
    result.record.verification?.outcome === 'not-gated',
    'advisory-only failure is not-gated',
  );
  assert(
    result.record.verification?.checks.some((c) => !c.passed),
    'advisory check recorded as failed but did not block',
  );
  console.log('✓ advisory-only failure → COMPLETED (not blocking)');
}

// --- 3. required check fail → FAILED -------------------------------------------
{
  const agent = agentThatSays('scripted_fail', 'nothing to see here');
  const result = await executeAgentRun({
    agent,
    agentId: 'verify-fail',
    objective: 'offline smoke objective',
    limits: baseLimits({ maxRepairs: 0 }),
    verification: { checks: [verify.contains({ text: 'verified' })] },
  });
  assert(
    result.record.state === 'FAILED',
    `required fail run: ${result.record.state}`,
  );
  assert(
    result.record.verification?.outcome === 'failed',
    'verification outcome failed',
  );
  console.log('✓ required check fail → FAILED');
}

// --- 4. limits.maxRepairs: required fails once, then passes via custom check ---
{
  let attempt = 0;
  const agent = new ScriptedAgent({
    name: 'scripted_repair',
    script: async function* (self, ctx) {
      attempt += 1;
      yield textEvent(
        self.name,
        ctx.invocationId,
        attempt === 1 ? 'first draft (incomplete)' : 'fixed on retry',
      );
    },
  });

  const result = await executeAgentRun({
    agent,
    agentId: 'verify-repair',
    objective: 'offline smoke objective',
    limits: baseLimits({ maxRepairs: 1 }),
    verification: {
      checks: [verify.custom({ id: 'attempt-check', verifierId: 'attemptCheck' })],
    },
    verifyContext: {
      custom: {
        attemptCheck: () => attempt >= 2,
      },
    },
  });

  assert(
    result.record.state === 'SUCCEEDED',
    `repair run: ${result.record.state} (${result.record.error})`,
  );
  assert(attempt === 2, `agent should run twice, ran ${attempt}`);
  assert(
    result.record.verification?.outcome === 'passed',
    'verification passed after repair',
  );
  const states = result.events
    .filter((e) => e.eventType === 'run.state_changed')
    .map((e) => e.payload['to']);
  assert(states.includes('REPAIRING'), 'REPAIRING state visited');
  console.log('✓ limits.maxRepairs: required fails once then passes');
}

// --- 5. host required checks cannot be removed by the agent plan ---------------
{
  // Mirrors the host-append merge in agents/dev-env/run-discovered-agent.ts:
  // effective plan = [...agentPlan.checks, ...hostPlan.checks]. The agent-side
  // plan tries to neutralize a host check id with a weaker (advisory) copy;
  // because checks are appended (not replaced/deduped by id), the host's
  // required copy still gates the run.
  const hostGuardId = 'host-guard';
  const agentPlan: VerificationPlan = verificationPlanSchema.parse({
    checks: [
      verify.contains({
        id: hostGuardId,
        text: 'host-approved',
        severity: 'advisory',
      }),
    ],
  });
  const hostPlan: VerificationPlan = verificationPlanSchema.parse({
    checks: [verify.contains({ id: hostGuardId, text: 'host-approved' })],
  });
  const effectivePlan: VerificationPlan = verificationPlanSchema.parse({
    checks: [...agentPlan.checks, ...hostPlan.checks],
  });
  assert(
    effectivePlan.checks.filter((c) => c.id === hostGuardId).length === 2,
    'host check appended alongside agent copy, not replaced',
  );
  assert(
    effectivePlan.checks.some(
      (c) => c.id === hostGuardId && c.severity === 'required',
    ),
    'host required severity survives the merge',
  );

  const failing = agentThatSays('scripted_host_guard_fail', 'not approved');
  const failingResult = await executeAgentRun({
    agent: failing,
    agentId: 'verify-host-guard',
    objective: 'offline smoke objective',
    limits: baseLimits(),
    verification: effectivePlan,
  });
  assert(
    failingResult.record.state === 'FAILED',
    `host guard should still gate: ${failingResult.record.state}`,
  );

  const passing = agentThatSays('scripted_host_guard_pass', 'host-approved');
  const passingResult = await executeAgentRun({
    agent: passing,
    agentId: 'verify-host-guard',
    objective: 'offline smoke objective',
    limits: baseLimits(),
    verification: effectivePlan,
  });
  assert(
    passingResult.record.state === 'SUCCEEDED',
    `host guard should pass once satisfied: ${passingResult.record.state}`,
  );
  console.log('✓ host required checks cannot be removed by the agent plan');
}

console.log('✓ smoke-verification passed');
