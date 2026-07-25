import type { LlmProviderId } from '@agent-env/shared';
import {
  assertMimeTypesSupported,
  mediaCategories,
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

/** Provider id behind an ADK model instance, when the adapter exposes one. */
export function providerIdOfModel(model: unknown): LlmProviderId | undefined {
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
