import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FunctionTool } from '@google/adk';
import type { ToolContractInput } from '@agent-env/shared';
import { z } from 'zod';
import { createGuardedTool } from '../runtime/tool-gateway.js';
import {
  assertInsideAnyRoot,
  type WorkspaceRootsSource,
} from './workspace-fs.js';

export interface CreateMarkdownPdfToolOptions {
  /** Allowed absolute root(s). Markdown and PDF paths must resolve inside. */
  roots: WorkspaceRootsSource;
  /** Tool name. Default: "markdown_to_pdf". */
  name?: string;
  description?: string;
  contract?: Partial<ToolContractInput>;
  /**
   * Inject md-to-pdf for tests. Defaults to dynamic import of `md-to-pdf`.
   */
  convert?: (input: {
    markdown: string;
    basedir: string;
  }) => Promise<Buffer>;
}

function normalizeRoots(source: WorkspaceRootsSource): string[] {
  const raw = typeof source === 'function' ? source() : source;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((r) => resolve(r)).filter(Boolean);
}

async function defaultConvert(input: {
  markdown: string;
  basedir: string;
}): Promise<Buffer> {
  const { mdToPdf } = await import('md-to-pdf');
  const result = await mdToPdf(
    { content: input.markdown },
    {
      basedir: input.basedir,
      launch_options: {
        // Local admin/CLI; allow environments without a sandbox.
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    },
  );
  if (!result?.content) {
    throw new Error('md-to-pdf returned empty content');
  }
  return Buffer.from(result.content);
}

/**
 * Convert a Markdown file (with relative images) to PDF inside allowed roots.
 * Uses md-to-pdf (Chromium). Agents inject roots; do not shell out ad hoc.
 */
export function createMarkdownPdfTool(
  options: CreateMarkdownPdfToolOptions,
): FunctionTool {
  const name = options.name ?? 'markdown_to_pdf';
  const convert = options.convert ?? defaultConvert;

  return createGuardedTool({
    contract: {
      version: '1.0',
      riskClass: 'T1',
      sideEffect: 'reversible',
      idempotency: 'supported',
      timeoutMs: 120_000,
      ...options.contract,
      name,
    },
    description:
      options.description ??
      'Convert a Markdown file under an allowed workspace root to PDF (relative images resolved from the MD directory).',
    parameters: z.object({
      markdownPath: z
        .string()
        .describe('Absolute path to the source .md file'),
      pdfPath: z.string().describe('Absolute path for the output .pdf file'),
    }),
    publicConfig: {
      engine: 'md-to-pdf',
    },
    execute: async ({ markdownPath, pdfPath }) => {
      const roots = normalizeRoots(options.roots);
      if (roots.length === 0) {
        return {
          status: 'error',
          message:
            'No workspace roots registered. Call register_workspace first.',
        };
      }

      try {
        const mdAbs = assertInsideAnyRoot(markdownPath, roots);
        const pdfAbs = assertInsideAnyRoot(pdfPath, roots);
        const markdown = readFileSync(mdAbs, 'utf8');
        const basedir = dirname(mdAbs);
        const pdfBuf = await convert({ markdown, basedir });
        mkdirSync(dirname(pdfAbs), { recursive: true });
        writeFileSync(pdfAbs, pdfBuf);
        return {
          status: 'success' as const,
          markdownPath: mdAbs,
          pdfPath: pdfAbs,
          bytes: pdfBuf.byteLength,
        };
      } catch (err) {
        return {
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}
