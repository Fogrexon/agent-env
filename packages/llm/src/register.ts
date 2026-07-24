import type { LlmProvider } from './types.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createCursorProvider } from './providers/cursor.js';
import { createGeminiProvider } from './providers/gemini.js';
import { createOpenaiCompatibleProvider } from './providers/openai-compatible.js';
import { createOpenaiProvider } from './providers/openai.js';
import { registerProvider } from './registry.js';
import type { SecretSource } from './types.js';
import type { BaseUrlSource } from './providers/openai-compatible.js';

export interface RegisterProvidersConfig {
  gemini?: { id?: string; apiKey: SecretSource };
  cursor?: { id?: string; apiKey: SecretSource; cwd?: string | (() => string) };
  openai?: {
    id?: string;
    apiKey: SecretSource;
    baseUrl?: string | (() => string | undefined);
  };
  anthropic?: { id?: string; apiKey: SecretSource };
  /**
   * Zero or more OpenAI-compatible backends (LM Studio, Ollama, vLLM, …).
   * Each entry becomes its own provider id.
   */
  openaiCompatible?: Array<{
    id: string;
    baseUrl: BaseUrlSource;
    apiKey?: SecretSource;
    defaultApiKey?: string;
  }>;
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
  for (const entry of config.openaiCompatible ?? []) {
    const provider = createOpenaiCompatibleProvider(entry);
    registerProvider(provider, { replace });
    created.push(provider);
  }

  return created;
}
