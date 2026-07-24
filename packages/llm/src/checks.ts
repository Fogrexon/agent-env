import type { LlmProviderId, ModelRef } from '@agent-env/shared';
import {
  getProvider,
  hasProvider,
  listProviderIds,
  listProviders,
} from './registry.js';

export function isProviderConfigured(id: LlmProviderId): boolean {
  if (!hasProvider(id)) return false;
  return getProvider(id).isConfigured();
}

/**
 * Pick preferred ModelRef when its provider is registered and configured;
 * otherwise fallback.
 */
export function selectModelRef(
  preferred: ModelRef,
  fallback: ModelRef,
): ModelRef {
  return isProviderConfigured(preferred.provider) ? preferred : fallback;
}

/** Ensure at least one registered provider is configured. */
export function assertAnyProvider(
  ids?: readonly LlmProviderId[],
): void {
  const candidates = ids?.length ? ids : listProviderIds();
  const ok = candidates.some((id) => isProviderConfigured(id));
  if (!ok) {
    const registered = listProviders()
      .map((p) => `${p.id}${p.isConfigured() ? '' : ' (unconfigured)'}`)
      .join(', ');
    throw new Error(
      `No configured LLM providers` +
        (ids?.length ? ` among: ${ids.join(', ')}` : '') +
        `. Registered: ${registered || '(none)'}. ` +
        `Call registerProvider(...) with secrets supplied by your app.`,
    );
  }
}

/** Ensure every listed provider is registered and configured. */
export function assertProviders(ids: readonly LlmProviderId[]): void {
  for (const id of ids) {
    getProvider(id).assertConfigured();
  }
}
