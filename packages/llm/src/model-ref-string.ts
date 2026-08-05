import {
  DEFAULT_MODEL_REF,
  formatModelRef,
  modelRefSchema,
  parseProviderModelId,
  providerModelIdSchema,
  type ModelRef,
  type ProviderModelId,
} from '@agent-env/shared';

export {
  formatModelRef,
  parseProviderModelId,
  providerModelIdSchema,
  type ProviderModelId,
};

/**
 * Parse a model string from CLI flags / JSON config.
 *
 * - JSON object (`{...}`) → {@link ModelRef}
 * - `provider:model` → {@link parseProviderModelId} (first colon splits)
 * - bare model id → `{ provider: 'gemini', model }` for **CLI backward compat only**
 *
 * Agent graphs should use `provider:model` strings (ADK LLMRegistry routing)
 * or an explicit {@link ModelRef} via {@link resolveModel}. Bare ids are not
 * valid wire format for agent packages.
 */
export function parseModelRef(
  raw: string | undefined | null,
  fallback: ModelRef = DEFAULT_MODEL_REF,
): ModelRef {
  if (raw == null || !raw.trim()) return fallback;
  const text = raw.trim();

  if (text.startsWith('{')) {
    return modelRefSchema.parse(JSON.parse(text));
  }

  if (text.includes(':')) {
    return parseProviderModelId(text);
  }

  // CLI-only fallback: historical flags accepted bare Gemini model ids.
  return { provider: 'gemini', model: text };
}
