import type { LlmProvider } from './types.js';
import {
  createAnthropicProvider,
  type CreateAnthropicProviderOptions,
} from './providers/anthropic.js';
import {
  createCursorProvider,
  type CreateCursorProviderOptions,
} from './providers/cursor.js';
import {
  createGeminiProvider,
  type CreateGeminiProviderOptions,
} from './providers/gemini.js';
import {
  createOpenaiCompatibleProvider,
  type CreateOpenaiCompatibleProviderOptions,
} from './providers/openai-compatible.js';
import {
  createOpenaiProvider,
  type CreateOpenaiProviderOptions,
} from './providers/openai.js';
import {
  createOpenRouterProvider,
  type CreateOpenRouterProviderOptions,
} from './providers/openrouter.js';
import { registerProvider } from './registry.js';

export interface RegisterProvidersConfig {
  gemini?: CreateGeminiProviderOptions;
  cursor?: CreateCursorProviderOptions;
  openai?: CreateOpenaiProviderOptions;
  anthropic?: CreateAnthropicProviderOptions;
  openrouter?: CreateOpenRouterProviderOptions;
  /**
   * Zero or more OpenAI-compatible backends (LM Studio, Ollama, vLLM, …).
   * Each entry becomes its own provider id.
   */
  openaiCompatible?: CreateOpenaiCompatibleProviderOptions[];
  /** Replace existing ids. Default true for bootstrap ergonomics. */
  replace?: boolean;
}

/**
 * Register one or more providers from explicit config.
 * Secrets are whatever you pass in — this helper does not read process.env.
 */
export function registerProviders(config: RegisterProvidersConfig): LlmProvider[] {
  const replace = config.replace ?? true;
  const created: LlmProvider[] = [];

  if (config.gemini) {
    const provider = createGeminiProvider(config.gemini);
    registerProvider(provider, { replace });
    created.push(provider);
  }
  if (config.cursor) {
    const provider = createCursorProvider(config.cursor);
    registerProvider(provider, { replace });
    created.push(provider);
  }
  if (config.openai) {
    const provider = createOpenaiProvider(config.openai);
    registerProvider(provider, { replace });
    created.push(provider);
  }
  if (config.anthropic) {
    const provider = createAnthropicProvider(config.anthropic);
    registerProvider(provider, { replace });
    created.push(provider);
  }
  if (config.openrouter) {
    const provider = createOpenRouterProvider(config.openrouter);
    registerProvider(provider, { replace });
    created.push(provider);
  }
  for (const entry of config.openaiCompatible ?? []) {
    const provider = createOpenaiCompatibleProvider(entry);
    registerProvider(provider, { replace });
    created.push(provider);
  }

  return created;
}
