import { readFileSync } from 'node:fs';
import { mediaCategory, PDF_MIME_TYPE } from '@agent-env/llm';

/** Result of turning a binary/text attachment into plain text. */
export interface ExtractedText {
  text: string;
  /** Page count when the source exposes one (PDF). */
  pages?: number;
}

/**
 * MIME types beyond the `text` category / PDF that we can still read as UTF-8.
 * Extension → MIME already maps most code/config to text/plain, but some tools
 * emit these application/* variants.
 */
const EXTRA_TEXT_MIME_TYPES = new Set([
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/x-ndjson',
  'application/toml',
]);

/**
 * Whether an attachment can be converted to text as a provider fallback.
 * Covers text/* (+ application/json via mediaCategory), PDF, and a few
 * application/* text variants.
 */
export function isTranscribableMime(mimeType: string): boolean {
  const mime = mimeType.toLowerCase();
  if (mime === PDF_MIME_TYPE) return true;
  if (mediaCategory(mime) === 'text') return true;
  return EXTRA_TEXT_MIME_TYPES.has(mime);
}

/**
 * Read an attachment as text. PDFs go through unpdf (dynamic import so runs
 * without PDF attachments never pay the load cost); everything else is read as
 * UTF-8. Throws on failure — we never silently drop content.
 */
export async function extractAttachmentText(
  absolutePath: string,
  mimeType: string,
): Promise<ExtractedText> {
  const mime = mimeType.toLowerCase();
  try {
    if (mime === PDF_MIME_TYPE) {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const bytes = new Uint8Array(readFileSync(absolutePath));
      const pdf = await getDocumentProxy(bytes);
      const { text, totalPages } = await extractText(pdf, { mergePages: true });
      return { text, pages: totalPages };
    }
    return { text: readFileSync(absolutePath, 'utf8') };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to extract text from ${absolutePath} (${mimeType}): ${cause}`,
    );
  }
}
