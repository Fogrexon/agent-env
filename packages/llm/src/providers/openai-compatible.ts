import {
  assertMediaSupported,
  IMAGE_MIME_TYPES,
  type ProviderMediaSupport,
} from '../media.js';
import {
  openAiChatCompletion,
  openAiChatCompletionStream,
  readNumberParam,
  readStringParam,
} from '../openai-chat.js';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStreamChunk,
  SecretSource,
} from '../types.js';
import { resolveSecret } from '../types.js';

export type BaseUrlSource = string | (() => string | undefined | null);

/**
 * Only what the Chat Completions wire format guarantees for a generic backend.
 * Servers with richer support should pass an explicit `media` to the factory.
 */
export const OPENAI_COMPATIBLE_DEFAULT_MEDIA_SUPPORT: ProviderMediaSupport = {
  mimeTypes: [...IMAGE_MIME_TYPES],
  notes:
    'Default assumes vision-style image_url parts only. Override with the media option when the backend accepts more.',
};

export interface CreateOpenaiCompatibleProviderOptions {
  /**
   * Unique registry id for this backend, e.g. "lm-studio", "ollama", "vllm-prod".
   * Use a distinct id per endpoint so many compatible APIs can coexist.
   */
  id: string;
  /** Chat Completions base URL, e.g. http://127.0.0.1:1234/v1 */
  baseUrl: BaseUrlSource;
  /**
   * Optional API key. Many local servers accept any/empty value.
   * How you obtain it (env, secret manager, …) is your responsibility.
   */
  apiKey?: SecretSource;
  /** Default key sent when apiKey resolves empty. Default: "local". */
  defaultApiKey?: string;
  /**
   * Media this endpoint accepts. Backend capability varies per server/model,
   * so declare it explicitly; `false` rejects every attachment.
   * Default: images only.
   */
  media?: ProviderMediaSupport | false;
}

function resolveBaseUrl(source: BaseUrlSource): string | undefined {
  const value = typeof source === 'function' ? source() : source;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveCompatibleChatOptions(
  id: string,
  options: CreateOpenaiCompatibleProviderOptions,
  media: ProviderMediaSupport | undefined,
  request: ProviderGenerateRequest,
  abortSignal?: AbortSignal,
) {
  const attachments = request.attachments ?? [];
  assertMediaSupported(id, media, attachments);

  const baseURL =
    readStringParam(request.params, 'baseUrl') ??
    readStringParam(request.params, 'baseURL') ??
    resolveBaseUrl(options.baseUrl);

  if (!baseURL) {
    throw new Error(`OpenAI-compatible provider "${id}" baseUrl missing`);
  }

  const apiKey =
    readStringParam(request.params, 'apiKey') ??
    resolveSecret(options.apiKey) ??
    options.defaultApiKey ??
    'local';

  return {
    apiKey,
    baseURL,
    model: request.model,
    systemInstruction: request.systemInstruction,
    messages: request.messages,
    attachments,
    temperature: readNumberParam(request.params, 'temperature'),
    maxTokens: readNumberParam(request.params, 'maxTokens'),
    abortSignal,
  };
}

/**
 * Factory for one OpenAI-compatible endpoint (LM Studio, Ollama, vLLM, …).
 * Register multiple instances with different `id`s to use several at once.
 */
export function createOpenaiCompatibleProvider(
  options: CreateOpenaiCompatibleProviderOptions,
): LlmProvider {
  const id = options.id.trim();
  if (!id) {
    throw new Error('createOpenaiCompatibleProvider requires a non-empty id');
  }

  const media =
    options.media === false
      ? undefined
      : (options.media ?? OPENAI_COMPATIBLE_DEFAULT_MEDIA_SUPPORT);

  return {
    id,
    kind: 'openai-compatible',
    media,

    isConfigured(): boolean {
      return Boolean(resolveBaseUrl(options.baseUrl));
    },

    assertConfigured(): void {
      if (!this.isConfigured()) {
        throw new Error(
          `OpenAI-compatible provider "${id}" has no baseUrl. ` +
            `Pass baseUrl when calling createOpenaiCompatibleProvider().`,
        );
      }
    },

    async generate(
      request: ProviderGenerateRequest,
      abortSignal?: AbortSignal,
    ): Promise<ProviderGenerateResult> {
      if (
        !resolveBaseUrl(options.baseUrl) &&
        !readStringParam(request.params, 'baseUrl') &&
        !readStringParam(request.params, 'baseURL')
      ) {
        this.assertConfigured();
      }
      const result = await openAiChatCompletion(
        resolveCompatibleChatOptions(id, options, media, request, abortSignal),
      );

      return {
        text: result.text,
        modelVersion: result.model ?? request.model,
        provider: id,
        model: request.model,
      };
    },

    async *generateStream(
      request: ProviderGenerateRequest,
      abortSignal?: AbortSignal,
    ): AsyncGenerator<ProviderStreamChunk, ProviderGenerateResult, void> {
      if (
        !resolveBaseUrl(options.baseUrl) &&
        !readStringParam(request.params, 'baseUrl') &&
        !readStringParam(request.params, 'baseURL')
      ) {
        this.assertConfigured();
      }
      const stream = openAiChatCompletionStream(
        resolveCompatibleChatOptions(id, options, media, request, abortSignal),
      );
      let next = await stream.next();
      while (!next.done) {
        yield next.value;
        next = await stream.next();
      }
      return {
        text: next.value.text,
        modelVersion: next.value.model ?? request.model,
        provider: id,
        model: request.model,
      };
    },
  };
}
