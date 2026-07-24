import {
  openAiChatCompletion,
  readNumberParam,
  readStringParam,
} from '../openai-chat.js';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  SecretSource,
} from '../types.js';
import { resolveSecret } from '../types.js';

export type BaseUrlSource = string | (() => string | undefined | null);

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
}

function resolveBaseUrl(source: BaseUrlSource): string | undefined {
  const value = typeof source === 'function' ? source() : source;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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

  return {
    id,
    kind: 'openai-compatible',

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
      const baseURL =
        readStringParam(request.params, 'baseUrl') ??
        readStringParam(request.params, 'baseURL') ??
        resolveBaseUrl(options.baseUrl);

      if (!baseURL) {
        this.assertConfigured();
        throw new Error(`OpenAI-compatible provider "${id}" baseUrl missing`);
      }

      const apiKey =
        readStringParam(request.params, 'apiKey') ??
        resolveSecret(options.apiKey) ??
        options.defaultApiKey ??
        'local';

      const result = await openAiChatCompletion({
        apiKey,
        baseURL,
        model: request.model,
        systemInstruction: request.systemInstruction,
        messages: request.messages,
        temperature: readNumberParam(request.params, 'temperature'),
        maxTokens: readNumberParam(request.params, 'maxTokens'),
        abortSignal,
      });

      return {
        text: result.text,
        modelVersion: result.model ?? request.model,
        provider: id,
        model: request.model,
      };
    },
  };
}
