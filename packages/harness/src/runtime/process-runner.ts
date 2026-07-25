import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';

export interface ProcessRunRequest {
  bin: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  stdin?: string;
  /**
   * Run through the platform shell. Only for fixed, non-model-controlled
   * argv (e.g. the `npm.cmd` shim on Windows).
   */
  shell?: boolean;
}

export interface ProcessRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export type ProcessRunner = (
  request: ProcessRunRequest,
) => Promise<ProcessRunResult>;

/** Cap UTF-8 text by byte length (not code units). */
export function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: text.length > 0 };
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  return {
    text: buf.subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  };
}

/**
 * Resolve `path` and ensure it stays inside `root` (after realpath-style resolve).
 */
export function assertInsideRoot(path: string, root: string): string {
  const absRoot = resolve(root);
  const abs = resolve(absRoot, path);
  if (abs === absRoot || abs.startsWith(absRoot + sep)) return abs;
  throw new Error(`Path "${path}" escapes workRoot "${absRoot}"`);
}

/**
 * Minimal child env — does not inherit secrets from process.env.
 * Callers may merge extra keys (still no automatic dotenv).
 */
export function minimalChildEnv(
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...extra };
  for (const key of [
    'PATH',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
  ] as const) {
    const value = process.env[key];
    if (value != null && env[key] == null) env[key] = value;
  }
  return env;
}

function appendCapped(
  current: string,
  chunk: Buffer,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const next = current + chunk.toString('utf8');
  return truncateUtf8(next, maxBytes);
}

/** Default spawn-based runner with wall-clock timeout and output caps. */
export function createDefaultProcessRunner(): ProcessRunner {
  return (request) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn(request.bin, request.args, {
        cwd: request.cwd,
        env: request.env,
        shell: request.shell ?? false,
        stdio: [request.stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // Force-kill if still alive shortly after.
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, 2_000).unref?.();
      }, request.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        const out = appendCapped(stdout, chunk, request.maxOutputBytes);
        stdout = out.text;
        if (out.truncated) truncated = true;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const out = appendCapped(stderr, chunk, request.maxOutputBytes);
        stderr = out.text;
        if (out.truncated) truncated = true;
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({
          exitCode: code,
          stdout,
          stderr,
          timedOut,
          truncated,
        });
      });

      if (request.stdin != null && child.stdin) {
        child.stdin.end(request.stdin);
      }
    });
}

export interface TsInvokeOptions {
  /** Node binary. Default: `process.execPath`. */
  bin?: string;
  /**
   * Args before the entry file.
   * Default: `['--experimental-strip-types']` (Node ≥22 type stripping).
   */
  prefixArgs?: string[];
}

export function resolveTsInvoke(
  options: TsInvokeOptions = {},
): { bin: string; prefixArgs: string[] } {
  return {
    bin: options.bin ?? process.execPath,
    prefixArgs: options.prefixArgs ?? ['--experimental-strip-types'],
  };
}
