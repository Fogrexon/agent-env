import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { readNumberParam } from '../openai-chat.js';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderMessage,
  SecretSource,
} from '../types.js';
import { resolveSecret } from '../types.js';

export type ConfigStringSource = SecretSource;

export interface AnthropicVertexOptions {
  /** GCP project id (ADC). */
  projectId: ConfigStringSource;
  /** Vertex region, e.g. "us-east5". */
  region: ConfigStringSource;
}

export interface CreateAnthropicProviderOptions {
  id?: string;
  /**
   * Anthropic API key.
   * Omit when using `vertex` (Application Default Credentials).
   */
  apiKey?: SecretSource;
  /**
   * Claude on Vertex AI via ADC.
   * When set, `apiKey` is ignored.
   */
  vertex?: AnthropicVertexOptions;
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

function resolveVertex(
  vertex: AnthropicVertexOptions | undefined,
): { projectId: string; region: string } | undefined {
  if (!vertex) return undefined;
  const projectId = resolveSecret(vertex.projectId);
  const region = resolveSecret(vertex.region);
  if (!projectId || !region) return undefined;
  return { projectId, region };
}

function createClient(
  options: CreateAnthropicProviderOptions,
): Anthropic | AnthropicVertex {
  const vertex = resolveVertex(options.vertex);
  if (vertex) {
    return new AnthropicVertex({
      projectId: vertex.projectId,
      region: vertex.region,
    });
  }
  return new Anthropic({
    apiKey: resolveSecret(options.apiKey)!,
  });
}

export function createAnthropicProvider(
  options: CreateAnthropicProviderOptions,
): LlmProvider {
  const id = options.id ?? 'anthropic';

  if (!options.apiKey && !options.vertex) {
    throw new Error(
      `Anthropic provider "${id}" requires apiKey or vertex ({ projectId, region }).`,
    );
  }

  return {
    id,
    kind: 'anthropic',

    isConfigured(): boolean {
      if (options.vertex) return Boolean(resolveVertex(options.vertex));
      return Boolean(resolveSecret(options.apiKey));
    },

    assertConfigured(): void {
      if (!this.isConfigured()) {
        throw new Error(
          options.vertex
            ? `Anthropic provider "${id}" Vertex mode needs projectId and region.`
            : `Anthropic provider "${id}" has no API key. Pass apiKey when calling createAnthropicProvider().`,
        );
      }
    },

    async generate(
      request: ProviderGenerateRequest,
      abortSignal?: AbortSignal,
    ): Promise<ProviderGenerateResult> {
      this.assertConfigured();

      const client = createClient(options);

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
