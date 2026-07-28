/**
 * Offline smoke for attachment text fallback (no network / LLM).
 *
 * Verifies prepareAttachmentsForProvider routes PDF / text attachments to
 * native bytes vs extracted text depending on the provider's declared media,
 * that non-transcribable unsupported media still fails fast, and that the
 * per-file character ceiling truncates.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareAttachmentsForProvider,
  registerProviders,
} from '@agent-env/harness';
import {
  UnsupportedMediaError,
  assertProviderAcceptsMedia,
} from '@agent-env/llm';
import type { AgentAttachment } from '@agent-env/shared';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const PDF_MARKER = 'AGENT-ENV-PDF-SMOKE';

/** Assemble a tiny single-page PDF with a correct xref table. */
function buildMinimalPdf(text: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    (() => {
      const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET\n`;
      return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`;
    })(),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  const header = '%PDF-1.4\n';
  let body = header;
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(body);
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${count} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, 'binary');
}

const dir = mkdtempSync(join(tmpdir(), 'agent-env-attach-'));

try {
  writeFileSync(join(dir, 'note.md'), '# Title\n\nMD-SMOKE-BODY\n');
  writeFileSync(join(dir, 'plain.txt'), 'TXT-SMOKE-BODY\n');
  writeFileSync(join(dir, 'data.json'), '{"marker":"JSON-SMOKE-BODY"}\n');
  writeFileSync(join(dir, 'doc.pdf'), buildMinimalPdf(PDF_MARKER));

  const docAttachments: AgentAttachment[] = [
    { fieldId: 'documents', path: join(dir, 'doc.pdf'), mimeType: 'application/pdf' },
    { fieldId: 'documents', path: join(dir, 'note.md'), mimeType: 'text/markdown' },
    { fieldId: 'documents', path: join(dir, 'plain.txt'), mimeType: 'text/plain' },
    { fieldId: 'documents', path: join(dir, 'data.json'), mimeType: 'application/json' },
  ];

  // Dummy keys so the providers register (offline; no calls are made).
  registerProviders({
    cursor: { apiKey: 'smoke-key' },
    gemini: { apiKey: 'smoke-key' },
    openai: { apiKey: 'smoke-key' },
  });

  // cursor: image-only → all 4 become text transcripts, no byte attachments.
  const cursor = await prepareAttachmentsForProvider({
    attachments: docAttachments,
    providerId: 'cursor',
  });
  assert(cursor.attachments.length === 0, 'cursor: expected no byte attachments');
  assert(cursor.transcripts.length === 4, 'cursor: expected 4 transcripts');
  const cursorText = cursor.textParts.join('\n');
  assert(
    cursorText.includes(PDF_MARKER),
    'cursor: PDF text should contain the marker',
  );
  assert(
    cursorText.includes('MD-SMOKE-BODY') &&
      cursorText.includes('TXT-SMOKE-BODY') &&
      cursorText.includes('JSON-SMOKE-BODY'),
    'cursor: text bodies should be inlined',
  );
  const pdfTranscript = cursor.transcripts.find((t) =>
    t.path.endsWith('.pdf'),
  );
  assert(
    (pdfTranscript?.pages ?? 0) >= 1,
    'cursor: PDF transcript should report pages',
  );

  // gemini: PDF + text are native → everything stays as bytes, no transcripts.
  const gemini = await prepareAttachmentsForProvider({
    attachments: docAttachments,
    providerId: 'gemini',
  });
  assert(
    gemini.attachments.length === 4 && gemini.transcripts.length === 0,
    'gemini: expected all native, no transcripts',
  );

  // openai: PDF native, but text/markdown unsupported → md transcribed.
  const openai = await prepareAttachmentsForProvider({
    attachments: docAttachments,
    providerId: 'openai',
  });
  const openaiNativeMimes = openai.attachments.map((a) => a.mimeType).sort();
  assert(
    openaiNativeMimes.includes('application/pdf'),
    'openai: PDF should stay native',
  );
  assert(
    openai.transcripts.some((t) => t.mimeType === 'text/markdown'),
    'openai: markdown should be transcribed',
  );

  // Image stays native on cursor; video is not transcribable → fails fast.
  writeFileSync(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const imagePrepared = await prepareAttachmentsForProvider({
    attachments: [
      { fieldId: 'img', path: join(dir, 'pic.png'), mimeType: 'image/png' },
    ],
    providerId: 'cursor',
  });
  assert(
    imagePrepared.attachments.length === 1 &&
      imagePrepared.transcripts.length === 0,
    'cursor: png should stay native',
  );

  const videoPrepared = await prepareAttachmentsForProvider({
    attachments: [
      { fieldId: 'vid', path: join(dir, 'clip.mp4'), mimeType: 'video/mp4' },
    ],
    providerId: 'cursor',
  });
  assert(
    videoPrepared.attachments.length === 1 &&
      videoPrepared.transcripts.length === 0,
    'cursor: non-transcribable video should remain a byte attachment',
  );
  let rejected = false;
  try {
    assertProviderAcceptsMedia(
      'cursor',
      videoPrepared.attachments.map((a) => ({
        mimeType: a.mimeType,
        name: a.path,
      })),
    );
  } catch (err) {
    rejected = err instanceof UnsupportedMediaError;
  }
  assert(rejected, 'cursor: video should fail the media guard');

  // Per-file ceiling truncates and reports it.
  const truncated = await prepareAttachmentsForProvider({
    attachments: [
      { fieldId: 'documents', path: join(dir, 'plain.txt'), mimeType: 'text/plain' },
    ],
    providerId: 'cursor',
    maxCharsPerFile: 4,
  });
  assert(
    truncated.transcripts[0]?.truncated === true &&
      truncated.transcripts[0]?.chars === 4,
    'truncation: expected 4 chars and truncated=true',
  );
  assert(
    truncated.textParts[0]?.includes('[truncated:'),
    'truncation: text part should note omitted chars',
  );

  console.log('✓ smoke-attachments passed');
  console.log(`  cursor: ${cursor.transcripts.length} transcribed (pdf+md+txt+json)`);
  console.log(`  gemini: ${gemini.attachments.length} native`);
  console.log(
    `  openai: ${openai.attachments.length} native, ${openai.transcripts.length} transcribed`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
