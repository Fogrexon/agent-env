import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FunctionTool } from '@google/adk';
import type { ToolContractInput } from '@agent-env/shared';
import { z } from 'zod';
import { createGuardedTool } from './tool-gateway.js';
import {
  assertInsideRoot,
  createDefaultProcessRunner,
  minimalChildEnv,
  type ProcessRunner,
  type ProcessRunResult,
} from './process-runner.js';
import {
  ensurePythonEnv,
  resolvePythonBin,
  type EnsurePythonEnvOptions,
} from './python-env.js';
import type { CodeExecResult } from './code-exec.js';

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

export interface RunPythonScriptOptions {
  pythonRoot: string;
  /** Script path relative to pythonRoot (must stay inside the jail). */
  script: string;
  args?: string[];
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runner?: ProcessRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Optional prepare hook (typically createPythonEnvGuard). */
  prepare?: () => Promise<unknown> | unknown;
  /** Override interpreter; default resolvePythonBin(pythonRoot). */
  pythonBin?: string;
}

/**
 * Run a predeclared Python script under an agent-local pythonRoot jail.
 */
export async function runPythonScript(
  options: RunPythonScriptOptions,
): Promise<CodeExecResult> {
  const pythonRoot = resolve(options.pythonRoot);
  if (options.prepare) await options.prepare();

  const pythonBin =
    options.pythonBin ?? resolvePythonBin(pythonRoot);
  if (!pythonBin) {
    throw new Error(
      `No Python interpreter for ${pythonRoot} — call ensurePythonEnv first`,
    );
  }

  const scriptAbs = assertInsideRoot(options.script, pythonRoot);
  const runner = options.runner ?? createDefaultProcessRunner();
  const run = await runner({
    bin: pythonBin,
    args: [scriptAbs, ...(options.args ?? [])],
    cwd: options.cwd ?? pythonRoot,
    env: minimalChildEnv({
      ...(options.env ?? {}),
      PYTHONUNBUFFERED: '1',
    }),
    timeoutMs: options.timeoutMs ?? 120_000,
    maxOutputBytes: options.maxOutputBytes ?? 1_000_000,
    stdin: options.stdin,
  });
  return toCodeExecResult(scriptAbs, run);
}

export interface CreatePythonScriptToolOptions<TSchema extends z.ZodObject<z.ZodRawShape>> {
  pythonRoot: string | (() => string);
  /**
   * Script path relative to pythonRoot. Prefer `scripts/<name>.py`.
   */
  script: string;
  name?: string;
  description?: string;
  contract?: Partial<ToolContractInput>;
  /** Default T1 for predeclared scripts (side-effect free analysis). */
  riskClass?: 'T0' | 'T1' | 'T2' | 'T3';
  parameters: TSchema;
  /** Map tool args → CLI argv (default: JSON on stdin via `--json-stdin`). */
  toArgs?: (input: z.infer<TSchema>) => string[];
  /** When true (default), pass stringified input as stdin. */
  jsonStdin?: boolean;
  prepare?: () => Promise<unknown> | unknown;
  /** When not `false`, call ensurePythonEnv (uv venv + uv pip) before run. */
  ensureEnv?: EnsurePythonEnvOptions | false;
  timeoutMs?: number;
  maxOutputBytes?: number;
  runner?: ProcessRunner;
  /** Parse stdout (default: try JSON, else raw text). */
  parseStdout?: (stdout: string) => unknown;
}

function defaultParseStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return { raw: '' };
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1].trim()) as unknown;
      } catch {
        /* fall through */
      }
    }
    return { raw: trimmed };
  }
}

/**
 * Guarded tool that runs a **predeclared** script under `agents/<id>/python/`.
 * Prefer this for YOLO / OpenCV / batch jobs — put the code in `scripts/`,
 * declare deps in `requirements.txt`, and expose a typed tool.
 */
export function createPythonScriptTool<
  TSchema extends z.ZodObject<z.ZodRawShape>,
>(options: CreatePythonScriptToolOptions<TSchema>): FunctionTool {
  const name = options.name ?? `run_${basename(options.script, '.py')}`;
  const riskClass = options.riskClass ?? 'T1';
  const jsonStdin = options.jsonStdin ?? true;

  return createGuardedTool({
    contract: {
      version: '1.0',
      riskClass,
      sideEffect: riskClass === 'T0' || riskClass === 'T1' ? 'none' : 'reversible',
      idempotency: 'supported',
      ...options.contract,
      name,
    },
    description:
      options.description ??
      `Run predeclared Python script ${options.script} in the agent python env.`,
    parameters: options.parameters,
    execute: async (input) => {
      const pythonRoot =
        typeof options.pythonRoot === 'function'
          ? options.pythonRoot()
          : resolve(options.pythonRoot);

      if (options.ensureEnv !== false) {
        const ensured = await ensurePythonEnv({
          pythonRoot,
          ...(options.ensureEnv ?? {}),
        });
        if (
          ensured.status === 'install-failed' ||
          ensured.status === 'venv-failed' ||
          ensured.status === 'uv-missing' ||
          ensured.status === 'missing-manifest'
        ) {
          return {
            status: 'failed' as const,
            message: ensured.message ?? ensured.status,
            stderr: ensured.stderr,
          };
        }
      }
      if (options.prepare) await options.prepare();

      const args = options.toArgs
        ? options.toArgs(input)
        : jsonStdin
          ? ['--json-stdin']
          : [];
      const stdin = jsonStdin ? JSON.stringify(input) : undefined;

      try {
        const result = await runPythonScript({
          pythonRoot,
          script: options.script,
          args,
          stdin,
          runner: options.runner,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
        });
        const parse = options.parseStdout ?? defaultParseStdout;
        return {
          status: result.status,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
          script: options.script,
          result: result.status === 'ok' ? parse(result.stdout) : undefined,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      } catch (err) {
        return {
          status: 'failed' as const,
          message: (err as Error).message,
        };
      }
    },
  });
}

export interface CreatePythonCodeRunnerToolOptions {
  pythonRoot: string;
  name?: string;
  description?: string;
  contract?: Partial<ToolContractInput>;
  riskClass?: 'T2' | 'T3';
  prepare?: () => Promise<unknown> | unknown;
  /** When not `false`, call ensurePythonEnv (uv venv + uv pip) before run. */
  ensureEnv?: EnsurePythonEnvOptions | false;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxCodeBytes?: number;
  keepTempFiles?: boolean;
  tempDirName?: string;
  runner?: ProcessRunner;
}

/**
 * Execute **model-authored** Python under pythonRoot (process jail + uv venv).
 * Prefer `createPythonScriptTool` for fixed pipelines (YOLO etc.).
 */
export function createPythonCodeRunnerTool(
  options: CreatePythonCodeRunnerToolOptions,
): FunctionTool {
  const name = options.name ?? 'run_python_code';
  const riskClass = options.riskClass ?? 'T2';
  const maxCodeBytes = options.maxCodeBytes ?? 32_000;
  const tempDirName = options.tempDirName ?? '.code-exec';

  return createGuardedTool({
    contract: {
      version: '1.0',
      riskClass,
      sideEffect: 'reversible',
      idempotency: 'none',
      ...options.contract,
      name,
    },
    description:
      options.description ??
      'Run AI-generated Python in the agent-local python/ uv venv (T2). Prefer predeclared scripts for production pipelines.',
    parameters: z.object({
      code: z.string().min(1).describe('Python source to execute'),
      args: z.array(z.string()).optional().describe('sys.argv[1:]'),
    }),
    execute: async ({ code, args }) => {
      const pythonRoot = resolve(options.pythonRoot);
      if (options.ensureEnv !== false) {
        const ensured = await ensurePythonEnv({
          pythonRoot,
          ...(options.ensureEnv ?? {}),
        });
        if (
          ensured.status === 'install-failed' ||
          ensured.status === 'venv-failed' ||
          ensured.status === 'uv-missing' ||
          ensured.status === 'missing-manifest'
        ) {
          return {
            status: 'failed' as const,
            message: ensured.message ?? ensured.status,
          };
        }
      }
      if (options.prepare) await options.prepare();

      const codeBuf = Buffer.from(code, 'utf8');
      if (codeBuf.byteLength > maxCodeBytes) {
        return {
          status: 'failed' as const,
          message: `Python source exceeds maxCodeBytes (${codeBuf.byteLength} > ${maxCodeBytes})`,
        };
      }

      const tempDir = assertInsideRoot(tempDirName, pythonRoot);
      mkdirSync(tempDir, { recursive: true });
      const rel = join(tempDirName, `${randomUUID()}.py`).replace(/\\/g, '/');
      const entry = assertInsideRoot(rel, pythonRoot);
      writeFileSync(entry, code, 'utf8');

      try {
        const result = await runPythonScript({
          pythonRoot,
          script: rel,
          args: args ?? [],
          runner: options.runner,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
        });
        return {
          status: result.status,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          truncated: result.truncated,
          entry: result.entry,
        };
      } finally {
        if (!options.keepTempFiles) {
          try {
            rmSync(entry, { force: true });
          } catch {
            /* ignore */
          }
        }
      }
    },
  });
}

/**
 * Run generated Python from an absolute-friendly path helper used by tests.
 */
export async function runGeneratedPythonCode(options: {
  pythonRoot: string;
  code: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxCodeBytes?: number;
  keepTempFiles?: boolean;
  prepare?: () => Promise<unknown> | unknown;
  runner?: ProcessRunner;
}): Promise<CodeExecResult> {
  const pythonRoot = resolve(options.pythonRoot);
  if (options.prepare) await options.prepare();
  await ensurePythonEnv({ pythonRoot });

  const maxCodeBytes = options.maxCodeBytes ?? 32_000;
  const codeBuf = Buffer.from(options.code, 'utf8');
  if (codeBuf.byteLength === 0) throw new Error('Python source is empty');
  if (codeBuf.byteLength > maxCodeBytes) {
    throw new Error(
      `Python source exceeds maxCodeBytes (${codeBuf.byteLength} > ${maxCodeBytes})`,
    );
  }

  const tempDir = assertInsideRoot('.code-exec', pythonRoot);
  mkdirSync(tempDir, { recursive: true });
  const rel = join('.code-exec', `${randomUUID()}.py`);
  const abs = assertInsideRoot(rel, pythonRoot);
  writeFileSync(abs, options.code, 'utf8');
  try {
    return await runPythonScript({
      pythonRoot,
      script: rel.replace(/\\/g, '/'),
      args: options.args,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      runner: options.runner,
    });
  } finally {
    if (!options.keepTempFiles) {
      try {
        rmSync(abs, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
