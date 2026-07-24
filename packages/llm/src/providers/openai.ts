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
 * Official OpenAI Chat Completions adapter.
 * Env: OPENAI_API_KEY, optional OPENAI_BASE_URL.
 */
export const openaiProvider: LlmProvider = {
  id: 'openai',

  isConfigured(credentials: ProviderCredentials): boolean {
    return Boolean(credentials.openaiApiKey?.trim());
  },

  assertConfigured(credentials: ProviderCredentials): void {
    if (!this.isConfigured(credentials)) {
      throw new Error(
        'OpenAI provider requires OPENAI_API_KEY. See https://platform.openai.com/api-keys',
      );
    }
  },

  async generate(
    request: ProviderGenerateRequest,
    credentials: ProviderCredentials,
    abortSignal?: AbortSignal,
  ): Promise<ProviderGenerateResult> {
    this.assertConfigured(credentials);

    const baseURL =
      readStringParam(request.params, 'baseUrl') ??
      readStringParam(request.params, 'baseURL') ??
      credentials.openaiBaseUrl;

    const result = await openAiChatCompletion({
      apiKey: credentials.openaiApiKey!.trim(),
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
      provider: 'openai',
      model: request.model,
    };
  },
};
