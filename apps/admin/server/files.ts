/**
 * List / serve files under a run history directory (path-jailed).
 */
import {
  createReadStream,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { Request, Response } from 'express';
import { mimeTypeFromPath } from '@agent-env/harness';
import { getAdminRunHistory } from './run-history.js';
import { adminRunStore } from './run-store.js';

const MAX_LIST_FILES = 400;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
]);

function paramString(
  value: string | string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

export interface RunFileEntry {
  /** Path relative to the run history directory (posix-style). */
  path: string;
  bytes: number;
  mime: string;
}

function toPosixRel(rel: string): string {
  return rel.split(sep).join('/');
}

function resolveRunDir(repoRoot: string, runId: string): string | undefined {
  const memory = adminRunStore.get(runId);
  if (memory?.historyDir && existsSync(memory.historyDir)) {
    return resolve(memory.historyDir);
  }
  const fromDisk = getAdminRunHistory(repoRoot).findRunDir(runId);
  return fromDisk ? resolve(fromDisk) : undefined;
}

/**
 * Resolve a relative path under the run dir; returns null on traversal / missing.
 */
export function resolveRunFilePath(
  runDir: string,
  relPath: string,
): string | null {
  const cleaned = relPath.replace(/^[/\\]+/, '');
  if (!cleaned || cleaned.includes('\0')) return null;
  const root = resolve(runDir);
  const abs = resolve(runDir, cleaned);
  const rootLower = root.toLowerCase();
  const absLower = abs.toLowerCase();
  if (
    absLower !== rootLower &&
    !absLower.startsWith(rootLower + '\\') &&
    !absLower.startsWith(rootLower + '/')
  ) {
    return null;
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return abs;
}

function listFilesUnder(runDir: string): RunFileEntry[] {
  const files: RunFileEntry[] = [];
  const walk = (current: string): void => {
    if (files.length >= MAX_LIST_FILES) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_LIST_FILES) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = statSync(abs);
        const rel = toPosixRel(relative(runDir, abs));
        files.push({
          path: rel,
          bytes: st.size,
          mime: mimeTypeFromPath(abs),
        });
      } catch {
        // skip unreadable
      }
    }
  };
  walk(runDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export function createRunFilesListHandler(repoRoot: string) {
  return (req: Request, res: Response): void => {
    const runId = paramString(req.params['runId']);
    if (!runId) {
      res.status(400).json({ error: 'runId required' });
      return;
    }
    const runDir = resolveRunDir(repoRoot, runId);
    if (!runDir) {
      res.status(404).json({ error: `Unknown run or no history: ${runId}` });
      return;
    }
    try {
      const files = listFilesUnder(runDir);
      res.json({
        runId,
        runDir,
        files,
        truncated: files.length >= MAX_LIST_FILES,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export function createRunFileServeHandler(repoRoot: string) {
  return (req: Request, res: Response): void => {
    const runId = paramString(req.params['runId']);
    if (!runId) {
      res.status(400).json({ error: 'runId required' });
      return;
    }
    const runDir = resolveRunDir(repoRoot, runId);
    if (!runDir) {
      res.status(404).json({ error: `Unknown run or no history: ${runId}` });
      return;
    }

    // Express 5 wildcard: /files/*rel
    const raw =
      (req.params as Record<string, string | string[]>)['rel'] ??
      (req.params as Record<string, string | string[]>)['0'] ??
      '';
    const relPath = Array.isArray(raw) ? raw.join('/') : String(raw);
    if (!relPath) {
      res.status(400).json({ error: 'file path required' });
      return;
    }

    const abs = resolveRunFilePath(runDir, relPath);
    if (!abs) {
      res.status(404).json({ error: `File not found: ${relPath}` });
      return;
    }

    const mime = mimeTypeFromPath(abs);
    const download =
      req.query['download'] === '1' || req.query['download'] === 'true';
    res.setHeader('Content-Type', mime);
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename="${basename(abs)}"`,
    );
    createReadStream(abs).pipe(res);
  };
}
