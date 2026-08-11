import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_COMPATIBLE_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  type LlmProviderId,
  type ProviderModelId,
} from '@agent-env/shared';
import { listProviders } from './registry.js';

/** Bare model ids used when `listModels` is missing or fails. */
export const STATIC_MODELS_BY_PROVIDER: Readonly<
  Record<string, readonly string[]>
> = {
  cursor: [DEFAULT_CURSOR_MODEL],
  gemini: [DEFAULT_GEMINI_MODEL, 'gemini-3.1-pro', 'gemini-2.5-pro'],
  openai: [DEFAULT_OPENAI_MODEL, 'gpt-4.1', 'gpt-4o', 'o4-mini'],
  anthropic: [
    DEFAULT_ANTHROPIC_MODEL,
    'claude-opus-4-6',
    'claude-haiku-4-5-20251001',
  ],
  openrouter: [
    DEFAULT_OPENROUTER_MODEL,
    'anthropic/claude-sonnet-4',
    'google/gemini-2.5-flash',
  ],
};

export interface AvailableModel {
  /** Wire id: `provider:model`. */
  id: ProviderModelId;
  provider: LlmProviderId;
  model: string;
  label: string;
}

export interface ListAvailableModelsOptions {
  /** Restrict to these registry provider ids. */
  providers?: readonly string[];
}

function staticModelsFor(
  providerId: string,
  kind: string | undefined,
): readonly string[] {
  const byId = STATIC_MODELS_BY_PROVIDER[providerId];
  if (byId?.length) return byId;
  if (kind === 'openrouter') {
    return STATIC_MODELS_BY_PROVIDER.openrouter ?? [DEFAULT_OPENROUTER_MODEL];
  }
  if (kind === 'openai-compatible') {
    return [DEFAULT_OPENAI_COMPATIBLE_MODEL];
  }
  return [];
}

/**
 * Models selectable in admin (`type: model` params).
 * Only configured providers; live `listModels` with static fallback.
 */
export async function listAvailableModels(
  options: ListAvailableModelsOptions = {},
): Promise<AvailableModel[]> {
  const filter = options.providers?.length
    ? new Set(options.providers)
    : undefined;

  const out: AvailableModel[] = [];
  for (const provider of listProviders()) {
    if (filter && !filter.has(provider.id)) continue;
    if (!provider.isConfigured()) continue;

    let models: string[] = [];
    if (provider.listModels) {
      try {
        models = [...(await provider.listModels())].map((m) => m.trim()).filter(Boolean);
      } catch {
        models = [];
      }
    }
    if (models.length === 0) {
      models = [...staticModelsFor(provider.id, provider.kind)];
    }

    const seen = new Set<string>();
    for (const model of models) {
      if (seen.has(model)) continue;
      seen.add(model);
      const id = `${provider.id}:${model}` as ProviderModelId;
      out.push({
        id,
        provider: provider.id,
        model,
        label: `${provider.id} / ${model}`,
      });
    }
  }
  return out;
}
