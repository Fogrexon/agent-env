import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import {
  assertMediaSupported,
  mediaCategory,
  PDF_MIME_TYPE,
  type ProviderAttachment,
  type ProviderMediaSupport,
} from '../media.js';
import { readNumberParam } from '../openai-chat.js';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderMessage,
  ProviderStreamChunk,
  SecretSource,
} from '../types.js';
import { resolveSecret } from '../types.js';

/**
 * Claude accepts image blocks (jpeg/png/gif/webp) and PDF document blocks.
 * No audio or video input channel.
 */
export const ANTHROPIC_MEDIA_SUPPORT: ProviderMediaSupport = {
  mimeTypes: [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    PDF_MIME_TYPE,
  ],
  maxBytesPerFile: 32 * 1024 * 1024,
  notes: 'Images up to ~5MB each; PDFs are sent as document blocks.',
};

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

function toAnthropicBlock(
  attachment: ProviderAttachment,
): Anthropic.ContentBlockParam {
  if (mediaCategory(attachment.mimeType) === 'image') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.mimeType as Anthropic.Base64ImageSource['media_type'],
        data: attachment.data,
      },
    };
  }
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: attachment.data,
    },
    ...(attachment.name ? { title: attachment.name } : {}),
  };
}

function toAnthropicMessages(
  messages: ProviderMessage[],
  attachments: readonly ProviderAttachment[],
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  const lastUserIndex = messages.reduce(
    (found, message, index) => (message.role !== 'model' ? index : found),
    -1,
  );
  for (const [index, message] of messages.entries()) {
    const role = message.role === 'model' ? 'assistant' : 'user';
    const withMedia = index === lastUserIndex && attachments.length > 0;
    out.push({
      role,
      content: withMedia
        ? [
            { type: 'text', text: message.text },
            ...attachments.map(toAnthropicBlock),
          ]
        : message.text,
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
    media: ANTHROPIC_MEDIA_SUPPORT,

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
      const attachments = request.attachments ?? [];
      assertMediaSupported(id, ANTHROPIC_MEDIA_SUPPORT, attachments);

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
          messages: toAnthropicMessages(request.messages, attachments),
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

    async *generateStream(
      request: ProviderGenerateRequest,
      abortSignal?: AbortSignal,
    ): AsyncGenerator<ProviderStreamChunk, ProviderGenerateResult, void> {
      this.assertConfigured();
      const attachments = request.attachments ?? [];
      assertMediaSupported(id, ANTHROPIC_MEDIA_SUPPORT, attachments);

      const client = createClient(options);

      const maxTokens =
        readNumberParam(request.params, 'maxTokens') ??
        readNumberParam(request.params, 'max_tokens') ??
        4096;
      const temperature = readNumberParam(request.params, 'temperature');

      const stream = client.messages.stream(
        {
          model: request.model,
          max_tokens: maxTokens,
          temperature,
          system: request.systemInstruction?.trim() || undefined,
          messages: toAnthropicMessages(request.messages, attachments),
        },
        { signal: abortSignal },
      );

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta' &&
          event.delta.text
        ) {
          yield { delta: event.delta.text };
        }
      }

      const response = await stream.finalMessage();
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
