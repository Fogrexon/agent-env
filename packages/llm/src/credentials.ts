import type {
  LlmProviderId,
  ProviderCredentials,
} from '@agent-env/shared';
import { getProvider } from './registry.js';

/** Read provider credentials from process.env (does not load .env itself). */
export function loadProviderCredentials(
  overrides: Partial<ProviderCredentials> = {},
): ProviderCredentials {
  return {
    geminiApiKey:
      overrides.geminiApiKey ??
      process.env['GEMINI_API_KEY'] ??
      process.env['GOOGLE_API_KEY'],
    cursorApiKey:
      overrides.cursorApiKey ?? process.env['CURSOR_API_KEY'],
  };
}

export function isProviderConfigured(
  id: LlmProviderId,
  credentials: ProviderCredentials = loadProviderCredentials(),
): boolean {
  return getProvider(id).isConfigured(credentials);
}

/**
 * Pick preferred ModelRef when its provider is configured; otherwise fallback.
 * Useful for demos that prefer Cursor but still run on Gemini-only machines.
 */
export function selectModelRef(
  preferred: import('@agent-env/shared').ModelRef,
  fallback: import('@agent-env/shared').ModelRef,
  credentials: ProviderCredentials = loadProviderCredentials(),
): import('@agent-env/shared').ModelRef {
  return isProviderConfigured(preferred.provider, credentials)
    ? preferred
    : fallback;
}

/** Ensure at least one of the given providers is configured. */
export function assertAnyProvider(
  ids: readonly LlmProviderId[],
  credentials: ProviderCredentials = loadProviderCredentials(),
): void {
  const missing = ids.filter((id) => !isProviderConfigured(id, credentials));
  if (missing.length === ids.length) {
    throw new Error(
      `No LLM credentials for providers: ${ids.join(', ')}. Set GEMINI_API_KEY and/or CURSOR_API_KEY in .env.`,
    );
  }
}

/** Ensure every listed provider is configured. */
export function assertProviders(
  ids: readonly LlmProviderId[],
  credentials: ProviderCredentials = loadProviderCredentials(),
): void {
  for (const id of ids) {
    getProvider(id).assertConfigured(credentials);
  }
}
