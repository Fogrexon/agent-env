import { GoogleGenAI } from '@google/genai';
import type { ProviderCredentials } from '@agent-env/shared';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
} from '../types.js';

/**
 * Direct Gemini completion adapter (Google AI Studio / API key).
 * Prefer resolveModel() → ADK Gemini for tool-calling LlmAgents;
 * this adapter is used by ProviderBackedLlm and non-ADK callers.
 */
export const geminiProvider: LlmProvider = {
  id: 'gemini',

  isConfigured(credentials: ProviderCredentials): boolean {
    return Boolean(credentials.geminiApiKey?.trim());
  },

  assertConfigured(credentials: ProviderCredentials): void {
    if (!this.isConfigured(credentials)) {
      throw new Error(
        'Gemini provider requires GEMINI_API_KEY (or GOOGLE_API_KEY). Copy .env.example to .env.',
      );
    }
  },

  async generate(
    request: ProviderGenerateRequest,
    credentials: ProviderCredentials,
    abortSignal?: AbortSignal,
  ): Promise<ProviderGenerateResult> {
    this.assertConfigured(credentials);
    const apiKey = credentials.geminiApiKey!.trim();
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

    const text = response.text?.trim() ?? '';
    return {
      text,
      modelVersion: request.model,
      provider: 'gemini',
      model: request.model,
    };
  },
};
