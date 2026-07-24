import {
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_MODEL_REF,
  llmProviderIdSchema,
  modelRefSchema,
  type ModelRef,
  type ProviderCredentials,
} from '@agent-env/shared';
import { Gemini, type BaseLlm } from '@google/adk';
import { ProviderBackedLlm } from './provider-backed-llm.js';
import { getProvider } from './registry.js';
import { loadProviderCredentials } from './credentials.js';

export interface ResolveModelOptions {
  credentials?: ProviderCredentials;
  /**
   * When true (default), gemini refs use ADK's native Gemini class
   * so FunctionTools / streaming stay first-class.
   * When false, always wrap via ProviderBackedLlm.
   */
  preferNativeGemini?: boolean;
}

/**
 * Parse `provider:model` or JSON ModelRef from env / CLI.
 * Examples:
 *   gemini:gemini-2.5-flash
 *   cursor:composer-2
 *   {"provider":"cursor","model":"composer-2"}
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

  // Bare model id → assume gemini (legacy AGENT_ENV_MODEL=gemini-2.5-flash)
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
 * Different agents/sub-agents can call this with different refs concurrently.
 */
export function resolveModel(
  ref: ModelRef,
  options: ResolveModelOptions = {},
): BaseLlm {
  const credentials = options.credentials ?? loadProviderCredentials();
  const preferNativeGemini = options.preferNativeGemini ?? true;
  const provider = getProvider(ref.provider);
  // Credential checks happen on first generate (keeps agent module import cheap).

  if (ref.provider === 'gemini' && preferNativeGemini) {
    return new Gemini({
      model: ref.model || DEFAULT_GEMINI_MODEL,
      apiKey: credentials.geminiApiKey,
    });
  }

  return new ProviderBackedLlm({
    modelRef: ref,
    provider,
    credentials,
  });
}

/** Convenience: resolve from env string / ModelRef with gemini default. */
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
