import type { LlmProviderId } from '@agent-env/shared';
import type { LlmProvider } from './types.js';

const providers = new Map<LlmProviderId, LlmProvider>();

export interface RegisterProviderOptions {
  /** Replace an existing id instead of throwing. Default false. */
  replace?: boolean;
}

export function registerProvider(
  provider: LlmProvider,
  options: RegisterProviderOptions = {},
): void {
  if (!options.replace && providers.has(provider.id)) {
    throw new Error(
      `LLM provider "${provider.id}" is already registered. Pass { replace: true } to override.`,
    );
  }
  providers.set(provider.id, provider);
}

export function unregisterProvider(id: LlmProviderId): boolean {
  return providers.delete(id);
}

export function clearProviders(): void {
  providers.clear();
}

export function getProvider(id: LlmProviderId): LlmProvider {
  const provider = providers.get(id);
  if (!provider) {
    const known = [...providers.keys()].sort().join(', ') || '(none)';
    throw new Error(
      `Unknown LLM provider: "${id}". Registered: ${known}. ` +
        `Register one with registerProvider(...) / createOpenaiCompatibleProvider(...).`,
    );
  }
  return provider;
}

export function hasProvider(id: LlmProviderId): boolean {
  return providers.has(id);
}

export function listProviders(): readonly LlmProvider[] {
  return [...providers.values()];
}

export function listProviderIds(): readonly LlmProviderId[] {
  return [...providers.keys()];
}
