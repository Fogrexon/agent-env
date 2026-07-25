/**
 * Offline smoke for http-download + markdown-pdf factories (no network / no Chromium).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseTool } from '@google/adk';
import {
  createHttpDownloadTool,
  createMarkdownPdfTool,
} from '@agent-env/harness';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function callTool(
  tool: BaseTool,
  args: Record<string, unknown>,
): Promise<unknown> {
  const stubToolContext = {} as Parameters<
    BaseTool['runAsync']
  >[0]['toolContext'];
  return tool.runAsync({ args, toolContext: stubToolContext });
}

const root = mkdtempSync(join(tmpdir(), 'agent-env-dl-'));
const outside = mkdtempSync(join(tmpdir(), 'agent-env-out-'));

try {
  // Minimal PNG (1x1)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  const download = createHttpDownloadTool({
    roots: [root],
    fetchImpl: async () =>
      new Response(png, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
  });

  const ok = (await callTool(download, {
    url: 'https://example.com/fig.png',
    destPath: join(root, 'images'),
  })) as { status: string; path?: string; bytes?: number };
  assert(ok.status === 'success', 'download success');
  assert(
    typeof ok.path === 'string' && ok.path.includes('images'),
    'path under images',
  );
  assert(ok.bytes === png.byteLength, 'bytes match');
  assert(readFileSync(ok.path!).equals(png), 'file contents');

  const denied = (await callTool(download, {
    url: 'https://example.com/fig.png',
    destPath: join(outside, 'evil.png'),
  })) as { status: string; message?: string };
  assert(denied.status === 'error', 'outside root returns error');
  assert(
    typeof denied.message === 'string' &&
      denied.message.toLowerCase().includes('outside'),
    'outside message',
  );

  const mdPath = join(root, 'report.md');
  const pdfPath = join(root, 'report.pdf');
  writeFileSync(mdPath, '# Hello\n\n![x](images/fig.png)\n', 'utf8');

  const fakePdf = Buffer.from('%PDF-1.4 fake');
  const pdfTool = createMarkdownPdfTool({
    roots: [root],
    convert: async () => fakePdf,
  });
  const pdfResult = (await callTool(pdfTool, {
    markdownPath: mdPath,
    pdfPath,
  })) as { status: string; bytes?: number };
  assert(pdfResult.status === 'success', 'pdf success');
  assert(readFileSync(pdfPath).equals(fakePdf), 'pdf written');

  console.log('✓ smoke-http-download-pdf passed');
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
