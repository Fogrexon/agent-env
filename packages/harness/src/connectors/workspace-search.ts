import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { FunctionTool } from '@google/adk';
import type { ToolContractInput } from '@agent-env/shared';
import { z } from 'zod';
import { createGuardedTool } from '../runtime/tool-gateway.js';
import {
  assertInsideAnyRoot,
  type WorkspaceRootsSource,
} from './workspace-fs.js';

export interface CreateWorkspaceSearchToolsOptions {
  roots: WorkspaceRootsSource;
  skipDirs?: readonly string[];
  maxGlobMatches?: number;
  maxSearchMatches?: number;
  maxSearchFileBytes?: number;
  maxRangeChars?: number;
  glob?: {
    name?: string;
    description?: string;
    contract?: Partial<ToolContractInput>;
  };
  search?: {
    name?: string;
    description?: string;
    contract?: Partial<ToolContractInput>;
  };
  readRange?: {
    name?: string;
    description?: string;
    contract?: Partial<ToolContractInput>;
  };
}

export interface WorkspaceSearchTools {
  globFiles: FunctionTool;
  searchText: FunctionTool;
  readFileRange: FunctionTool;
  resolvePath: (path: string) => string;
}

const DEFAULT_SKIP = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  '.agent-env',
  '.runs',
] as const;

function normalizeRoots(source: WorkspaceRootsSource): string[] {
  const raw = typeof source === 'function' ? source() : source;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((r) => resolve(r)).filter(Boolean);
}

function resolveRealInsideRoots(path: string, roots: readonly string[]): string {
  const abs = assertInsideAnyRoot(path, roots);
  let real: string;
  try {
    real = existsSync(abs) ? realpathSync(abs) : abs;
  } catch {
    real = abs;
  }
  // Re-check realpath against roots to block symlink escape.
  for (const root of roots) {
    let rootReal = root;
    try {
      rootReal = existsSync(root) ? realpathSync(root) : resolve(root);
    } catch {
      rootReal = resolve(root);
    }
    if (real === rootReal || real.startsWith(rootReal + sep)) return real;
  }
  throw new Error(
    `Path "${path}" realpath escapes allowed workspace roots after symlink resolution`,
  );
}

function matchGlob(relPath: string, pattern: string): boolean {
  const normPath = relPath.replace(/\\/g, '/');
  const normPat = pattern.replace(/\\/g, '/');
  let src = '^';
  for (let i = 0; i < normPat.length; i += 1) {
    const c = normPat[i]!;
    if (c === '*' && normPat[i + 1] === '*') {
      src += '.*';
      i += 1;
      if (normPat[i + 1] === '/') i += 1;
      continue;
    }
    if (c === '*') {
      src += '[^/]*';
      continue;
    }
    if (c === '?') {
      src += '[^/]';
      continue;
    }
    if ('+.^$()[]{}|'.includes(c)) src += `\\${c}`;
    else src += c;
  }
  src += '$';
  return new RegExp(src, 'i').test(normPath);
}

/**
 * Bounded live workspace search: glob / text search / ranged read.
 * Complements indexed knowledge search for exact identifiers and fresh files.
 */
export function createWorkspaceSearchTools(
  options: CreateWorkspaceSearchToolsOptions,
): WorkspaceSearchTools {
  const skipDirs = new Set(options.skipDirs ?? DEFAULT_SKIP);
  const maxGlob = options.maxGlobMatches ?? 200;
  const maxSearch = options.maxSearchMatches ?? 50;
  const maxSearchFileBytes = options.maxSearchFileBytes ?? 1_000_000;
  const maxRangeChars = options.maxRangeChars ?? 12_000;

  const resolvePath = (path: string): string =>
    resolveRealInsideRoots(path, normalizeRoots(options.roots));

  const globName = options.glob?.name ?? 'glob_files';
  const searchName = options.search?.name ?? 'search_text';
  const rangeName = options.readRange?.name ?? 'read_file_range';

  const globFiles = createGuardedTool({
    contract: {
      version: '1.0',
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
      ...options.glob?.contract,
      name: globName,
    },
    description:
      options.glob?.description ??
      'Glob files under an allowed workspace root (bounded, symlink-safe).',
    parameters: z.object({
      dir: z.string().describe('Absolute directory inside allowed roots'),
      pattern: z
        .string()
        .describe('Glob relative to dir, e.g. **/*.ts or src/**/*.md'),
      maxMatches: z.number().int().min(1).max(1000).optional(),
    }),
    publicConfig: { maxGlobMatches: maxGlob },
    execute: ({ dir, pattern, maxMatches }) => {
      const root = resolvePath(dir);
      const cap = maxMatches ?? maxGlob;
      const matches: string[] = [];
      let truncated = false;
      const walk = (current: string): void => {
        if (matches.length >= cap) {
          truncated = true;
          return;
        }
        let entries;
        try {
          entries = readdirSync(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (matches.length >= cap) {
            truncated = true;
            return;
          }
          if (skipDirs.has(entry.name)) continue;
          const abs = join(current, entry.name);
          let real: string;
          try {
            real = realpathSync(abs);
          } catch {
            continue;
          }
          if (!(real === root || real.startsWith(root + sep))) continue;
          if (entry.isDirectory()) {
            walk(abs);
            continue;
          }
          if (!entry.isFile()) continue;
          const rel = relative(root, real).split(sep).join('/');
          if (matchGlob(rel, pattern)) matches.push(real);
        }
      };
      walk(root);
      return {
        status: 'success' as const,
        root,
        pattern,
        count: matches.length,
        files: matches,
        truncated,
      };
    },
  });

  const searchText = createGuardedTool({
    contract: {
      version: '1.0',
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
      ...options.search?.contract,
      name: searchName,
    },
    description:
      options.search?.description ??
      'Search file contents under an allowed root (literal or regex, capped).',
    parameters: z.object({
      dir: z.string(),
      query: z.string().min(1),
      regex: z.boolean().optional(),
      caseInsensitive: z.boolean().optional(),
      glob: z.string().optional(),
      maxMatches: z.number().int().min(1).max(500).optional(),
    }),
    publicConfig: {
      maxSearchMatches: maxSearch,
      maxSearchFileBytes,
    },
    execute: ({
      dir,
      query,
      regex,
      caseInsensitive,
      glob,
      maxMatches,
    }) => {
      const root = resolvePath(dir);
      const cap = maxMatches ?? maxSearch;
      const flags = caseInsensitive === false ? '' : 'i';
      let matcher: RegExp;
      try {
        matcher = regex
          ? new RegExp(query, flags)
          : new RegExp(escapeRegExp(query), flags);
      } catch (err) {
        return {
          status: 'error' as const,
          message: err instanceof Error ? err.message : String(err),
        };
      }
      const hits: Array<{
        path: string;
        line: number;
        text: string;
      }> = [];
      let truncated = false;
      let filesScanned = 0;

      const walk = (current: string): void => {
        if (hits.length >= cap) {
          truncated = true;
          return;
        }
        let entries;
        try {
          entries = readdirSync(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (hits.length >= cap) {
            truncated = true;
            return;
          }
          if (skipDirs.has(entry.name)) continue;
          const abs = join(current, entry.name);
          let real: string;
          try {
            real = realpathSync(abs);
          } catch {
            continue;
          }
          if (!(real === root || real.startsWith(root + sep))) continue;
          if (entry.isDirectory()) {
            walk(abs);
            continue;
          }
          if (!entry.isFile()) continue;
          const rel = relative(root, real).split(sep).join('/');
          if (glob && !matchGlob(rel, glob)) continue;
          let st;
          try {
            st = statSync(real);
          } catch {
            continue;
          }
          if (st.size > maxSearchFileBytes) continue;
          let text: string;
          try {
            text = readFileSync(real, 'utf8');
          } catch {
            continue;
          }
          filesScanned += 1;
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i += 1) {
            if (hits.length >= cap) {
              truncated = true;
              return;
            }
            const line = lines[i]!;
            if (matcher.test(line)) {
              hits.push({
                path: real,
                line: i + 1,
                text: line.slice(0, 400),
              });
            }
            matcher.lastIndex = 0;
          }
        }
      };
      walk(root);
      return {
        status: 'success' as const,
        root,
        query,
        filesScanned,
        count: hits.length,
        hits,
        truncated,
      };
    },
  });

  const readFileRange = createGuardedTool({
    contract: {
      version: '1.0',
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
      ...options.readRange?.contract,
      name: rangeName,
    },
    description:
      options.readRange?.description ??
      'Read a line range from a UTF-8 file inside allowed roots (capped).',
    parameters: z.object({
      path: z.string(),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1).optional(),
      maxChars: z.number().int().min(200).max(50_000).optional(),
    }),
    publicConfig: { maxRangeChars },
    execute: ({ path, startLine, endLine, maxChars }) => {
      const abs = resolvePath(path);
      const cap = maxChars ?? maxRangeChars;
      const end = endLine ?? startLine + 80;
      if (end < startLine) {
        return {
          status: 'error' as const,
          message: 'endLine must be >= startLine',
        };
      }
      const text = readFileSync(abs, 'utf8');
      const lines = text.split(/\r?\n/);
      const slice = lines.slice(startLine - 1, end);
      let content = slice.join('\n');
      let truncated = false;
      if (content.length > cap) {
        content = content.slice(0, cap);
        truncated = true;
      }
      return {
        status: 'success' as const,
        path: abs,
        startLine,
        endLine: Math.min(end, lines.length),
        content,
        truncated,
      };
    },
  });

  return {
    globFiles,
    searchText,
    readFileRange,
    resolvePath,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
