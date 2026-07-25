import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createUserContent, type Content, type Part } from '@google/genai';
import type { AgentAttachment } from '@agent-env/shared';

/**
 * Build ADK/Gemini user Content from text + optional file attachments.
 * `delivery: content` attachments are inlined as multimodal parts.
 */
export function buildUserContent(
  message: string,
  attachments: readonly AgentAttachment[] = [],
  cwd: string = process.cwd(),
): Content {
  if (attachments.length === 0) {
    return createUserContent(message);
  }

  const parts: Part[] = [{ text: message }];
  for (const attachment of attachments) {
    const absolute = isAbsolute(attachment.path)
      ? attachment.path
      : resolve(cwd, attachment.path);
    const data = readFileSync(absolute).toString('base64');
    parts.push({
      inlineData: {
        data,
        mimeType: attachment.mimeType,
      },
    });
  }
  return createUserContent(parts);
}
