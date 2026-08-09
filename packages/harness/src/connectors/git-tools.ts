import type { FunctionTool } from '@google/adk';
import type { ToolContractInput } from '@agent-env/shared';
import { z } from 'zod';
import {
  createDefaultProcessRunner,
  type ProcessRunner,
} from '../runtime/process-runner.js';
import { createGuardedTool } from '../runtime/tool-gateway.js';

export interface CreateGitToolsOptions {
  /**
   * Resolve and jail the workdir path before running git.
   * Typically `createWorkspaceFsTools(...).resolvePath`.
   */
  resolveWorkdir: (path: string) => string;
  gitBin?: string;
  runner?: ProcessRunner;
  timeoutMs?: number;
  status?: {
    name?: string;
    description?: string;
    contract?: Partial<ToolContractInput>;
  };
  diff?: {
    name?: string;
    description?: string;
    contract?: Partial<ToolContractInput>;
    maxOutputBytes?: number;
  };
  add?: {
    name?: string;
    description?: string;
    contract?: Partial<ToolContractInput>;
    /**
     * T1 approval. Default: deny (fail closed).
     */
    approve?: (args: {
      contract: { name: string; riskClass: string };
      input: { workdir: string; paths: string[] };
    }) => Promise<boolean> | boolean;
  };
  commit?: {
    name?: string;
    description?: string;
    contract?: Partial<ToolContractInput>;
    /**
     * T2 approval. Default: deny (fail closed).
     */
    approve?: (args: {
      contract: { name: string; riskClass: string };
      input: { workdir: string; message: string };
    }) => Promise<boolean> | boolean;
  };
  push?: {
    name?: string;
    description?: string;
    contract?: Partial<ToolContractInput>;
    /**
     * T3 approval. Default: deny (fail closed).
     * Never exposes --force; callers must not bypass this factory.
     */
    approve?: (args: {
      contract: { name: string; riskClass: string };
      input: { workdir: string; remote: string; branch?: string };
    }) => Promise<boolean> | boolean;
  };
}

export interface GitTools {
  status: FunctionTool;
  diff: FunctionTool;
  add: FunctionTool;
  commit: FunctionTool;
  push: FunctionTool;
}

/**
 * Git read/write tools backed by the `git` CLI.
 * Auth / remotes are whatever the worktree already has — this factory does not
 * read tokens from env. Agents inject resolveWorkdir + per-tool approve only.
 */
export function createGitTools(options: CreateGitToolsOptions): GitTools {
  const gitBin = options.gitBin ?? 'git';
  const runner = options.runner ?? createDefaultProcessRunner();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const diffMaxBytes = options.diff?.maxOutputBytes ?? 64_000;

  const statusName = options.status?.name ?? 'git_status';
  const diffName = options.diff?.name ?? 'git_diff';
  const addName = options.add?.name ?? 'git_add';
  const commitName = options.commit?.name ?? 'git_commit';
  const pushName = options.push?.name ?? 'git_push';

  const runGit = async (
    args: string[],
    cwd: string,
    maxOutputBytes = 256_000,
  ): Promise<{ stdout: string; stderr: string; truncated: boolean }> => {
    const result = await runner({
      bin: gitBin,
      args,
      cwd,
      timeoutMs,
      maxOutputBytes,
    });
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
    };
  };

  const status = createGuardedTool({
    contract: {
      version: '1.0',
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
      timeoutMs,
      ...options.status?.contract,
      name: statusName,
    },
    description:
      options.status?.description ??
      'Show git status (porcelain) for a worktree inside allowed roots.',
    parameters: z.object({
      workdir: z.string().describe('Git worktree directory (must be allowed)'),
    }),
    execute: async ({ workdir }) => {
      const cwd = options.resolveWorkdir(workdir);
      const { stdout, truncated } = await runGit(
        ['status', '--porcelain=v1', '-b'],
        cwd,
      );
      return {
        status: 'success' as const,
        workdir: cwd,
        output: stdout,
        truncated,
      };
    },
  });

  const diff = createGuardedTool({
    contract: {
      version: '1.0',
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
      timeoutMs,
      ...options.diff?.contract,
      name: diffName,
    },
    description:
      options.diff?.description ??
      'Show git diff for unstaged or staged changes (capped output).',
    parameters: z.object({
      workdir: z.string().describe('Git worktree directory (must be allowed)'),
      staged: z
        .boolean()
        .optional()
        .describe('When true, show staged diff (--cached)'),
      paths: z
        .array(z.string())
        .optional()
        .describe('Optional pathspecs to limit the diff'),
    }),
    execute: async ({ workdir, staged, paths }) => {
      const cwd = options.resolveWorkdir(workdir);
      const args = ['diff'];
      if (staged) args.push('--cached');
      if (paths?.length) args.push('--', ...paths);
      const { stdout, truncated } = await runGit(args, cwd, diffMaxBytes);
      return {
        status: 'success' as const,
        workdir: cwd,
        diff: stdout,
        truncated,
      };
    },
  });

  const add = createGuardedTool({
    contract: {
      version: '1.0',
      riskClass: 'T1',
      sideEffect: 'reversible',
      idempotency: 'supported',
      timeoutMs,
      ...options.add?.contract,
      name: addName,
    },
    description:
      options.add?.description ??
      'Stage paths with `git add` (T1 — requires approve).',
    parameters: z.object({
      workdir: z.string().describe('Git worktree directory (must be allowed)'),
      paths: z
        .array(z.string().min(1))
        .min(1)
        .describe('Paths relative to workdir to stage'),
    }),
    approve: options.add?.approve
      ? (args) => options.add!.approve!(args)
      : undefined,
    execute: async ({ workdir, paths }) => {
      const cwd = options.resolveWorkdir(workdir);
      await runGit(['add', '--', ...paths], cwd);
      return {
        status: 'success' as const,
        workdir: cwd,
        staged: paths,
      };
    },
  });

  const commit = createGuardedTool({
    contract: {
      version: '1.0',
      riskClass: 'T2',
      sideEffect: 'reversible',
      idempotency: 'required',
      timeoutMs,
      ...options.commit?.contract,
      name: commitName,
    },
    description:
      options.commit?.description ??
      'Create a git commit with a message (T2 — requires approve).',
    parameters: z.object({
      workdir: z.string().describe('Git worktree directory (must be allowed)'),
      message: z.string().min(8).describe('Commit message'),
    }),
    approve: options.commit?.approve
      ? (args) => options.commit!.approve!(args)
      : undefined,
    execute: async ({ workdir, message }) => {
      const cwd = options.resolveWorkdir(workdir);
      const { stdout } = await runGit(
        ['commit', '-m', message],
        cwd,
      );
      return {
        status: 'success' as const,
        workdir: cwd,
        output: stdout,
      };
    },
  });

  const push = createGuardedTool({
    contract: {
      version: '1.0',
      riskClass: 'T3',
      sideEffect: 'irreversible',
      idempotency: 'required',
      timeoutMs,
      ...options.push?.contract,
      name: pushName,
    },
    description:
      options.push?.description ??
      'Push the current branch to a remote (T3 — requires approve; never uses --force).',
    parameters: z.object({
      workdir: z.string().describe('Git worktree directory (must be allowed)'),
      remote: z.string().default('origin').describe('Remote name'),
      branch: z
        .string()
        .optional()
        .describe('Branch to push (current branch if omitted)'),
      setUpstream: z
        .boolean()
        .optional()
        .describe('Pass -u when pushing a new branch'),
    }),
    approve: options.push?.approve
      ? (args) => options.push!.approve!(args)
      : undefined,
    execute: async ({ workdir, remote, branch, setUpstream }) => {
      const cwd = options.resolveWorkdir(workdir);
      const args = ['push'];
      if (setUpstream) args.push('-u');
      args.push(remote);
      if (branch) args.push(branch);
      const { stdout, stderr } = await runGit(args, cwd);
      return {
        status: 'success' as const,
        workdir: cwd,
        remote,
        branch: branch ?? '(current)',
        output: stdout.trim() || stderr.trim(),
      };
    },
  });

  return { status, diff, add, commit, push };
}
