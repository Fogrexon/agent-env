import { LlmAgent } from '@google/adk';
import {
  createEmitHandoffTool,
  createGuardedTool,
  defineAgent,
  isProviderConfigured,
  shapeObservation,
  verify,
  type AgentBuildContext,
} from '@agent-env/harness';
import { z } from 'zod';

const RESULT_SCHEMA_ID = 'artifact://schemas/harness-demo-result-v1';

const resultPayloadSchema = z.object({
  status: z.literal('verified'),
  summary: z.string().min(8).max(600),
  measured: z.array(z.string().min(1)).min(2),
});

/**
 * Phase A harness demo updated for working-environment contracts:
 * - echo_note returns a bounded observation shape
 * - emit_result_handoff mints a typed final payload (digest + schema)
 * - propose_publish remains T2 (approval / deny)
 */
export const agentDefinition = defineAgent({
  id: 'harness-demo',
  name: 'Harness Demo',
  description:
    'limits + verifier + guarded tools + typed result handoff + bounded observations.',
  mode: 'autonomous',
  limits: {
    maxSteps: 12,
    maxToolCalls: 20,
    maxWallSeconds: 180,
    maxRepairs: 1,
  },
  verification: {
    checks: [
      verify.jsonSchema({
        schemaRef: 'agents/harness-demo/schemas/result.schema.json',
      }),
    ],
  },
  createAgent(_context: AgentBuildContext) {
    const echoNote = createGuardedTool({
      contract: {
        name: 'echo_note',
        version: '1.0',
        riskClass: 'T0',
        sideEffect: 'none',
        idempotency: 'supported',
      },
      description: 'Echo a short note as a bounded observation (Loop plane).',
      parameters: z.object({
        note: z.string().max(200).describe('Short note to acknowledge'),
      }),
      execute: ({ note }) =>
        shapeObservation({
          status: note.trim() ? 'ok' : 'empty_success',
          content: { echoed: note },
          source: 'tool',
          toolName: 'echo_note',
          maxChars: 400,
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
        'Propose publishing content externally (T2 — needs run approval or approve hook).',
      parameters: z.object({
        title: z.string(),
        body: z.string(),
      }),
      execute: ({ title }) =>
        shapeObservation({
          status: 'ok',
          content: { status: 'published', title },
          source: 'tool',
          toolName: 'propose_publish',
        }),
    });

    const emitResult = createEmitHandoffTool({
      name: 'emit_result_handoff',
      fromAgent: 'harness_demo',
      toAgent: 'verifier',
      outputSchema: RESULT_SCHEMA_ID,
      payloadSchema: resultPayloadSchema,
      defaultObjective: 'Typed final result for verification',
      doneCriteria: [
        'status is verified',
        'summary mentions propose_publish outcome',
        'measured has ≥2 concrete items',
      ],
    });

    const model = isProviderConfigured('cursor')
      ? 'cursor:auto'
      : 'gemini:gemini-3.6-flash';

    return new LlmAgent({
      name: 'harness_demo',
      model,
      description:
        'Harness demo: bounded observations, T2 guard, typed result handoff, JSON Schema verify.',
      instruction: `You are a concise demo agent for agent-env (execution harness + working-environment contracts).
1. Call echo_note once with a short note about the user's objective.
2. Call propose_publish once (T2). Without host approval it returns policy_denied — expected; report it.
3. Call emit_result_handoff ONCE with payloadJson:
{
  "status": "verified",
  "summary": "≤80 words on the objective AND propose_publish outcome",
  "measured": ["at least two concrete harness metrics from this run", "..."]
}
4. FINAL assistant message MUST be the raw JSON of the \`artifact\` object returned by emit_result_handoff (not the markdown envelope, no prose).`,
      tools: [echoNote, proposePublish, emitResult],
    });
  },
});
