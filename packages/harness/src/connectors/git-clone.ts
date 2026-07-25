import { mkdirSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { FunctionTool } from '@google/adk';
import type { ToolContractInput } from '@agent-env/shared';
import { z } from 'zod';
import {
  createDefaultProcessRunner,
  type ProcessRunner,
} from '../runtime/process-runner.js';
import { createGuardedTool } from '../runtime/tool-gateway.js';

const DEFAULT_GITHUB_HTTPS =
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/;

export interface CreateGitCloneToolOptions {
  /**
   * Parent directory for clone workdirs (created if missing).
   * Absolute path or lazy getter — caller owns the layout (e.g. `.runs/...`).
   */
  parentDir: string | (() => string);
  /** Tool name. Default: "clone_repo". */
  name?: string;
  description?: string;
  contract?: Partial<ToolContractInput>;
  /** Restrict clone URLs. Default: public https://github.com/owner/repo. */
  urlPattern?: RegExp;
  /** Depth for shallow clone. Default: 1. Pass 0 for full history. */
  depth?: number;
  gitBin?: string;
  runner?: ProcessRunner;
  timeoutMs?: number;
  /** Called after a successful clone with the absolute workdir. */
  onCloned?: (workdir: string) => void;
  /** Directory names omitted from the returned topEntries listing. */
  skipTopEntries?: readonly string[];
}

/**
 * Shallow-clone a git repository into a caller-owned parent directory.
 * Agents inject parentDir / onCloned — do not spawn `git clone` ad hoc.
 */
export function createGitCloneTool(
  options: CreateGitCloneToolOptions,
): FunctionTool {
  const name = options.name ?? 'clone_repo';
  const urlPattern = options.urlPattern ?? DEFAULT_GITHUB_HTTPS;
  const depth = options.depth ?? 1;
  const gitBin = options.gitBin ?? 'git';
  const runner = options.runner ?? createDefaultProcessRunner();
  const timeoutMs = options.timeoutMs ?? 180_000;
  const skipTop = new Set(
    options.skipTopEntries ?? ['.git', 'node_modules', 'dist', 'build'],
  );

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
      'Shallow-clone a git repository (default: public GitHub HTTPS URL) into a sandboxed parent directory.',
    parameters: z.object({
      repoUrl: z
        .string()
        .min(8)
        .describe('Git remote URL to clone (must match the configured URL pattern)'),
      ref: z
        .string()
        .optional()
        .describe('Branch or tag (default branch if omitted)'),
    }),
    publicConfig: {
      depth,
      timeoutMs,
      urlPattern: urlPattern.source,
    },
    execute: async ({ repoUrl, ref }) => {
      if (!urlPattern.test(repoUrl)) {
        return {
          status: 'error' as const,
          message: `repoUrl does not match allowed pattern: ${urlPattern}`,
        };
      }
      const parent =
        typeof options.parentDir === 'function'
          ? options.parentDir()
          : options.parentDir;
      mkdirSync(parent, { recursive: true });
      const namePart = basename(repoUrl.replace(/\.git$/, ''));
      const workdir = join(parent, `${namePart}-${Date.now()}`);

      const args = ['clone'];
      if (depth > 0) args.push('--depth', String(depth));
      if (ref) args.push('--branch', ref);
      args.push(repoUrl, workdir);

      const result = await runner({
        bin: gitBin,
        args,
        timeoutMs,
        maxOutputBytes: 256_000,
      });
      if (result.timedOut || result.exitCode !== 0) {
        return {
          status: 'error' as const,
          message: `git clone failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}): ${result.stderr.trim() || result.stdout.trim()}`,
        };
      }

      const abs = resolve(workdir);
      options.onCloned?.(abs);
      const topEntries = readdirSync(abs).filter((e) => !skipTop.has(e));
      return {
        status: 'success' as const,
        workdir: abs,
        topEntries,
        note: 'Use list_files / read_file with paths inside this workdir.',
      };
    },
  });
}
