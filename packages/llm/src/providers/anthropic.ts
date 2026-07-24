import Anthropic from '@anthropic-ai/sdk';
import type { ProviderCredentials } from '@agent-env/shared';
import { readNumberParam } from '../openai-chat.js';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderMessage,
} from '../types.js';

function toAnthropicMessages(
  messages: ProviderMessage[],
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      // Fold stray system turns into user text; top-level system is separate.
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

/**
 * Anthropic Messages API adapter.
 * Env: ANTHROPIC_API_KEY
 */
export const anthropicProvider: LlmProvider = {
  id: 'anthropic',

  isConfigured(credentials: ProviderCredentials): boolean {
    return Boolean(credentials.anthropicApiKey?.trim());
  },

  assertConfigured(credentials: ProviderCredentials): void {
    if (!this.isConfigured(credentials)) {
      throw new Error(
        'Anthropic provider requires ANTHROPIC_API_KEY. See https://console.anthropic.com/',
      );
    }
  },

  async generate(
    request: ProviderGenerateRequest,
    credentials: ProviderCredentials,
    abortSignal?: AbortSignal,
  ): Promise<ProviderGenerateResult> {
    this.assertConfigured(credentials);

    const client = new Anthropic({
      apiKey: credentials.anthropicApiKey!.trim(),
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
      provider: 'anthropic',
      model: request.model,
    };
  },
};
