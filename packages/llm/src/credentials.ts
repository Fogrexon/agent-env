import {
  LLM_PROVIDER_IDS,
  type LlmProviderId,
  type ProviderCredentials,
} from '@agent-env/shared';
import { getProvider, listProviders } from './registry.js';

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
    openaiApiKey:
      overrides.openaiApiKey ?? process.env['OPENAI_API_KEY'],
    openaiBaseUrl:
      overrides.openaiBaseUrl ?? process.env['OPENAI_BASE_URL'],
    anthropicApiKey:
      overrides.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY'],
    openaiCompatibleBaseUrl:
      overrides.openaiCompatibleBaseUrl ??
      process.env['OPENAI_COMPATIBLE_BASE_URL'] ??
      process.env['LM_STUDIO_BASE_URL'],
    openaiCompatibleApiKey:
      overrides.openaiCompatibleApiKey ??
      process.env['OPENAI_COMPATIBLE_API_KEY'] ??
      process.env['LM_STUDIO_API_KEY'],
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
  ids: readonly LlmProviderId[] = LLM_PROVIDER_IDS,
  credentials: ProviderCredentials = loadProviderCredentials(),
): void {
  const missing = ids.filter((id) => !isProviderConfigured(id, credentials));
  if (missing.length === ids.length) {
    const available = listProviders()
      .map((p) => p.id)
      .join(', ');
    throw new Error(
      `No LLM credentials configured for: ${ids.join(', ')}. ` +
        `Set at least one of GEMINI_API_KEY / CURSOR_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENAI_COMPATIBLE_BASE_URL. ` +
        `(known providers: ${available})`,
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
