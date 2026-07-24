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
 * Parse `provider:model` or JSON ModelRef from env / CLI.
 * Provider id is any registered string (including custom openai-compatible ids).
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

export function modelRefFromEnv(
  envKey = 'AGENT_ENV_MODEL',
  fallback: ModelRef = DEFAULT_MODEL_REF,
): ModelRef {
  return parseModelRef(process.env[envKey], fallback);
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

export function resolveDefaultModel(
  options: ResolveModelOptions = {},
): BaseLlm {
  return resolveModel(modelRefFromEnv(), options);
}

export function defaultCursorModelRef(): ModelRef {
  return {
    provider: 'cursor',
    model: process.env['AGENT_ENV_CURSOR_MODEL']?.trim() || DEFAULT_CURSOR_MODEL,
  };
}

export function defaultGeminiModelRef(): ModelRef {
  return modelRefFromEnv('AGENT_ENV_MODEL', {
    provider: 'gemini',
    model: DEFAULT_GEMINI_MODEL,
  });
}

export function defaultOpenaiModelRef(): ModelRef {
  return {
    provider: 'openai',
    model: process.env['AGENT_ENV_OPENAI_MODEL']?.trim() || DEFAULT_OPENAI_MODEL,
  };
}

export function defaultAnthropicModelRef(): ModelRef {
  return {
    provider: 'anthropic',
    model:
      process.env['AGENT_ENV_ANTHROPIC_MODEL']?.trim() || DEFAULT_ANTHROPIC_MODEL,
  };
}

/** Helper for a named openai-compatible backend id (default model only). */
export function defaultOpenaiCompatibleModelRef(
  providerId: string,
  model =
    process.env['AGENT_ENV_OPENAI_COMPATIBLE_MODEL']?.trim() ||
    DEFAULT_OPENAI_COMPATIBLE_MODEL,
): ModelRef {
  return { provider: providerId, model };
}
