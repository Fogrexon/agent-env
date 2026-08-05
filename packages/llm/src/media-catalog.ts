import type { LlmProviderId } from '@agent-env/shared';
import {
  assertMimeTypesSupported,
  mediaCategories,
  supportsMedia,
  type MediaCategory,
  type MediaDescriptor,
  type ProviderMediaSupport,
} from './media.js';
import { getProvider, hasProvider, listProviders } from './registry.js';

/** Serializable media capability report for a registered provider. */
export interface ProviderMediaInfo {
  id: LlmProviderId;
  kind?: string;
  configured: boolean;
  categories: MediaCategory[];
  mimeTypes: string[];
  maxBytesPerFile?: number;
  notes?: string;
}

function toInfo(
  id: LlmProviderId,
  kind: string | undefined,
  configured: boolean,
  media: ProviderMediaSupport | undefined,
): ProviderMediaInfo {
  return {
    id,
    ...(kind ? { kind } : {}),
    configured,
    categories: mediaCategories(media),
    mimeTypes: [...(media?.mimeTypes ?? [])],
    ...(media?.maxBytesPerFile !== undefined
      ? { maxBytesPerFile: media.maxBytesPerFile }
      : {}),
    ...(media?.notes ? { notes: media.notes } : {}),
  };
}

/** Media capabilities of every registered provider (admin UI / docs). */
export function listProviderMedia(): ProviderMediaInfo[] {
  return listProviders().map((provider) =>
    toInfo(provider.id, provider.kind, provider.isConfigured(), provider.media),
  );
}

/**
 * Pre-flight MIME check against a registered provider.
 * No-op for unregistered ids so callers that cannot resolve a provider
 * still fall through to the adapter-level guard.
 */
export function assertProviderAcceptsMedia(
  id: LlmProviderId,
  files: readonly MediaDescriptor[],
): void {
  if (files.length === 0 || !hasProvider(id)) return;
  const provider = getProvider(id);
  assertMimeTypesSupported(provider.id, provider.media, files);
}

/**
 * Whether a registered provider can deliver `mimeType` natively to the model.
 * Returns undefined for unregistered ids so callers can treat unknown providers
 * as pass-through (adapter-level guard still applies).
 */
export function providerSupportsMime(
  id: LlmProviderId,
  mimeType: string,
): boolean | undefined {
  if (!hasProvider(id)) return undefined;
  return supportsMedia(getProvider(id).media, mimeType);
}

/**
 * Provider id behind an ADK model value.
 * Accepts `provider:model` strings and BaseLlm adapters that expose `providerId`.
 */
export function providerIdOfModel(model: unknown): LlmProviderId | undefined {
  if (typeof model === 'string') {
    const text = model.trim();
    const colon = text.indexOf(':');
    if (colon > 0 && colon < text.length - 1 && !/\s/.test(text)) {
      return text.slice(0, colon);
    }
    return undefined;
  }
  if (typeof model !== 'object' || model === null) return undefined;
  const id = (model as { providerId?: unknown }).providerId;
  return typeof id === 'string' ? id : undefined;
}

export function describeProviderMedia(id: LlmProviderId): ProviderMediaInfo {
  const provider = getProvider(id);
  return toInfo(
    provider.id,
    provider.kind,
    provider.isConfigured(),
    provider.media,
  );
}
