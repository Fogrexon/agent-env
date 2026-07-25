import {
  defaultCursorModelRef,
  defineAgent,
  resolveModel,
  selectModelRef,
} from '@agent-env/harness';
import { DEFAULT_CURSOR_MODEL, DEFAULT_GEMINI_MODEL } from '@agent-env/shared';
import { LlmAgent } from '@google/adk';

/**
 * Minimal single-agent template on Cursor SDK.
 */
export const agentDefinition = defineAgent({
  id: 'hello',
  name: 'Hello',
  description:
    'Minimal single-agent greeting demo (Cursor SDK when configured).',
  createAgent() {
    const modelRef = selectModelRef(defaultCursorModelRef(), {
      provider: 'gemini',
      model: DEFAULT_GEMINI_MODEL,
    });
    return new LlmAgent({
      name: 'hello',
      model: resolveModel(modelRef),
      description: `Greets the user (provider=${modelRef.provider}, model=${modelRef.model || DEFAULT_CURSOR_MODEL}).`,
      instruction: `You are a concise assistant for the agent-env harness.
Greet briefly and explain that this demo runs via the Cursor SDK provider when CURSOR_API_KEY is set.`,
    });
  },
});
