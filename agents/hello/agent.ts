import { LlmAgent } from '@google/adk';
import { defaultCursorModelRef, resolveModel, selectModelRef } from '@agent-env/harness';
import { DEFAULT_CURSOR_MODEL, DEFAULT_GEMINI_MODEL } from '@agent-env/shared';
import { bootstrapProvidersFromEnv, loadDotEnv } from '@agent-env/repo-env';

loadDotEnv();
bootstrapProvidersFromEnv();

/**
 * Minimal single-agent template on Cursor SDK.
 * (ADK FunctionTools still need a gemini provider — see runspec-demo / collector.)
 */
const modelRef = selectModelRef(defaultCursorModelRef(), {
  provider: 'gemini',
  model: DEFAULT_GEMINI_MODEL,
});

export const rootAgent = new LlmAgent({
  name: 'hello',
  model: resolveModel(modelRef),
  description: `Greets the user (provider=${modelRef.provider}, model=${modelRef.model || DEFAULT_CURSOR_MODEL}).`,
  instruction: `You are a concise assistant for the agent-env harness.
Greet briefly and explain that this demo runs via the Cursor SDK provider when CURSOR_API_KEY is set.`,
});
