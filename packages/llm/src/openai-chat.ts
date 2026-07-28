import OpenAI from 'openai';
import { mediaCategory, type ProviderAttachment } from './media.js';
import type { ProviderMessage } from './types.js';

export interface OpenAiChatOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  systemInstruction?: string;
  messages: ProviderMessage[];
  /** Attached to the last user message as multimodal content parts. */
  attachments?: readonly ProviderAttachment[];
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

function dataUrl(attachment: ProviderAttachment): string {
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}

/** Chat Completions audio parts take a bare format name, not a MIME type. */
function audioFormat(mimeType: string): 'wav' | 'mp3' {
  return mimeType.toLowerCase().includes('wav') ? 'wav' : 'mp3';
}

function toContentPart(
  attachment: ProviderAttachment,
): OpenAI.Chat.ChatCompletionContentPart {
  switch (mediaCategory(attachment.mimeType)) {
    case 'image':
      return { type: 'image_url', image_url: { url: dataUrl(attachment) } };
    case 'audio':
      return {
        type: 'input_audio',
        input_audio: {
          data: attachment.data,
          format: audioFormat(attachment.mimeType),
        },
      };
    default:
      return {
        type: 'file',
        file: {
          filename: attachment.name ?? 'attachment',
          file_data: dataUrl(attachment),
        },
      };
  }
}

export function toOpenAiMessages(
  systemInstruction: string | undefined,
  messages: ProviderMessage[],
  attachments: readonly ProviderAttachment[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemInstruction?.trim()) {
    out.push({ role: 'system', content: systemInstruction.trim() });
  }
  const lastUserIndex = messages.reduce(
    (found, message, index) => (message.role === 'user' ? index : found),
    -1,
  );
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: message.text });
      continue;
    }
    if (message.role === 'model') {
      out.push({ role: 'assistant', content: message.text });
      continue;
    }
    const withMedia = index === lastUserIndex && attachments.length > 0;
    out.push({
      role: 'user',
      content: withMedia
        ? [
            { type: 'text', text: message.text },
            ...attachments.map(toContentPart),
          ]
        : message.text,
    });
  }
  return out;
}

export function readNumberParam(
  params: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = params?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function readStringParam(
  params: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = params?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Shared Chat Completions call for OpenAI and OpenAI-compatible servers. */
export async function openAiChatCompletion(
  options: OpenAiChatOptions,
): Promise<{ text: string; model?: string }> {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });

  const completion = await client.chat.completions.create(
    {
      model: options.model,
      messages: toOpenAiMessages(
        options.systemInstruction,
        options.messages,
        options.attachments ?? [],
      ),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    },
    { signal: options.abortSignal },
  );

  const text = completion.choices[0]?.message?.content?.trim() ?? '';
  return {
    text,
    model: completion.model,
  };
}

/**
 * Streaming Chat Completions. Yields `{ delta }` chunks; return value is the
 * full text + model id.
 */
export async function* openAiChatCompletionStream(
  options: OpenAiChatOptions,
): AsyncGenerator<{ delta: string }, { text: string; model?: string }, void> {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });

  const stream = await client.chat.completions.create(
    {
      model: options.model,
      messages: toOpenAiMessages(
        options.systemInstruction,
        options.messages,
        options.attachments ?? [],
      ),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: true,
    },
    { signal: options.abortSignal },
  );

  let text = '';
  let model: string | undefined;
  for await (const chunk of stream) {
    if (chunk.model) model = chunk.model;
    const delta = chunk.choices[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      text += delta;
      yield { delta };
    }
  }
  return { text: text.trim(), model };
}
