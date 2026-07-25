import type { FunctionTool } from '@google/adk';
import type { ToolContractInput } from '@agent-env/shared';
import { z } from 'zod';
import {
  createDefaultProcessRunner,
  type ProcessRunner,
} from '../runtime/process-runner.js';
import { createGuardedTool } from '../runtime/tool-gateway.js';

export interface CreateGithubToolsOptions {
  /**
   * Resolve and jail the workdir path before running git/gh.
   * Typically `createWorkspaceFsTools(...).resolvePath`.
   */
  resolveWorkdir: (path: string) => string;
  gitBin?: string;
  ghBin?: string;
  runner?: ProcessRunner;
  timeoutMs?: number;
  createPr?: {
    name?: string;
    description?: string;
    contract?: Partial<ToolContractInput>;
    /**
     * T3 approval. Default: deny (fail closed).
     * Return true to allow branch / commit / push / `gh pr create`.
     */
    approve?: (args: {
      contract: { name: string; riskClass: string };
      input: {
        workdir: string;
        branch: string;
        title: string;
        body: string;
      };
    }) => Promise<boolean> | boolean;
  };
}

export interface GithubTools {
  /** Branch, commit, push, and open a PR via `gh pr create`. */
  createPr: FunctionTool;
}

/**
 * GitHub write/ops tools backed by `git` + `gh` CLI.
 * Auth is whatever `gh` / remotes already have — this factory does not read
 * tokens from env. Agents inject resolveWorkdir + per-tool approve only.
 *
 * Search remains `createGithubGhConnector` (read path). This factory covers
 * mutating GitHub workflows (PR open today; extend here as needed).
 */
export function createGithubTools(
  options: CreateGithubToolsOptions,
): GithubTools {
  const gitBin = options.gitBin ?? 'git';
  const ghBin = options.ghBin ?? 'gh';
  const runner = options.runner ?? createDefaultProcessRunner();
  const timeoutMs = options.timeoutMs ?? 180_000;
  const prName = options.createPr?.name ?? 'create_pr';

  const runOk = async (
    bin: string,
    args: string[],
    cwd: string,
  ): Promise<{ stdout: string; stderr: string }> => {
    const result = await runner({
      bin,
      args,
      cwd,
      timeoutMs,
      maxOutputBytes: 256_000,
    });
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(
        `${bin} ${args.join(' ')} failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return { stdout: result.stdout, stderr: result.stderr };
  };

  const createPr = createGuardedTool({
    contract: {
      version: '1.0',
      riskClass: 'T3',
      sideEffect: 'irreversible',
      idempotency: 'required',
      timeoutMs,
      ...options.createPr?.contract,
      name: prName,
    },
    description:
      options.createPr?.description ??
      'Branch, commit, push, and open a GitHub PR via `gh pr create` (T3 — requires approve and push rights).',
    parameters: z.object({
      workdir: z.string().describe('Git worktree directory (must be allowed)'),
      branch: z
        .string()
        .regex(/^[\w./-]+$/)
        .describe('New branch name, e.g. security/fix-injection'),
      title: z.string().min(8).describe('PR title / commit message'),
      body: z.string().min(20).describe('PR body'),
    }),
    approve: options.createPr?.approve
      ? (args) => options.createPr!.approve!(args)
      : undefined,
    execute: async ({ workdir, branch, title, body }) => {
      const cwd = options.resolveWorkdir(workdir);
      await runOk(gitBin, ['checkout', '-b', branch], cwd);
      await runOk(gitBin, ['add', '-A'], cwd);
      await runOk(gitBin, ['commit', '-m', title], cwd);
      await runOk(gitBin, ['push', '-u', 'origin', branch], cwd);
      const { stdout } = await runOk(
        ghBin,
        ['pr', 'create', '--title', title, '--body', body],
        cwd,
      );
      return {
        status: 'success' as const,
        branch,
        prUrl: stdout.trim(),
      };
    },
  });

  return { createPr };
}
