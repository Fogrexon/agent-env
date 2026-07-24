import { Agent } from '@cursor/sdk';
import type { ModelParameterValue } from '@cursor/sdk';
import { messagesToPrompt } from '../prompt.js';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  SecretSource,
} from '../types.js';
import { resolveSecret } from '../types.js';

export interface CreateCursorProviderOptions {
  id?: string;
  apiKey: SecretSource;
  /** Working directory for local Cursor agent runs. Default: process.cwd(). */
  cwd?: string | (() => string);
}

function toCursorModelParams(
  params: Record<string, unknown> | undefined,
): ModelParameterValue[] | undefined {
  if (!params || Object.keys(params).length === 0) return undefined;
  return Object.entries(params).map(([paramId, value]) => ({
    id: paramId,
    value: String(value),
  }));
}

export function createCursorProvider(
  options: CreateCursorProviderOptions,
): LlmProvider {
  const id = options.id ?? 'cursor';

  return {
    id,
    kind: 'cursor',

    isConfigured(): boolean {
      return Boolean(resolveSecret(options.apiKey));
    },

    assertConfigured(): void {
      if (!this.isConfigured()) {
        throw new Error(
          `Cursor provider "${id}" has no API key. Pass apiKey when calling createCursorProvider().`,
        );
      }
    },

    async generate(
      request: ProviderGenerateRequest,
      abortSignal?: AbortSignal,
    ): Promise<ProviderGenerateResult> {
      this.assertConfigured();

      if (abortSignal?.aborted) {
        throw new Error('Cursor generate aborted before start');
      }

      const prompt = messagesToPrompt(
        request.systemInstruction,
        request.messages,
      );
      const params = toCursorModelParams(request.params);
      const cwd =
        typeof options.cwd === 'function'
          ? options.cwd()
          : (options.cwd ?? process.cwd());

      const result = await Agent.prompt(prompt, {
        apiKey: resolveSecret(options.apiKey)!,
        model: {
          id: request.model,
          ...(params ? { params } : {}),
        },
        local: { cwd },
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
        provider: id,
        model: request.model,
      };
    },
  };
}
