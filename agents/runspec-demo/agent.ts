import { LlmAgent } from '@google/adk';
import {
  createGuardedTool,
  defaultGeminiModelRef,
  resolveModel,
} from '@agent-env/harness';
import { z } from 'zod';
import { bootstrapProvidersFromEnv, loadDotEnv } from '@agent-env/repo-env';

loadDotEnv();
bootstrapProvidersFromEnv();

/**
 * Phase A sample: bounded ACI-style tools with risk classes.
 * echo_note = T0 (auto), propose_publish = T2 (requires approval → denied by default).
 */
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

/**
 * Demonstrates research-aligned harness usage via RunSpec (see scripts/run-spec.ts).
 * Agent instruction asks for a brief plan that includes the keyword "verified".
 */
export const rootAgent = new LlmAgent({
  name: 'runspec_demo',
  model: resolveModel(defaultGeminiModelRef()),
  description:
    'Phase A demo agent for RunSpec + independent verification + guarded tools.',
  instruction: `You are a concise demo agent for the agent-env Phase A harness.
1. Call echo_note once with a short note about the user's objective.
2. Do NOT call propose_publish (it is T2 and will be denied).
3. Finish with a short answer that includes the word "verified" and summarizes the objective.
Keep the final answer under 80 words.`,
  tools: [echoNote, proposePublish],
});
