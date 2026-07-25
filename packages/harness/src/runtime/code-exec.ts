import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FunctionTool } from '@google/adk';
import type { ToolContract, ToolContractInput } from '@agent-env/shared';
import { z } from 'zod';
import { createGuardedTool } from './tool-gateway.js';
import {
  assertInsideRoot,
  createDefaultProcessRunner,
  minimalChildEnv,
  resolveTsInvoke,
  type ProcessRunner,
  type ProcessRunResult,
  type TsInvokeOptions,
} from './process-runner.js';

export interface CodeExecResult {
  status: 'ok' | 'failed' | 'timeout';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** Absolute entry that was executed (temp file path). */
  entry: string;
}

function toCodeExecResult(
  entry: string,
  run: ProcessRunResult,
): CodeExecResult {
  const status = run.timedOut
    ? 'timeout'
    : run.exitCode === 0
      ? 'ok'
      : 'failed';
  return {
    status,
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    timedOut: run.timedOut,
    truncated: run.truncated,
    entry,
  };
}

export interface CreateTsCodeRunnerToolOptions {
  /**
   * Jail + module root. Generated code is materialised under this tree so
   * `node_modules` here (agent `exec/` env) is visible to imports.
   * Pair with `prepare: createExecEnvGuard({ moduleRoot })` to install deps.
   */
  workRoot: string;
  /** Tool name. Default: `run_ts_code`. */
  name?: string;
  description?: string;
  contract?: Partial<ToolContractInput>;
  /** Default T2 (fail-closed without approve). */
  riskClass?: 'T2' | 'T3';
  approve?: (args: {
    contract: ToolContract;
    input: { code: string; args?: string[] };
  }) => Promise<boolean> | boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runner?: ProcessRunner;
  invoke?: TsInvokeOptions;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Max UTF-8 bytes of generated source. Default 32_000. */
  maxCodeBytes?: number;
  /** Keep temp .ts files after run. Default false. */
  keepTempFiles?: boolean;
  /** Subdir under workRoot. Default `.code-exec`. */
  tempDirName?: string;
  /**
   * Awaited before every spawn — typically `createExecEnvGuard()` so the
   * agent-local `exec/package.json` dependencies are installed first.
   */
  prepare?: () => Promise<unknown> | unknown;
}

/**
 * Execute AI-generated TypeScript by writing a temp file under workRoot.
 * process-backend only — not a container/microVM sandbox.
 *
 * Pre-declared agent logic should be normal FunctionTools in agent.ts;
 * this factory is for model-authored programs that need an isolated npm env.
 */
export async function runGeneratedTsCode(options: {
  workRoot: string;
  code: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runner?: ProcessRunner;
  invoke?: TsInvokeOptions;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxCodeBytes?: number;
  keepTempFiles?: boolean;
  tempDirName?: string;
}): Promise<CodeExecResult> {
  const workRoot = resolve(options.workRoot);
  const maxCodeBytes = options.maxCodeBytes ?? 32_000;
  const codeBuf = Buffer.from(options.code, 'utf8');
  if (codeBuf.byteLength === 0) {
    throw new Error('TypeScript source is empty');
  }
  if (codeBuf.byteLength > maxCodeBytes) {
    throw new Error(
      `TypeScript source exceeds maxCodeBytes (${codeBuf.byteLength} > ${maxCodeBytes})`,
    );
  }

  const tempDirName = options.tempDirName ?? '.code-exec';
  const tempDir = assertInsideRoot(tempDirName, workRoot);
  mkdirSync(tempDir, { recursive: true });
  const entry = join(tempDir, `${randomUUID()}.ts`);
  assertInsideRoot(entry, workRoot);
  writeFileSync(entry, options.code, 'utf8');

  const cwd = assertInsideRoot(options.cwd ?? workRoot, workRoot);
  const maxOutputBytes = options.maxOutputBytes ?? 64_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const runner = options.runner ?? createDefaultProcessRunner();
  const { bin, prefixArgs } = resolveTsInvoke(options.invoke);
  const extra = options.args ?? [];
  for (const arg of extra) {
    if (arg.length > 200) {
      throw new Error('Code-exec arg exceeds 200 characters');
    }
  }

  try {
    const run = await runner({
      bin,
      args: [...prefixArgs, entry, ...extra],
      cwd,
      env: options.env ?? minimalChildEnv(),
      timeoutMs,
      maxOutputBytes,
    });
    return toCodeExecResult(entry, run);
  } finally {
    if (!options.keepTempFiles) {
      try {
        rmSync(entry, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * Guarded tool: run model-authored TypeScript (T2 by default, fail-closed).
 * Isolation is process-level only (timeout + path jail + output cap + scrubbed env).
 * Use `prepare: createExecEnvGuard({ moduleRoot: workRoot })` so deps declared in
 * the agent-local `exec/package.json` are installed before the first run.
 *
 * @example
 * createTsCodeRunnerTool({
 *   workRoot: resolve(agentDir, 'exec'),
 *   prepare: createExecEnvGuard({ moduleRoot: execRoot }),
 *   approve: () => allowGeneratedCode,
 * })
 */
export function createTsCodeRunnerTool(
  options: CreateTsCodeRunnerToolOptions,
): FunctionTool {
  const workRoot = resolve(options.workRoot);
  const name = options.name ?? 'run_ts_code';
  const riskClass = options.riskClass ?? 'T2';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64_000;
  const maxCodeBytes = options.maxCodeBytes ?? 32_000;

  const parameters = z.object({
    code: z
      .string()
      .min(1)
      .describe(
        'Complete TypeScript program to execute (top-level statements OK). Prefer console.log for results. Imports must resolve from the agent exec env package.json.',
      ),
    args: z
      .array(z.string().max(200))
      .max(20)
      .optional()
      .describe('Optional argv passed to the generated program'),
  });

  return createGuardedTool({
    contract: {
      version: '1.0',
      riskClass,
      sideEffect: 'irreversible',
      idempotency: 'none',
      timeoutMs,
      maxOutputBytes,
      requiredCapabilities: ['code.exec.generated'],
      ...options.contract,
      name,
    },
    description:
      options.description ??
      'Execute AI-generated TypeScript in the agent-local exec npm env (process jail, not a full container sandbox). Requires approval when risk is T2/T3.',
    parameters,
    approve: options.approve,
    execute: async ({ code, args }) => {
      await options.prepare?.();
      return runGeneratedTsCode({
        workRoot,
        code,
        args,
        cwd: options.cwd,
        env: options.env,
        runner: options.runner,
        invoke: options.invoke,
        timeoutMs,
        maxOutputBytes,
        maxCodeBytes,
        keepTempFiles: options.keepTempFiles,
        tempDirName: options.tempDirName,
      });
    },
  });
}
