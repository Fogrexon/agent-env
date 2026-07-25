/**
 * Offline smoke for provider media declarations (no network / LLM).
 * Verifies each adapter's declared MIME set and that unsupported media throws.
 */
import {
  ANTHROPIC_MEDIA_SUPPORT,
  assertMediaSupported,
  CURSOR_MEDIA_SUPPORT,
  GEMINI_MEDIA_SUPPORT,
  listProviderMedia,
  mediaCategories,
  OPENAI_MEDIA_SUPPORT,
  registerProviders,
  supportsMedia,
  UnsupportedMediaError,
} from '@agent-env/llm';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function expectRejected(
  label: string,
  providerId: string,
  support: Parameters<typeof assertMediaSupported>[1],
  mimeType: string,
  data = 'AAAA',
): void {
  try {
    assertMediaSupported(providerId, support, [{ mimeType, data }]);
  } catch (err) {
    assert(
      err instanceof UnsupportedMediaError,
      `${label}: expected UnsupportedMediaError, got ${String(err)}`,
    );
    return;
  }
  throw new Error(`${label}: expected ${mimeType} to be rejected`);
}

// Declared capabilities per provider.
assert(
  supportsMedia(CURSOR_MEDIA_SUPPORT, 'image/png'),
  'cursor should accept png',
);
expectRejected('cursor audio', 'cursor', CURSOR_MEDIA_SUPPORT, 'audio/wav');
expectRejected(
  'cursor pdf',
  'cursor',
  CURSOR_MEDIA_SUPPORT,
  'application/pdf',
);

assert(
  supportsMedia(GEMINI_MEDIA_SUPPORT, 'audio/wav') &&
    supportsMedia(GEMINI_MEDIA_SUPPORT, 'video/mp4') &&
    supportsMedia(GEMINI_MEDIA_SUPPORT, 'application/pdf'),
  'gemini should accept audio / video / pdf',
);

assert(
  supportsMedia(OPENAI_MEDIA_SUPPORT, 'audio/mpeg') &&
    supportsMedia(OPENAI_MEDIA_SUPPORT, 'application/pdf'),
  'openai should accept mp3 audio and pdf',
);
expectRejected('openai video', 'openai', OPENAI_MEDIA_SUPPORT, 'video/mp4');

assert(
  supportsMedia(ANTHROPIC_MEDIA_SUPPORT, 'application/pdf'),
  'anthropic should accept pdf',
);
expectRejected(
  'anthropic audio',
  'anthropic',
  ANTHROPIC_MEDIA_SUPPORT,
  'audio/wav',
);

// Text-only provider: every attachment is rejected.
expectRejected('no media', 'text-only', undefined, 'image/png');

// Size ceiling is enforced before the vendor call.
expectRejected(
  'size limit',
  'anthropic',
  { mimeTypes: ['image/png'], maxBytesPerFile: 8 },
  'image/png',
  'A'.repeat(64),
);

assert(
  mediaCategories(GEMINI_MEDIA_SUPPORT).join(',') ===
    'image,audio,video,document,text',
  'gemini categories',
);

// Registry-driven catalog used by the admin API.
registerProviders({
  cursor: { apiKey: 'smoke-key' },
  gemini: { apiKey: 'smoke-key' },
  openaiCompatible: [
    { id: 'smoke-local', baseUrl: 'http://127.0.0.1:1234/v1', media: false },
  ],
});
const catalog = listProviderMedia();
const byId = new Map(catalog.map((info) => [info.id, info]));
assert(byId.get('cursor')?.categories.join(',') === 'image', 'catalog cursor');
assert(
  (byId.get('gemini')?.mimeTypes.length ?? 0) > 10,
  'catalog gemini mime list',
);
assert(
  byId.get('smoke-local')?.mimeTypes.length === 0,
  'media: false disables attachments',
);

console.log('✓ smoke-media passed');
for (const info of catalog) {
  console.log(
    `  ${info.id}: ${info.categories.join(' / ') || '(text only)'} — ${info.mimeTypes.length} mime types`,
  );
}
