import {
  assertMediaSupported,
  IMAGE_MIME_TYPES,
  PDF_MIME_TYPE,
  type ProviderMediaSupport,
} from '../media.js';
import {
  openAiChatCompletion,
  openAiChatCompletionStream,
  readNumberParam,
  readStringParam,
} from '../openai-chat.js';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStreamChunk,
  SecretSource,
} from '../types.js';
import { resolveSecret } from '../types.js';

/**
 * Chat Completions content parts: image_url (images), input_audio (wav/mp3,
 * audio-capable models only) and file (PDF). No video channel.
 */
export const OPENAI_MEDIA_SUPPORT: ProviderMediaSupport = {
  mimeTypes: [
    ...IMAGE_MIME_TYPES,
    'audio/wav',
    'audio/mpeg',
    'audio/mp3',
    PDF_MIME_TYPE,
  ],
  maxBytesPerFile: 20 * 1024 * 1024,
  notes:
    'Audio requires an audio-capable model (e.g. gpt-4o-audio-preview); PDFs are sent as file parts.',
};

export interface CreateOpenaiProviderOptions {
  id?: string;
  apiKey: SecretSource;
  baseUrl?: string | (() => string | undefined);
}

function resolveOpenAiChatOptions(
  id: string,
  options: CreateOpenaiProviderOptions,
  request: ProviderGenerateRequest,
  abortSignal?: AbortSignal,
) {
  const attachments = request.attachments ?? [];
  assertMediaSupported(id, OPENAI_MEDIA_SUPPORT, attachments);

  const baseURL =
    readStringParam(request.params, 'baseUrl') ??
    readStringParam(request.params, 'baseURL') ??
    (typeof options.baseUrl === 'function'
      ? options.baseUrl()?.trim()
      : options.baseUrl?.trim());

  return {
    apiKey: resolveSecret(options.apiKey)!,
    baseURL: baseURL || undefined,
    model: request.model,
    systemInstruction: request.systemInstruction,
    messages: request.messages,
    attachments,
    temperature: readNumberParam(request.params, 'temperature'),
    maxTokens: readNumberParam(request.params, 'maxTokens'),
    abortSignal,
  };
}

export function createOpenaiProvider(
  options: CreateOpenaiProviderOptions,
): LlmProvider {
  const id = options.id ?? 'openai';

  return {
    id,
    kind: 'openai',
    media: OPENAI_MEDIA_SUPPORT,

    isConfigured(): boolean {
      return Boolean(resolveSecret(options.apiKey));
    },

    assertConfigured(): void {
      if (!this.isConfigured()) {
        throw new Error(
          `OpenAI provider "${id}" has no API key. Pass apiKey when calling createOpenaiProvider().`,
        );
      }
    },

    async generate(
      request: ProviderGenerateRequest,
      abortSignal?: AbortSignal,
    ): Promise<ProviderGenerateResult> {
      this.assertConfigured();
      const result = await openAiChatCompletion(
        resolveOpenAiChatOptions(id, options, request, abortSignal),
      );

      return {
        text: result.text,
        modelVersion: result.model ?? request.model,
        provider: id,
        model: request.model,
      };
    },

    async *generateStream(
      request: ProviderGenerateRequest,
      abortSignal?: AbortSignal,
    ): AsyncGenerator<ProviderStreamChunk, ProviderGenerateResult, void> {
      this.assertConfigured();
      const stream = openAiChatCompletionStream(
        resolveOpenAiChatOptions(id, options, request, abortSignal),
      );
      let next = await stream.next();
      while (!next.done) {
        yield next.value;
        next = await stream.next();
      }
      return {
        text: next.value.text,
        modelVersion: next.value.model ?? request.model,
        provider: id,
        model: request.model,
      };
    },
  };
}
