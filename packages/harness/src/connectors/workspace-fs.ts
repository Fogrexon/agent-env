import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import type { FunctionTool } from '@google/adk';
import type { ToolContractInput } from '@agent-env/shared';
import { z } from 'zod';
import { createGuardedTool } from '../runtime/tool-gateway.js';

export type WorkspaceRootsSource =
  | string
  | readonly string[]
  | (() => string | readonly string[]);

export interface CreateWorkspaceFsToolsOptions {
  /**
   * Allowed absolute root(s). Every list/read/write path must resolve inside
   * one of these. Use a getter when roots are registered dynamically (e.g.
   * after git clone).
   */
  roots: WorkspaceRootsSource;
  /** Directory names to skip while listing. */
  skipDirs?: readonly string[];
  maxListEntries?: number;
  maxReadChars?: number;
  list?: {
    name?: string;
    description?: string;
    contract?: Partial<ToolContractInput>;
  };
  read?: {
    name?: string;
    description?: string;
    contract?: Partial<ToolContractInput>;
  };
  write?: {
    name?: string;
    description?: string;
    contract?: Partial<ToolContractInput>;
    /** Extra path check after root jail (throws on failure). */
    assertPath?: (absPath: string) => void;
  };
}

export interface WorkspaceFsTools {
  listFiles: FunctionTool;
  readFile: FunctionTool;
  writeFile: FunctionTool;
  /** Resolve a path against the current allowed roots (throws if outside). */
  resolvePath: (path: string) => string;
}

const DEFAULT_SKIP = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
] as const;

function normalizeRoots(source: WorkspaceRootsSource): string[] {
  const raw = typeof source === 'function' ? source() : source;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((r) => resolve(r)).filter(Boolean);
}

/**
 * Resolve `path` and ensure it stays inside at least one allowed root.
 */
export function assertInsideAnyRoot(
  path: string,
  roots: readonly string[],
): string {
  if (roots.length === 0) {
    throw new Error(
      `Path "${path}" cannot be resolved — no workspace roots are registered yet.`,
    );
  }
  const abs = resolve(path);
  for (const root of roots) {
    const absRoot = resolve(root);
    if (abs === absRoot || abs.startsWith(absRoot + sep)) return abs;
  }
  throw new Error(
    `Path "${path}" is outside allowed workspace roots: ${roots.join(', ')}`,
  );
}

/**
 * Bounded filesystem tools (list / read / write) for agent sandboxes.
 * Reusable across agents that need repo / workdir inspection — inject roots
 * do not reimplement path jail in agents.
 */
export function createWorkspaceFsTools(
  options: CreateWorkspaceFsToolsOptions,
): WorkspaceFsTools {
  const skipDirs = new Set(options.skipDirs ?? DEFAULT_SKIP);
  const defaultListCap = options.maxListEntries ?? 400;
  const defaultReadCap = options.maxReadChars ?? 12_000;

  const resolvePath = (path: string): string =>
    assertInsideAnyRoot(path, normalizeRoots(options.roots));

  const listName = options.list?.name ?? 'list_files';
  const readName = options.read?.name ?? 'read_file';
  const writeName = options.write?.name ?? 'write_file';

  const workspaceSource = {
    connectorId: 'workspace_fs',
    title: 'Workspace FS',
    kind: 'filesystem' as const,
    tags: ['workspace', 'filesystem'],
    description: 'Root-jailed workspace file list / read / write.',
  };

  const listFiles = createGuardedTool({
    contract: {
      version: '1.0',
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
      ...options.list?.contract,
      name: listName,
    },
    description:
      options.list?.description ??
      'Recursively list files under an allowed workspace root (skips common build/deps dirs, capped).',
    parameters: z.object({
      dir: z
        .string()
        .describe('Absolute directory path inside an allowed workspace root'),
      maxEntries: z.number().int().min(1).max(1000).optional(),
    }),
    publicConfig: {
      connectorId: workspaceSource.connectorId,
      kind: workspaceSource.kind,
      title: workspaceSource.title,
      maxListEntries: defaultListCap,
      skipDirs: [...skipDirs],
    },
    source: workspaceSource,
    execute: ({ dir, maxEntries }) => {
      const root = resolvePath(dir);
      const cap = maxEntries ?? defaultListCap;
      const files: string[] = [];
      const walk = (current: string, prefix: string): void => {
        if (files.length >= cap) return;
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          if (files.length >= cap) return;
          if (skipDirs.has(entry.name)) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(join(current, entry.name), rel);
          } else {
            files.push(rel);
          }
        }
      };
      walk(root, '');
      return {
        status: 'success' as const,
        root,
        count: files.length,
        files,
        truncated: files.length >= cap,
      };
    },
  });

  const readFileTool = createGuardedTool({
    contract: {
      version: '1.0',
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
      ...options.read?.contract,
      name: readName,
    },
    description:
      options.read?.description ??
      'Read a UTF-8 file inside an allowed workspace root (content capped).',
    parameters: z.object({
      path: z
        .string()
        .describe('Absolute file path inside an allowed workspace root'),
      maxChars: z.number().int().min(200).max(50_000).optional(),
    }),
    publicConfig: {
      connectorId: workspaceSource.connectorId,
      kind: workspaceSource.kind,
      title: workspaceSource.title,
      maxReadChars: defaultReadCap,
    },
    source: workspaceSource,
    execute: ({ path, maxChars }) => {
      const abs = resolvePath(path);
      const cap = maxChars ?? defaultReadCap;
      const size = statSync(abs).size;
      const content = readFileSync(abs, 'utf8').slice(0, cap);
      return {
        status: 'success' as const,
        path: abs,
        sizeBytes: size,
        content,
        truncated: size > cap,
      };
    },
  });

  const writeFileTool = createGuardedTool({
    contract: {
      version: '1.0',
      riskClass: 'T2',
      sideEffect: 'reversible',
      idempotency: 'supported',
      ...options.write?.contract,
      name: writeName,
    },
    description:
      options.write?.description ??
      'Overwrite a file inside an allowed workspace root.',
    parameters: z.object({
      path: z
        .string()
        .describe('Absolute file path inside an allowed workspace root'),
      content: z.string().describe('Full new file content'),
    }),
    publicConfig: {
      connectorId: workspaceSource.connectorId,
      kind: workspaceSource.kind,
      title: workspaceSource.title,
    },
    source: workspaceSource,
    execute: ({ path, content }) => {
      const abs = resolvePath(path);
      options.write?.assertPath?.(abs);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
      return {
        status: 'success' as const,
        path: abs,
        bytes: Buffer.byteLength(content, 'utf8'),
      };
    },
  });

  return {
    listFiles,
    readFile: readFileTool,
    writeFile: writeFileTool,
    resolvePath,
  };
}
