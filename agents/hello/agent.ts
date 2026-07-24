import { LlmAgent } from '@google/adk';
import {
  bootstrapProvidersFromEnv,
  createTypedTool,
  defaultGeminiModelRef,
  loadDotEnv,
  resolveModel,
} from '@agent-env/harness';
import { z } from 'zod';

loadDotEnv();
bootstrapProvidersFromEnv();

/**
 * Example of LLM-outside script integration via a typed FunctionTool.
 * Replace `execute` with any Node-side logic (HTTP, DB, CLI, etc.).
 */
const getWorkspaceClock = createTypedTool({
  name: 'get_workspace_clock',
  description: 'Returns the current ISO timestamp and timezone offset for the host.',
  parameters: z.object({
    label: z
      .string()
      .describe('Short label to include in the report, e.g. "standup".'),
  }),
  execute: ({ label }) => {
    const now = new Date();
    return {
      status: 'success' as const,
      label,
      iso: now.toISOString(),
      timezoneOffsetMinutes: now.getTimezoneOffset(),
    };
  },
});

/**
 * Minimal single-agent template.
 * Uses Gemini via resolveModel (native ADK Gemini keeps FunctionTools working).
 * Required export for ADK CLI / web: `rootAgent`.
 */
export const rootAgent = new LlmAgent({
  name: 'hello',
  model: resolveModel(defaultGeminiModelRef()),
  description: 'Greets the user and can read the host clock via a script tool.',
  instruction: `You are a concise assistant for the agent-env harness.
When the user asks about the current time or clock, call get_workspace_clock.
Otherwise greet briefly and explain you can check the host clock.`,
  tools: [getWorkspaceClock],
});
