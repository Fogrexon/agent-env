import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createDefaultProcessRunner,
  minimalChildEnv,
  type ProcessRunner,
} from './process-runner.js';

/** Lockfiles checked, in priority order. */
const LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json'] as const;

const DEFAULT_STAMP_FILE = join('node_modules', '.agent-env-exec.json');

export type ExecEnvStatus =
  | 'up-to-date'
  | 'installed'
  | 'stale'
  | 'missing-manifest'
  | 'install-failed';

export interface ExecEnvResult {
  moduleRoot: string;
  status: ExecEnvStatus;
  /** Hash of package.json (+ lockfile) — the identity of this environment. */
  manifestHash: string;
  lockfile?: string;
  installCommand?: string;
  stdout?: string;
  stderr?: string;
  message?: string;
}

export interface EnsureExecEnvOptions {
  /**
   * Directory owning `package.json` + `node_modules` for executed code.
   * Node resolves imports from the script's location upward, so scripts must
   * live inside this directory for its `node_modules` to apply.
   */
  moduleRoot: string;
  /**
   * `auto` (default): install when the stamp is missing or stale.
   * `never`: report status only — never spawn npm.
   */
  install?: 'auto' | 'never';
  /** Default: `npm.cmd` on win32, otherwise `npm`. */
  npmBin?: string;
  /** Extra npm args appended to `ci` / `install`. */
  installArgs?: string[];
  /** Pass `--ignore-scripts` (default true — no postinstall in exec envs). */
  ignoreScripts?: boolean;
  runner?: ProcessRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  /** Stamp path relative to moduleRoot. Default: `node_modules/.agent-env-exec.json`. */
  stampFile?: string;
}

function findLockfile(moduleRoot: string): string | undefined {
  return LOCKFILES.find((name) => existsSync(join(moduleRoot, name)));
}

/**
 * Identity hash of an exec environment: package.json plus its lockfile.
 * Used to skip redundant installs.
 */
export function execEnvManifestHash(moduleRoot: string): string {
  const root = resolve(moduleRoot);
  const hash = createHash('sha256');
  hash.update(readFileSync(join(root, 'package.json')));
  const lockfile = findLockfile(root);
  if (lockfile) {
    hash.update(lockfile);
    hash.update(readFileSync(join(root, lockfile)));
  }
  return hash.digest('hex');
}

function readStamp(stampPath: string): { hash?: string } {
  try {
    return JSON.parse(readFileSync(stampPath, 'utf8')) as { hash?: string };
  } catch {
    return {};
  }
}

/**
 * Make sure an agent-local `exec` environment has its npm dependencies
 * installed, without touching global or repo-root `node_modules`.
 *
 * Env-agnostic: the caller supplies the directory (per layer boundaries,
 * agent-specific paths belong in `agents/<id>/`).
 *
 * @example
 * await ensureExecEnv({ moduleRoot: resolve(agentDir, 'exec') });
 */
export async function ensureExecEnv(
  options: EnsureExecEnvOptions,
): Promise<ExecEnvResult> {
  const moduleRoot = resolve(options.moduleRoot);
  const manifestPath = join(moduleRoot, 'package.json');
  if (!existsSync(manifestPath)) {
    return {
      moduleRoot,
      status: 'missing-manifest',
      manifestHash: '',
      message: `No package.json in "${moduleRoot}" — create one to declare exec dependencies.`,
    };
  }

  const manifestHash = execEnvManifestHash(moduleRoot);
  const lockfile = findLockfile(moduleRoot);
  const stampPath = join(moduleRoot, options.stampFile ?? DEFAULT_STAMP_FILE);

  if (readStamp(stampPath).hash === manifestHash) {
    return { moduleRoot, status: 'up-to-date', manifestHash, lockfile };
  }

  if ((options.install ?? 'auto') === 'never') {
    return {
      moduleRoot,
      status: 'stale',
      manifestHash,
      lockfile,
      message: `Dependencies in "${moduleRoot}" are not installed for this manifest. Run: npm install --prefix ${moduleRoot}`,
    };
  }

  const npmBin =
    options.npmBin ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const args = [
    lockfile ? 'ci' : 'install',
    '--no-audit',
    '--no-fund',
    ...((options.ignoreScripts ?? true) ? ['--ignore-scripts'] : []),
    ...(options.installArgs ?? []),
  ];
  const runner = options.runner ?? createDefaultProcessRunner();
  const installCommand = `${npmBin} ${args.join(' ')}`;

  const run = await runner({
    bin: npmBin,
    args,
    cwd: moduleRoot,
    env: options.env ?? minimalChildEnv(),
    timeoutMs: options.timeoutMs ?? 300_000,
    maxOutputBytes: options.maxOutputBytes ?? 64_000,
    // npm is a .cmd shim on Windows; args here are fixed, never model input.
    shell: process.platform === 'win32',
  });

  if (run.exitCode !== 0 || run.timedOut) {
    return {
      moduleRoot,
      status: 'install-failed',
      manifestHash,
      lockfile,
      installCommand,
      stdout: run.stdout,
      stderr: run.stderr,
      message: run.timedOut
        ? `npm install timed out in "${moduleRoot}"`
        : `npm install failed in "${moduleRoot}" (exit ${run.exitCode})`,
    };
  }

  mkdirSync(join(moduleRoot, 'node_modules'), { recursive: true });
  writeFileSync(
    stampPath,
    JSON.stringify(
      {
        hash: manifestHash,
        lockfile: lockfile ?? null,
        command: installCommand,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    moduleRoot,
    status: 'installed',
    manifestHash,
    lockfile,
    installCommand,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

/**
 * Memoized `ensureExecEnv` — safe to call before every execution.
 * Reuses the first in-flight promise per guard instance.
 */
export function createExecEnvGuard(
  options: EnsureExecEnvOptions,
): () => Promise<ExecEnvResult> {
  let pending: Promise<ExecEnvResult> | undefined;
  return () => {
    pending ??= ensureExecEnv(options).then((result) => {
      if (result.status === 'install-failed') {
        // Allow a later attempt to retry a transient failure.
        pending = undefined;
        throw new Error(
          `${result.message}\n${(result.stderr || result.stdout || '').slice(0, 800)}`,
        );
      }
      return result;
    });
    return pending;
  };
}
