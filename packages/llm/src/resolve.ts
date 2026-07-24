import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_MODEL_REF,
  DEFAULT_OPENAI_COMPATIBLE_MODEL,
  DEFAULT_OPENAI_MODEL,
  llmProviderIdSchema,
  modelRefSchema,
  type ModelRef,
} from '@agent-env/shared';
import type { BaseLlm } from '@google/adk';
import { ProviderBackedLlm } from './provider-backed-llm.js';
import { getProvider } from './registry.js';

export interface ResolveModelOptions {
  /**
   * When true (default), use provider.createAdkLlm when available
   * (Gemini FunctionTools / streaming).
   */
  preferNativeAdk?: boolean;
}

/**
 * Parse `provider:model` or JSON ModelRef from a string (CLI flag, config file, …).
 * Does not read process.env — pass the raw string from the caller.
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

  const colon = text.indexOf(':');
  if (colon > 0) {
    const provider = llmProviderIdSchema.parse(text.slice(0, colon));
    const model = text.slice(colon + 1).trim();
    if (!model) {
      throw new Error(`Model id missing in ModelRef string: ${text}`);
    }
    return { provider, model };
  }

  return { provider: 'gemini', model: text };
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

/** Helper for a named openai-compatible backend id (default model only). */
export function defaultOpenaiCompatibleModelRef(
  providerId: string,
  model: string = DEFAULT_OPENAI_COMPATIBLE_MODEL,
): ModelRef {
  return { provider: providerId, model };
}
