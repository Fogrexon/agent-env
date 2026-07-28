import { LlmAgent } from '@google/adk';
import {
  createEmitHandoffTool,
  createGuardedTool,
  defaultCursorModelRef,
  defaultGeminiModelRef,
  defineAgent,
  resolveModel,
  selectModelRef,
  shapeObservation,
  type AgentBuildContext,
} from '@agent-env/harness';
import { z } from 'zod';

const RESULT_SCHEMA_ID = 'artifact://schemas/runspec-demo-result-v1';

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
  id: 'runspec-demo',
  name: 'RunSpec Demo',
  description:
    'RunSpec + verifier + guarded tools + typed result handoff + bounded observations.',
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
      fromAgent: 'runspec_demo',
      toAgent: 'verifier',
      outputSchema: RESULT_SCHEMA_ID,
      payloadSchema: resultPayloadSchema,
      defaultObjective: 'Typed final result for EvaluationSpec',
      doneCriteria: [
        'status is verified',
        'summary mentions propose_publish outcome',
        'measured has ≥2 concrete items',
      ],
    });

    return new LlmAgent({
      name: 'runspec_demo',
      model: resolveModel(
        selectModelRef(defaultCursorModelRef(), defaultGeminiModelRef()),
      ),
      description:
        'RunSpec demo with bounded observations and typed result handoff.',
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
