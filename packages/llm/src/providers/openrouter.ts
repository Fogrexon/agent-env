import {
  createOpenaiCompatibleProvider,
  OPENAI_COMPATIBLE_DEFAULT_MEDIA_SUPPORT,
  type BaseUrlSource,
  type CreateOpenaiCompatibleProviderOptions,
  type OpenaiCompatibleToolOptions,
} from './openai-compatible.js';
import type { ProviderMediaSupport } from '../media.js';
import type { LlmProvider, SecretSource } from '../types.js';
import { resolveSecret } from '../types.js';

/** Official OpenRouter OpenAI-compatible Chat Completions base URL. */
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter accepts whatever the routed model supports; declare the same
 * conservative default as generic openai-compatible (images), or override.
 */
export const OPENROUTER_MEDIA_SUPPORT: ProviderMediaSupport =
  OPENAI_COMPATIBLE_DEFAULT_MEDIA_SUPPORT;

export interface CreateOpenRouterProviderOptions {
  /** Registry id. Default: `"openrouter"`. */
  id?: string;
  apiKey: SecretSource;
  /**
   * Override the OpenRouter API base (tests / proxies).
   * Default: {@link OPENROUTER_DEFAULT_BASE_URL}.
   */
  baseUrl?: BaseUrlSource;
  media?: ProviderMediaSupport | false;
  tools?: OpenaiCompatibleToolOptions | false;
}

/**
 * First-class OpenRouter provider (OpenAI Chat Completions compatible).
 *
 * Models are OpenRouter ids, e.g. `openai/gpt-4o-mini`, `anthropic/claude-sonnet-4`.
 * Wire as `openrouter:<model>` on LlmAgent.model.
 */
export function createOpenRouterProvider(
  options: CreateOpenRouterProviderOptions,
): LlmProvider {
  const id = options.id?.trim() || 'openrouter';
  const compatible: CreateOpenaiCompatibleProviderOptions = {
    id,
    baseUrl: options.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL,
    apiKey: options.apiKey,
    media: options.media,
    tools: options.tools,
  };
  const inner = createOpenaiCompatibleProvider(compatible);

  const provider: LlmProvider = {
    ...inner,
    kind: 'openrouter',
    isConfigured(): boolean {
      return Boolean(resolveSecret(options.apiKey));
    },
    assertConfigured(): void {
      if (!this.isConfigured()) {
        throw new Error(
          `OpenRouter provider "${id}" has no API key. Pass apiKey when calling createOpenRouterProvider().`,
        );
      }
    },
    async generate(request, abortSignal) {
      this.assertConfigured();
      return inner.generate(request, abortSignal);
    },
  };

  if (inner.generateStream) {
    const streamFn = inner.generateStream.bind(inner);
    provider.generateStream = async function* (request, abortSignal) {
      this.assertConfigured();
      const stream = streamFn(request, abortSignal);
      let step = await stream.next();
      while (!step.done) {
        yield step.value;
        step = await stream.next();
      }
      return step.value;
    };
  }

  return provider;
}
