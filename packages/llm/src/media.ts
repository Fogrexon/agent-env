/**
 * Provider media capabilities.
 *
 * Every adapter declares exactly which MIME types it forwards to the model.
 * Attachments outside that list fail fast with UnsupportedMediaError instead of
 * being silently dropped on the way to the vendor API.
 */

export type MediaCategory = 'image' | 'audio' | 'video' | 'document' | 'text';

/** One binary attachment handed to a provider adapter. */
export interface ProviderAttachment {
  /** Lowercase MIME type, e.g. "image/png". */
  mimeType: string;
  /** base64-encoded bytes. */
  data: string;
  /** Source path / filename when known (used for filename-aware APIs). */
  name?: string;
}

export interface ProviderMediaSupport {
  /** Exact MIME types the adapter sends to the model. */
  readonly mimeTypes: readonly string[];
  /** Per-attachment byte ceiling enforced before the API call. */
  readonly maxBytesPerFile?: number;
  /** Free-form note surfaced in errors and the admin UI. */
  readonly notes?: string;
}

export const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export const GEMINI_IMAGE_MIME_TYPES = [
  ...IMAGE_MIME_TYPES,
  'image/heic',
  'image/heif',
] as const;

export const GEMINI_AUDIO_MIME_TYPES = [
  'audio/wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/aiff',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
] as const;

export const GEMINI_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/mpeg',
  'video/mov',
  'video/quicktime',
  'video/avi',
  'video/x-flv',
  'video/mpg',
  'video/webm',
  'video/wmv',
  'video/3gpp',
] as const;

export const TEXT_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/xml',
  'application/json',
] as const;

export const PDF_MIME_TYPE = 'application/pdf';

export function mediaCategory(mimeType: string): MediaCategory {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/')) return 'text';
  if (mime === 'application/json') return 'text';
  return 'document';
}

/** Distinct categories covered by a support declaration (stable order). */
export function mediaCategories(
  support: ProviderMediaSupport | undefined,
): MediaCategory[] {
  const order: MediaCategory[] = [
    'image',
    'audio',
    'video',
    'document',
    'text',
  ];
  const present = new Set(
    (support?.mimeTypes ?? []).map((mime) => mediaCategory(mime)),
  );
  return order.filter((category) => present.has(category));
}

export function supportsMedia(
  support: ProviderMediaSupport | undefined,
  mimeType: string,
): boolean {
  if (!support) return false;
  const mime = mimeType.toLowerCase();
  return support.mimeTypes.some((accepted) => accepted.toLowerCase() === mime);
}

/** Byte length of base64 payload without decoding it. */
export function base64ByteLength(data: string): number {
  const clean = data.replace(/=+$/, '');
  return Math.floor((clean.length * 3) / 4);
}

export class UnsupportedMediaError extends Error {
  readonly providerId: string;
  readonly mimeType: string;
  readonly reason: 'mime' | 'size';
  readonly supportedMimeTypes: readonly string[];

  constructor(params: {
    providerId: string;
    mimeType: string;
    reason: 'mime' | 'size';
    message: string;
    supportedMimeTypes: readonly string[];
  }) {
    super(params.message);
    this.name = 'UnsupportedMediaError';
    this.providerId = params.providerId;
    this.mimeType = params.mimeType;
    this.reason = params.reason;
    this.supportedMimeTypes = params.supportedMimeTypes;
  }
}

/** Minimal descriptor for a pre-flight check, before bytes are loaded. */
export interface MediaDescriptor {
  mimeType: string;
  /** Path or filename shown in errors. */
  name?: string;
}

function describeMedia(media: MediaDescriptor): string {
  return media.name ? `${media.name} (${media.mimeType})` : media.mimeType;
}

/**
 * Reject MIME types the provider cannot deliver to the model.
 * Usable before file bytes are read (admin pre-flight, harness run start).
 */
export function assertMimeTypesSupported(
  providerId: string,
  support: ProviderMediaSupport | undefined,
  files: readonly MediaDescriptor[],
): void {
  if (files.length === 0) return;

  if (!support || support.mimeTypes.length === 0) {
    const kinds = [...new Set(files.map((file) => file.mimeType))].join(', ');
    throw new UnsupportedMediaError({
      providerId,
      mimeType: files[0]!.mimeType,
      reason: 'mime',
      supportedMimeTypes: [],
      message:
        `Provider "${providerId}" accepts no media attachments, ` +
        `but ${files.length} were supplied (${kinds}). ` +
        `Use delivery: path in params.yaml, or pick a provider with media support.`,
    });
  }

  for (const file of files) {
    if (supportsMedia(support, file.mimeType)) continue;
    throw new UnsupportedMediaError({
      providerId,
      mimeType: file.mimeType,
      reason: 'mime',
      supportedMimeTypes: support.mimeTypes,
      message:
        `Provider "${providerId}" does not support ${describeMedia(file)}. ` +
        `Supported: ${support.mimeTypes.join(', ')}` +
        (support.notes ? ` — ${support.notes}` : ''),
    });
  }
}

/**
 * Reject attachments the provider cannot actually deliver to the model.
 * Called by every adapter before touching the vendor SDK.
 */
export function assertMediaSupported(
  providerId: string,
  support: ProviderMediaSupport | undefined,
  attachments: readonly ProviderAttachment[],
): void {
  assertMimeTypesSupported(providerId, support, attachments);

  const max = support?.maxBytesPerFile;
  if (max === undefined) return;

  for (const attachment of attachments) {
    const bytes = base64ByteLength(attachment.data);
    if (bytes <= max) continue;
    throw new UnsupportedMediaError({
      providerId,
      mimeType: attachment.mimeType,
      reason: 'size',
      supportedMimeTypes: support!.mimeTypes,
      message:
        `Provider "${providerId}" limits attachments to ${max} bytes, ` +
        `but ${describeMedia(attachment)} is ${bytes} bytes.`,
    });
  }
}
