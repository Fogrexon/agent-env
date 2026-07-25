import { LlmAgent } from '@google/adk';
import {
  createGuardedTool,
  defaultCursorModelRef,
  defaultGeminiModelRef,
  defineAgent,
  resolveModel,
  selectModelRef,
  type AgentBuildContext,
} from '@agent-env/harness';
import { z } from 'zod';

/**
 * Phase A sample: bounded ACI-style tools with risk classes.
 * echo_note = T0 (auto), propose_publish = T2 (requires approval → denied by default).
 *
 * Demonstrates research-aligned harness usage via RunSpec.
 * Final answer must be JSON matching agents/runspec-demo/schemas/result.schema.json.
 */
export const agentDefinition = defineAgent({
  id: 'runspec-demo',
  name: 'RunSpec Demo',
  description:
    'Phase A demo agent for RunSpec + independent verification + guarded tools.',
  createAgent(_context: AgentBuildContext) {
    const echoNote = createGuardedTool({
      contract: {
        name: 'echo_note',
        version: '1.0',
        riskClass: 'T0',
        sideEffect: 'none',
        idempotency: 'supported',
      },
      description: 'Echo a short note back (read-only / no side effect).',
      parameters: z.object({
        note: z.string().max(200).describe('Short note to acknowledge'),
      }),
      execute: ({ note }) => ({
        status: 'success' as const,
        echoed: note,
      }),
    });

    const proposePublish = createGuardedTool({
      contract: {
        name: 'propose_publish',
        version: '1.0',
        riskClass: 'T2',
        sideEffect: 'irreversible',
        idempotency: 'required',
      },
      description:
        'Propose publishing content externally (T2 — denied without approve hook).',
      parameters: z.object({
        title: z.string(),
        body: z.string(),
      }),
      execute: ({ title }) => ({
        status: 'published' as const,
        title,
      }),
      // No approve → policy_denied (fail closed for T2).
    });

    return new LlmAgent({
      name: 'runspec_demo',
      model: resolveModel(
        selectModelRef(defaultCursorModelRef(), defaultGeminiModelRef()),
      ),
      description:
        'Phase A demo agent for RunSpec + independent verification + guarded tools.',
      instruction: `You are a concise demo agent for the agent-env Phase A harness.
1. Call echo_note once with a short note about the user's objective.
2. Do NOT call propose_publish (it is T2 and will be denied).
3. Finish with ONLY a JSON object (no markdown fence, no prose) matching:
{
  "status": "verified",
  "summary": "one short paragraph about the objective",
  "measured": ["at least two concrete harness metrics to measure for one run", "..."]
}
Keep summary under 80 words. measured items should be specific (budget, tool policy, verification, …).`,
      tools: [echoNote, proposePublish],
    });
  },
});
