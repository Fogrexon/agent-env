import type { Content, Part } from '@google/genai';
import type { ProviderAttachment } from './media.js';
import type { ProviderMessage } from './types.js';

function partText(part: Part): string {
  if (typeof part.text === 'string') return part.text;
  if (part.functionCall) {
    return `[function_call ${part.functionCall.name ?? 'unknown'} ${JSON.stringify(part.functionCall.args ?? {})}]`;
  }
  if (part.functionResponse) {
    return `[function_response ${part.functionResponse.name ?? 'unknown'} ${JSON.stringify(part.functionResponse.response ?? {})}]`;
  }
  return '';
}

export function contentToText(content: Content): string {
  const parts = content.parts ?? [];
  return parts.map(partText).filter(Boolean).join('\n').trim();
}

export function contentsToMessages(contents: Content[]): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  for (const content of contents) {
    const text = contentToText(content);
    if (!text) continue;
    const role =
      content.role === 'model' || content.role === 'assistant'
        ? 'model'
        : content.role === 'system'
          ? 'system'
          : 'user';
    messages.push({ role, text });
  }
  return messages;
}

/**
 * Collect inlineData parts (multimodal attachments) from ADK contents so
 * non-Gemini adapters can map them onto their own vendor payloads.
 */
export function contentsToAttachments(
  contents: readonly Content[] | undefined,
): ProviderAttachment[] {
  const attachments: ProviderAttachment[] = [];
  for (const content of contents ?? []) {
    for (const part of content.parts ?? []) {
      const inline = part.inlineData;
      if (!inline?.data || !inline.mimeType) continue;
      attachments.push({
        mimeType: inline.mimeType.toLowerCase(),
        data: inline.data,
        ...(inline.displayName ? { name: inline.displayName } : {}),
      });
    }
  }
  return attachments;
}

export function systemInstructionToText(
  systemInstruction: unknown,
): string | undefined {
  if (systemInstruction == null) return undefined;
  if (typeof systemInstruction === 'string') return systemInstruction.trim() || undefined;
  if (typeof systemInstruction === 'object' && systemInstruction !== null) {
    const content = systemInstruction as Content;
    const text = contentToText(content);
    return text || undefined;
  }
  return undefined;
}

/** Flatten messages into a single prompt for agent-style providers (Cursor). */
export function messagesToPrompt(
  systemInstruction: string | undefined,
  messages: ProviderMessage[],
): string {
  const blocks: string[] = [];
  if (systemInstruction?.trim()) {
    blocks.push(`System:\n${systemInstruction.trim()}`);
  }
  for (const message of messages) {
    const label =
      message.role === 'model'
        ? 'Assistant'
        : message.role === 'system'
          ? 'System'
          : 'User';
    blocks.push(`${label}:\n${message.text}`);
  }
  blocks.push(
    'Assistant:\nRespond as the assistant. Output only the assistant reply.',
  );
  return blocks.join('\n\n');
}
