import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { FunctionTool } from '@google/adk';
import type { ToolContractInput } from '@agent-env/shared';
import { z } from 'zod';
import { createGuardedTool } from '../runtime/tool-gateway.js';
import type { HttpFetch } from './http.js';
import {
  assertInsideAnyRoot,
  type WorkspaceRootsSource,
} from './workspace-fs.js';

const DEFAULT_ALLOWED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
] as const;

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

export interface CreateHttpDownloadToolOptions {
  /** Allowed absolute root(s). Destination must resolve inside one. */
  roots: WorkspaceRootsSource;
  /** Tool name. Default: "download_url". */
  name?: string;
  description?: string;
  contract?: Partial<ToolContractInput>;
  /** Max response body bytes. Default: 8 MiB. */
  maxBytes?: number;
  /** Allowed Content-Type prefixes or exact values. */
  allowedContentTypes?: readonly string[];
  timeoutMs?: number;
  /** Inject for tests; defaults to global fetch. */
  fetchImpl?: HttpFetch;
  /**
   * Optional T1+ approval. Default: auto (T1 is auto-allowed by gateway).
   * Provide to further restrict writes.
   */
  approve?: (args: {
    contract: { name: string; riskClass: string };
    input: { url: string; destPath: string; filename?: string };
  }) => Promise<boolean> | boolean;
}

function normalizeRoots(source: WorkspaceRootsSource): string[] {
  const raw = typeof source === 'function' ? source() : source;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((r) => resolve(r)).filter(Boolean);
}

function parseContentType(header: string | null): string {
  if (!header) return '';
  return header.split(';')[0]?.trim().toLowerCase() ?? '';
}

function contentTypeAllowed(
  contentType: string,
  allowed: readonly string[],
): boolean {
  if (!contentType) return false;
  return allowed.some(
    (a) => contentType === a || contentType.startsWith(`${a};`),
  );
}

function safeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 180) : 'download';
}

function filenameFromUrl(url: string, contentType: string): string {
  try {
    const u = new URL(url);
    const base = basename(u.pathname);
    if (base && extname(base)) return safeFilename(base);
  } catch {
    // fall through
  }
  const ext = EXT_BY_TYPE[contentType] ?? '.bin';
  return `download${ext}`;
}

/**
 * Download a remote URL into an allowed workspace root (binary-safe).
 * Prefer this over agent-local fetch + write for reusable asset ingestion.
 */
export function createHttpDownloadTool(
  options: CreateHttpDownloadToolOptions,
): FunctionTool {
  const name = options.name ?? 'download_url';
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const allowedTypes = options.allowedContentTypes ?? DEFAULT_ALLOWED_TYPES;

  return createGuardedTool({
    contract: {
      version: '1.0',
      riskClass: 'T1',
      sideEffect: 'reversible',
      idempotency: 'supported',
      timeoutMs,
      ...options.contract,
      name,
    },
    description:
      options.description ??
      'Download a URL (default: images) into an allowed workspace path.',
    parameters: z.object({
      url: z.string().url().describe('Absolute http(s) URL to download'),
      destPath: z
        .string()
        .describe(
          'Absolute destination file path, OR absolute directory (then filename is derived)',
        ),
      filename: z
        .string()
        .optional()
        .describe('Filename when destPath is a directory'),
    }),
    publicConfig: {
      timeoutMs,
      maxBytes,
      allowedContentTypes: [...allowedTypes],
    },
    approve: options.approve
      ? (args) => options.approve!(args)
      : undefined,
    execute: async ({ url, destPath, filename }) => {
      const roots = normalizeRoots(options.roots);
      if (roots.length === 0) {
        return {
          status: 'error',
          message:
            'No workspace roots registered. Call register_workspace first.',
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: { Accept: allowedTypes.join(', ') + ', */*;q=0.1' },
        });
        if (!response.ok) {
          return {
            status: 'error',
            message: `HTTP ${response.status} for ${url}`,
          };
        }

        const contentType = parseContentType(
          response.headers.get('content-type'),
        );
        if (!contentTypeAllowed(contentType, allowedTypes)) {
          return {
            status: 'error',
            message: `Content-Type "${contentType || '(missing)'}" is not allowed. Allowed: ${allowedTypes.join(', ')}`,
          };
        }

        const contentLength = response.headers.get('content-length');
        if (contentLength && Number(contentLength) > maxBytes) {
          return {
            status: 'error',
            message: `Content-Length ${contentLength} exceeds maxBytes ${maxBytes}`,
          };
        }

        const buf = Buffer.from(await response.arrayBuffer());
        if (buf.byteLength > maxBytes) {
          return {
            status: 'error',
            message: `Body ${buf.byteLength} bytes exceeds maxBytes ${maxBytes}`,
          };
        }

        const destResolved = resolve(destPath);
        const looksLikeDir =
          !extname(destResolved) || destResolved.endsWith('/') || destResolved.endsWith('\\');
        const fileName = safeFilename(
          filename ??
            (looksLikeDir
              ? filenameFromUrl(url, contentType)
              : basename(destResolved)),
        );
        const absFile = looksLikeDir
          ? join(destResolved, fileName)
          : filename
            ? join(dirname(destResolved), fileName)
            : destResolved;

        const abs = assertInsideAnyRoot(absFile, roots);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, buf);

        return {
          status: 'success' as const,
          path: abs,
          bytes: buf.byteLength,
          contentType,
          url,
        };
      } catch (err) {
        return {
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
