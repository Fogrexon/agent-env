import OpenAI from 'openai';
import type { ProviderMessage } from './types.js';

export interface OpenAiChatOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  systemInstruction?: string;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

function toOpenAiMessages(
  systemInstruction: string | undefined,
  messages: ProviderMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemInstruction?.trim()) {
    out.push({ role: 'system', content: systemInstruction.trim() });
  }
  for (const message of messages) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: message.text });
      continue;
    }
    out.push({
      role: message.role === 'model' ? 'assistant' : 'user',
      content: message.text,
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
      messages: toOpenAiMessages(options.systemInstruction, options.messages),
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
