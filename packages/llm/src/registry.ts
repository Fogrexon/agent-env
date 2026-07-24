import type { LlmProviderId } from '@agent-env/shared';
import { anthropicProvider } from './providers/anthropic.js';
import { cursorProvider } from './providers/cursor.js';
import { geminiProvider } from './providers/gemini.js';
import { openaiCompatibleProvider } from './providers/openai-compatible.js';
import { openaiProvider } from './providers/openai.js';
import type { LlmProvider } from './types.js';

const providers: Record<LlmProviderId, LlmProvider> = {
  gemini: geminiProvider,
  cursor: cursorProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  'openai-compatible': openaiCompatibleProvider,
};

export function getProvider(id: LlmProviderId): LlmProvider {
  const provider = providers[id];
  if (!provider) {
    throw new Error(`Unknown LLM provider: ${id}`);
  }
  return provider;
}

export function listProviders(): readonly LlmProvider[] {
  return Object.values(providers);
}
