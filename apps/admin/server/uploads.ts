import { mkdirSync, writeFileSync, existsSync, createReadStream } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { mimeTypeFromPath } from '@agent-env/harness';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function sanitizeFilename(name: string): string {
  const base = name.replace(/[/\\]/g, '_').replace(/[^\w.\- ()[\]]+/g, '_');
  return base.slice(0, 180) || 'upload.bin';
}

function resolveUnderRoot(repoRoot: string, relPath: string): string | null {
  const root = resolve(repoRoot);
  const absolute = resolve(repoRoot, relPath);
  const rootLower = root.toLowerCase();
  const absLower = absolute.toLowerCase();
  if (absLower !== rootLower && !absLower.startsWith(rootLower + '\\') && !absLower.startsWith(rootLower + '/')) {
    return null;
  }
  return absolute;
}

/**
 * Save multipart/form-data files under .agent-env/uploads/ and return
 * repo-relative paths for AgentParams file/image fields.
 */
export function createUploadHandler(repoRoot: string) {
  const uploadRoot = resolve(repoRoot, '.agent-env', 'uploads');

  return async (req: Request, res: Response): Promise<void> => {
    try {
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('multipart/form-data')) {
        res.status(400).json({
          error: 'Content-Type must be multipart/form-data',
        });
        return;
      }

      const busboyMod = await import('busboy');
      const Busboy = busboyMod.default;
      const bb = Busboy({
        headers: req.headers,
        limits: { files: 20, fileSize: MAX_UPLOAD_BYTES },
      });

      mkdirSync(uploadRoot, { recursive: true });
      const saved: Array<{
        path: string;
        originalName: string;
        mimeType: string;
        size: number;
      }> = [];
      let failed: string | undefined;

      bb.on('file', (_name, file, info) => {
        const chunks: Buffer[] = [];
        let size = 0;
        file.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_UPLOAD_BYTES) {
            failed = `file too large (max ${MAX_UPLOAD_BYTES} bytes)`;
            file.resume();
            return;
          }
          chunks.push(chunk);
        });
        file.on('limit', () => {
          failed = `file too large (max ${MAX_UPLOAD_BYTES} bytes)`;
        });
        file.on('end', () => {
          if (failed) return;
          const originalName = sanitizeFilename(info.filename || 'upload.bin');
          const stamp = randomUUID().slice(0, 8);
          const stored = `${stamp}-${originalName}`;
          const absolute = join(uploadRoot, stored);
          const buffer = Buffer.concat(chunks);
          writeFileSync(absolute, buffer);
          saved.push({
            path: relative(repoRoot, absolute).split('\\').join('/'),
            originalName,
            mimeType: info.mimeType || mimeTypeFromPath(originalName),
            size: buffer.length,
          });
        });
      });

      bb.on('error', (err: Error) => {
        failed = err.message;
      });

      bb.on('finish', () => {
        if (failed) {
          res.status(400).json({ error: failed });
          return;
        }
        if (saved.length === 0) {
          res.status(400).json({ error: 'no files uploaded' });
          return;
        }
        res.status(201).json({ files: saved });
      });

      req.pipe(bb);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/** Serve a repo-relative file for admin previews (path traversal guarded). */
export function createUploadPreviewHandler(repoRoot: string) {
  return (req: Request, res: Response): void => {
    const rel = typeof req.query['path'] === 'string' ? req.query['path'] : '';
    if (!rel.trim()) {
      res.status(400).json({ error: 'path query required' });
      return;
    }
    const absolute = resolveUnderRoot(repoRoot, rel);
    if (!absolute || !existsSync(absolute)) {
      res.status(404).json({ error: 'file not found' });
      return;
    }
    res.setHeader('Content-Type', mimeTypeFromPath(absolute));
    createReadStream(absolute).pipe(res);
  };
}
