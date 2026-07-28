import { basename, isAbsolute, resolve } from 'node:path';
import type { AgentAttachment } from '@agent-env/shared';
import { providerSupportsMime } from '@agent-env/llm';
import {
  extractAttachmentText,
  isTranscribableMime,
  type ExtractedText,
} from './extract-text.js';

/** One attachment that was converted to text instead of sent as bytes. */
export interface AttachmentTranscript {
  fieldId: string;
  path: string;
  mimeType: string;
  chars: number;
  truncated: boolean;
  pages?: number;
}

export interface PreparedAttachments {
  /** Attachments still delivered to the provider as bytes. */
  attachments: AgentAttachment[];
  /** Extracted text blocks appended to the user turn. */
  textParts: string[];
  /** Metadata for every attachment turned into text. */
  transcripts: AttachmentTranscript[];
}

export interface PrepareAttachmentsOptions {
  attachments: readonly AgentAttachment[];
  /** Provider id the run will use; undefined = unknown (pass-through). */
  providerId?: string;
  /** Workspace root for resolving relative attachment paths. */
  cwd?: string;
  /** Per-file character ceiling for extracted text. */
  maxCharsPerFile?: number;
  /** Combined character ceiling across all transcribed files. */
  maxTotalChars?: number;
  /** Extraction override (tests / smoke). */
  extract?: typeof extractAttachmentText;
}

const DEFAULT_MAX_CHARS_PER_FILE = 120_000;
const DEFAULT_MAX_TOTAL_CHARS = 400_000;

function truncateChars(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (maxChars <= 0) return { text: '', truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function formatTextPart(
  attachment: AgentAttachment,
  extracted: ExtractedText,
  body: string,
  truncated: boolean,
): string {
  const name = basename(attachment.path);
  const meta = [
    attachment.mimeType,
    `field=${attachment.fieldId}`,
    extracted.pages !== undefined ? `${extracted.pages} pages` : undefined,
    'text-extracted',
    truncated ? 'truncated' : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  return `[attachment: ${name} (${meta})]\n${body}`;
}

/**
 * Split attachments into native (provider-delivered) bytes vs text fallback.
 *
 * - Provider supports the MIME (or is unknown) → keep as a byte attachment.
 * - Provider rejects it but it is transcribable (PDF / text family) → extract
 *   to a text part and drop the byte attachment.
 * - Provider rejects it and it is not transcribable → keep the byte attachment
 *   so the downstream media guard raises UnsupportedMediaError (fail fast).
 */
export async function prepareAttachmentsForProvider(
  options: PrepareAttachmentsOptions,
): Promise<PreparedAttachments> {
  const cwd = options.cwd ?? process.cwd();
  const maxCharsPerFile = options.maxCharsPerFile ?? DEFAULT_MAX_CHARS_PER_FILE;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const extract = options.extract ?? extractAttachmentText;

  const attachments: AgentAttachment[] = [];
  const textParts: string[] = [];
  const transcripts: AttachmentTranscript[] = [];
  let usedChars = 0;

  for (const attachment of options.attachments) {
    const supported = options.providerId
      ? providerSupportsMime(options.providerId, attachment.mimeType)
      : undefined;

    // Native-capable or unknown provider: keep as bytes (existing path).
    if (supported !== false || !isTranscribableMime(attachment.mimeType)) {
      attachments.push(attachment);
      continue;
    }

    const absolute = isAbsolute(attachment.path)
      ? attachment.path
      : resolve(cwd, attachment.path);
    const extracted = await extract(absolute, attachment.mimeType);

    const remaining = Math.max(0, maxTotalChars - usedChars);
    const perFileLimit = Math.min(maxCharsPerFile, remaining);
    const { text: body, truncated } = truncateChars(
      extracted.text,
      perFileLimit,
    );
    usedChars += body.length;

    const suffix = truncated
      ? `\n[truncated: ${extracted.text.length - body.length} chars omitted]`
      : '';
    textParts.push(
      formatTextPart(attachment, extracted, `${body}${suffix}`, truncated),
    );
    transcripts.push({
      fieldId: attachment.fieldId,
      path: attachment.path,
      mimeType: attachment.mimeType,
      chars: body.length,
      truncated,
      ...(extracted.pages !== undefined ? { pages: extracted.pages } : {}),
    });
  }

  return { attachments, textParts, transcripts };
}
