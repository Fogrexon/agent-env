import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_MODEL_REF,
  DEFAULT_OPENAI_COMPATIBLE_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  parseProviderModelId,
  type ModelRef,
} from '@agent-env/shared';
import type { BaseLlm } from '@google/adk';
import { ProviderBackedLlm } from './provider-backed-llm.js';
import { getProvider } from './registry.js';

export { parseModelRef } from './model-ref-string.js';

export interface ResolveModelOptions {
  /**
   * When true (default), use provider.createAdkLlm when available
   * (Gemini FunctionTools / streaming).
   */
  preferNativeAdk?: boolean;
}

/**
 * Resolve a ModelRef to an ADK BaseLlm instance.
 * The provider must already be registered (secrets closed over at register time).
 */
export function resolveModel(
  ref: ModelRef,
  options: ResolveModelOptions = {},
): BaseLlm {
  const preferNativeAdk = options.preferNativeAdk ?? true;
  const provider = getProvider(ref.provider);

  if (preferNativeAdk && provider.createAdkLlm) {
    return provider.createAdkLlm(ref.model || DEFAULT_GEMINI_MODEL);
  }

  return new ProviderBackedLlm({
    modelRef: ref,
    provider,
  });
}

/**
 * Turn an LlmAgent.model value into a concrete {@link BaseLlm}.
 * String forms must be `provider:model` (ADK registry wire format).
 */
export function materializeAgentModel(model: string | BaseLlm): BaseLlm {
  if (typeof model !== 'string') return model;
  return resolveModel(parseProviderModelId(model));
}

/** Resolve using an explicit ref, or the shared default constant. */
export function resolveDefaultModel(
  ref: ModelRef = DEFAULT_MODEL_REF,
  options: ResolveModelOptions = {},
): BaseLlm {
  return resolveModel(ref, options);
}

export function defaultCursorModelRef(
  model: string = DEFAULT_CURSOR_MODEL,
): ModelRef {
  return { provider: 'cursor', model };
}

export function defaultGeminiModelRef(
  model: string = DEFAULT_GEMINI_MODEL,
): ModelRef {
  return { provider: 'gemini', model };
}

export function defaultOpenaiModelRef(
  model: string = DEFAULT_OPENAI_MODEL,
): ModelRef {
  return { provider: 'openai', model };
}

export function defaultAnthropicModelRef(
  model: string = DEFAULT_ANTHROPIC_MODEL,
): ModelRef {
  return { provider: 'anthropic', model };
}

export function defaultOpenRouterModelRef(
  model: string = DEFAULT_OPENROUTER_MODEL,
): ModelRef {
  return { provider: 'openrouter', model };
}

/** Helper for a named openai-compatible backend id (default model only). */
export function defaultOpenaiCompatibleModelRef(
  providerId: string,
  model: string = DEFAULT_OPENAI_COMPATIBLE_MODEL,
): ModelRef {
  return { provider: providerId, model };
}
