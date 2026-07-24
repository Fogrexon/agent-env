import Anthropic from '@anthropic-ai/sdk';
import { readNumberParam } from '../openai-chat.js';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderMessage,
  SecretSource,
} from '../types.js';
import { resolveSecret } from '../types.js';

export interface CreateAnthropicProviderOptions {
  id?: string;
  apiKey: SecretSource;
}

function toAnthropicMessages(
  messages: ProviderMessage[],
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      out.push({ role: 'user', content: message.text });
      continue;
    }
    out.push({
      role: message.role === 'model' ? 'assistant' : 'user',
      content: message.text,
    });
  }
  return out;
}

export function createAnthropicProvider(
  options: CreateAnthropicProviderOptions,
): LlmProvider {
  const id = options.id ?? 'anthropic';

  return {
    id,
    kind: 'anthropic',

    isConfigured(): boolean {
      return Boolean(resolveSecret(options.apiKey));
    },

    assertConfigured(): void {
      if (!this.isConfigured()) {
        throw new Error(
          `Anthropic provider "${id}" has no API key. Pass apiKey when calling createAnthropicProvider().`,
        );
      }
    },

    async generate(
      request: ProviderGenerateRequest,
      abortSignal?: AbortSignal,
    ): Promise<ProviderGenerateResult> {
      this.assertConfigured();

      const client = new Anthropic({
        apiKey: resolveSecret(options.apiKey)!,
      });

      const maxTokens =
        readNumberParam(request.params, 'maxTokens') ??
        readNumberParam(request.params, 'max_tokens') ??
        4096;
      const temperature = readNumberParam(request.params, 'temperature');

      const response = await client.messages.create(
        {
          model: request.model,
          max_tokens: maxTokens,
          temperature,
          system: request.systemInstruction?.trim() || undefined,
          messages: toAnthropicMessages(request.messages),
        },
        { signal: abortSignal },
      );

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      return {
        text,
        modelVersion: response.model,
        provider: id,
        model: request.model,
      };
    },
  };
}
