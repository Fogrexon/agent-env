import type { ProviderCredentials } from '@agent-env/shared';
import {
  openAiChatCompletion,
  readNumberParam,
  readStringParam,
} from '../openai-chat.js';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
} from '../types.js';

/**
 * OpenAI-compatible Chat Completions (LM Studio, Ollama, vLLM, LocalAI, etc.).
 *
 * Configured when OPENAI_COMPATIBLE_BASE_URL (or LM_STUDIO_BASE_URL) is set.
 * API key is optional (defaults to "local").
 * Per-call override: ModelRef.params.baseUrl / apiKey
 *
 * Examples:
 *   OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:1234/v1   # LM Studio
 *   OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:11434/v1  # Ollama
 */
export const openaiCompatibleProvider: LlmProvider = {
  id: 'openai-compatible',

  isConfigured(credentials: ProviderCredentials): boolean {
    return Boolean(credentials.openaiCompatibleBaseUrl?.trim());
  },

  assertConfigured(credentials: ProviderCredentials): void {
    if (!this.isConfigured(credentials)) {
      throw new Error(
        'openai-compatible provider requires OPENAI_COMPATIBLE_BASE_URL ' +
          '(e.g. http://127.0.0.1:1234/v1 for LM Studio). ' +
          'You can also pass params.baseUrl on the ModelRef.',
      );
    }
  },

  async generate(
    request: ProviderGenerateRequest,
    credentials: ProviderCredentials,
    abortSignal?: AbortSignal,
  ): Promise<ProviderGenerateResult> {
    const baseURL =
      readStringParam(request.params, 'baseUrl') ??
      readStringParam(request.params, 'baseURL') ??
      credentials.openaiCompatibleBaseUrl?.trim();

    if (!baseURL) {
      this.assertConfigured(credentials);
      throw new Error('openai-compatible base URL missing');
    }

    const apiKey =
      readStringParam(request.params, 'apiKey') ??
      credentials.openaiCompatibleApiKey?.trim() ??
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
      provider: 'openai-compatible',
      model: request.model,
    };
  },
};
