import type { LlmProviderId } from '@agent-env/shared';
import { cursorProvider } from './providers/cursor.js';
import { geminiProvider } from './providers/gemini.js';
import type { LlmProvider } from './types.js';

const providers: Record<LlmProviderId, LlmProvider> = {
  gemini: geminiProvider,
  cursor: cursorProvider,
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
