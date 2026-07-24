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

export interface CreateOpenaiProviderOptions {
  id?: string;
  apiKey: SecretSource;
  baseUrl?: string | (() => string | undefined);
}

export function createOpenaiProvider(
  options: CreateOpenaiProviderOptions,
): LlmProvider {
  const id = options.id ?? 'openai';

  return {
    id,
    kind: 'openai',

    isConfigured(): boolean {
      return Boolean(resolveSecret(options.apiKey));
    },

    assertConfigured(): void {
      if (!this.isConfigured()) {
        throw new Error(
          `OpenAI provider "${id}" has no API key. Pass apiKey when calling createOpenaiProvider().`,
        );
      }
    },

    async generate(
      request: ProviderGenerateRequest,
      abortSignal?: AbortSignal,
    ): Promise<ProviderGenerateResult> {
      this.assertConfigured();

      const baseURL =
        readStringParam(request.params, 'baseUrl') ??
        readStringParam(request.params, 'baseURL') ??
        (typeof options.baseUrl === 'function'
          ? options.baseUrl()?.trim()
          : options.baseUrl?.trim());

      const result = await openAiChatCompletion({
        apiKey: resolveSecret(options.apiKey)!,
        baseURL: baseURL || undefined,
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
