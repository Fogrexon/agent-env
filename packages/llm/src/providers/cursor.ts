import { Agent } from '@cursor/sdk';
import type { ModelParameterValue } from '@cursor/sdk';
import type { ProviderCredentials } from '@agent-env/shared';
import { messagesToPrompt } from '../prompt.js';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
} from '../types.js';

function toCursorModelParams(
  params: Record<string, unknown> | undefined,
): ModelParameterValue[] | undefined {
  if (!params || Object.keys(params).length === 0) return undefined;
  return Object.entries(params).map(([id, value]) => ({
    id,
    value: String(value),
  }));
}

/**
 * Cursor SDK adapter.
 * Uses Agent.prompt for one-shot completions. Suitable for tool-less ADK
 * LlmAgents; ADK FunctionTools are not bridged in v1.
 */
export const cursorProvider: LlmProvider = {
  id: 'cursor',

  isConfigured(credentials: ProviderCredentials): boolean {
    return Boolean(credentials.cursorApiKey?.trim());
  },

  assertConfigured(credentials: ProviderCredentials): void {
    if (!this.isConfigured(credentials)) {
      throw new Error(
        'Cursor provider requires CURSOR_API_KEY. See https://cursor.com/dashboard/api',
      );
    }
  },

  async generate(
    request: ProviderGenerateRequest,
    credentials: ProviderCredentials,
    abortSignal?: AbortSignal,
  ): Promise<ProviderGenerateResult> {
    this.assertConfigured(credentials);

    if (abortSignal?.aborted) {
      throw new Error('Cursor generate aborted before start');
    }

    const prompt = messagesToPrompt(
      request.systemInstruction,
      request.messages,
    );

    const params = toCursorModelParams(request.params);

    const result = await Agent.prompt(prompt, {
      apiKey: credentials.cursorApiKey!.trim(),
      model: {
        id: request.model,
        ...(params ? { params } : {}),
      },
      local: { cwd: process.cwd() },
    });

    if (abortSignal?.aborted) {
      throw new Error('Cursor generate aborted');
    }

    if (result.status === 'error' || result.status === 'cancelled') {
      throw new Error(
        result.error?.message ??
          `Cursor run ${result.status} (id=${result.id})`,
      );
    }

    return {
      text: result.result?.trim() ?? '',
      modelVersion: result.model?.id ?? request.model,
      provider: 'cursor',
      model: request.model,
    };
  },
};
