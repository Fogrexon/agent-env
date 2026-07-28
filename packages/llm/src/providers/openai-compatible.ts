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
import {
  openAiChatWithTools,
  type ContextOverflowStrategy,
  type OpenAiToolContextOptions,
} from '../openai-tools.js';
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
 * Tool-calling defaults for one OpenAI-compatible backend. Each field is a
 * default that an agent may override per request via `ModelRef.params`
 * (`contextWindow`, `reserveOutputTokens`, `maxToolResultChars`,
 * `maxToolIterations`, `contextOverflow`).
 */
export interface OpenaiCompatibleToolOptions {
  /** Model context window in tokens. Default 32768 (override per model). */
  contextWindow?: number;
  reserveOutputTokens?: number;
  maxToolResultChars?: number;
  maxIterations?: number;
  overflow?: ContextOverflowStrategy;
}

const DEFAULT_TOOL_CONTEXT_WINDOW = 32768;

function parseOverflowStrategy(
  value: string | undefined,
): ContextOverflowStrategy | undefined {
  if (
    value === 'truncate' ||
    value === 'summarize' ||
    value === 'truncate-then-summarize'
  ) {
    return value;
  }
  return undefined;
}

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
  /**
   * Tool-calling (function calling) support. Enabled by default so agents can
   * use FunctionTools against LM Studio / Ollama / vLLM models that support the
   * OpenAI `tools` API. Set `false` to disable (the provider then rejects tools
   * like the base OpenAI-compatible contract). Object values set defaults that
   * `ModelRef.params` can still override per request.
   */
  tools?: OpenaiCompatibleToolOptions | false;
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

function resolveToolContext(
  toolDefaults: OpenaiCompatibleToolOptions,
  request: ProviderGenerateRequest,
): OpenAiToolContextOptions {
  const overflow =
    parseOverflowStrategy(readStringParam(request.params, 'contextOverflow')) ??
    toolDefaults.overflow;
  return {
    contextWindow:
      readNumberParam(request.params, 'contextWindow') ??
      toolDefaults.contextWindow ??
      DEFAULT_TOOL_CONTEXT_WINDOW,
    reserveOutputTokens:
      readNumberParam(request.params, 'reserveOutputTokens') ??
      toolDefaults.reserveOutputTokens,
    maxToolResultChars:
      readNumberParam(request.params, 'maxToolResultChars') ??
      toolDefaults.maxToolResultChars,
    maxIterations:
      readNumberParam(request.params, 'maxToolIterations') ??
      toolDefaults.maxIterations,
    ...(overflow ? { overflow } : {}),
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

  const toolsEnabled = options.tools !== false;
  const toolDefaults: OpenaiCompatibleToolOptions = options.tools || {};

  return {
    id,
    kind: 'openai-compatible',
    supportsTools: toolsEnabled,
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
      const chatOptions = resolveCompatibleChatOptions(
        id,
        options,
        media,
        request,
        abortSignal,
      );

      if (toolsEnabled && request.tools && request.tools.length > 0) {
        const result = await openAiChatWithTools({
          ...chatOptions,
          tools: request.tools,
          context: resolveToolContext(toolDefaults, request),
        });
        return {
          text: result.text,
          modelVersion: result.model ?? request.model,
          provider: id,
          model: request.model,
        };
      }

      const result = await openAiChatCompletion(chatOptions);

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

      // Tool loops need the full request/response round-trip, so we run the
      // non-streaming loop and emit the final answer as a single chunk.
      if (toolsEnabled && request.tools && request.tools.length > 0) {
        const chatOptions = resolveCompatibleChatOptions(
          id,
          options,
          media,
          request,
          abortSignal,
        );
        const result = await openAiChatWithTools({
          ...chatOptions,
          tools: request.tools,
          context: resolveToolContext(toolDefaults, request),
        });
        yield { text: result.text };
        return {
          text: result.text,
          modelVersion: result.model ?? request.model,
          provider: id,
          model: request.model,
        };
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
