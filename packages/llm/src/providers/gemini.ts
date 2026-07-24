import { GoogleGenAI } from '@google/genai';
import { Gemini, type BaseLlm } from '@google/adk';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  SecretSource,
} from '../types.js';
import { resolveSecret } from '../types.js';

export interface CreateGeminiProviderOptions {
  /** Registry id. Default: "gemini". */
  id?: string;
  /** API key string or lazy getter — how you store it is up to you. */
  apiKey: SecretSource;
}

export function createGeminiProvider(
  options: CreateGeminiProviderOptions,
): LlmProvider {
  const id = options.id ?? 'gemini';

  return {
    id,
    kind: 'gemini',

    isConfigured(): boolean {
      return Boolean(resolveSecret(options.apiKey));
    },

    assertConfigured(): void {
      if (!this.isConfigured()) {
        throw new Error(
          `Gemini provider "${id}" has no API key. Pass apiKey when calling createGeminiProvider().`,
        );
      }
    },

    createAdkLlm(model: string): BaseLlm {
      this.assertConfigured();
      return new Gemini({
        model,
        apiKey: resolveSecret(options.apiKey),
      });
    },

    async generate(
      request: ProviderGenerateRequest,
      abortSignal?: AbortSignal,
    ): Promise<ProviderGenerateResult> {
      this.assertConfigured();
      const apiKey = resolveSecret(options.apiKey)!;
      const client = new GoogleGenAI({ apiKey });

      const contents =
        request.contents ??
        request.messages.map((message) => ({
          role: message.role === 'model' ? 'model' : 'user',
          parts: [{ text: message.text }],
        }));

      const response = await client.models.generateContent({
        model: request.model,
        contents,
        config: {
          systemInstruction: request.systemInstruction,
          abortSignal,
        },
      });

      return {
        text: response.text?.trim() ?? '',
        modelVersion: request.model,
        provider: id,
        model: request.model,
      };
    },
  };
}
