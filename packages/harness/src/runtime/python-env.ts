import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createDefaultProcessRunner,
  minimalChildEnv,
  type ProcessRunner,
} from './process-runner.js';

const DEFAULT_STAMP_FILE = join('.venv', '.agent-env-python.json');

export type PythonEnvStatus =
  | 'up-to-date'
  | 'installed'
  | 'stale'
  | 'missing-manifest'
  | 'install-failed'
  | 'venv-failed'
  | 'uv-missing';

export interface PythonEnvResult {
  pythonRoot: string;
  status: PythonEnvStatus;
  manifestHash: string;
  pythonBin?: string;
  venvDir?: string;
  uvBin?: string;
  stdout?: string;
  stderr?: string;
  message?: string;
}

export interface EnsurePythonEnvOptions {
  /**
   * Directory owning `requirements.txt` / scripts and (after ensure) `.venv`
   * managed by **uv** (`uv venv` + `uv pip install`).
   * Caller supplies the path (agent-local under `agents/<id>/python/`).
   */
  pythonRoot: string;
  /** Manifest file name. Default `requirements.txt`. */
  requirementsFile?: string;
  /**
   * `auto` (default): uv venv + uv pip install when stamp missing/stale.
   * `never`: report status only.
   */
  install?: 'auto' | 'never';
  /** uv binary. Default: `uv` (or `uv.exe` resolution via PATH). */
  uvBin?: string;
  /**
   * Optional Python version pin for `uv venv --python <ver>`
   * (e.g. `"3.12"`). When omitted, uv picks its default.
   */
  pythonVersion?: string;
  runner?: ProcessRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  stampFile?: string;
}

function platformVenvPython(venvDir: string): string {
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
}

/** Resolve `uv` on PATH (prefer explicit option). */
export function resolveUvBin(preferred?: string): string | undefined {
  if (preferred?.trim()) return preferred.trim();
  // Existence is checked by actually spawning; return the conventional name.
  return process.platform === 'win32' ? 'uv' : 'uv';
}

/**
 * Resolve the agent-local venv interpreter created by uv.
 */
export function resolvePythonBin(
  pythonRoot: string,
): string | undefined {
  const root = resolve(pythonRoot);
  const venvPy = platformVenvPython(join(root, '.venv'));
  if (existsSync(venvPy)) return venvPy;
  return undefined;
}

/**
 * @deprecated Prefer resolveUvBin — Python envs are created with uv, not host python -m venv.
 * Kept as a no-op list for older call sites / probes.
 */
export function bootstrapPythonCandidates(preferred?: string): string[] {
  const out: string[] = [];
  if (preferred?.trim()) out.push(preferred.trim());
  out.push(resolveUvBin() ?? 'uv');
  return [...new Set(out)];
}

/**
 * Identity hash of a Python env: requirements file contents (if present).
 */
export function pythonEnvManifestHash(
  pythonRoot: string,
  requirementsFile = 'requirements.txt',
): string {
  const root = resolve(pythonRoot);
  const hash = createHash('sha256');
  hash.update('uv\n');
  const reqPath = join(root, requirementsFile);
  if (existsSync(reqPath)) {
    hash.update(requirementsFile);
    hash.update(readFileSync(reqPath));
  } else {
    hash.update('missing-requirements');
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

async function tryRun(
  runner: ProcessRunner,
  bin: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
  },
) {
  return runner({
    bin,
    args,
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: opts.maxOutputBytes,
  });
}

/**
 * Ensure an agent-local Python env via **uv**:
 *   `uv venv .venv` then `uv pip install -r requirements.txt --python .venv`
 *
 * Does not read process.env for secrets; PATH is passed via minimalChildEnv.
 *
 * @example
 * await ensurePythonEnv({ pythonRoot: resolve(agentDir, 'python') });
 */
export async function ensurePythonEnv(
  options: EnsurePythonEnvOptions,
): Promise<PythonEnvResult> {
  const pythonRoot = resolve(options.pythonRoot);
  const requirementsFile = options.requirementsFile ?? 'requirements.txt';
  const install = options.install ?? 'auto';
  const stampRel = options.stampFile ?? DEFAULT_STAMP_FILE;
  const stampPath = join(pythonRoot, stampRel);
  const manifestHash = pythonEnvManifestHash(pythonRoot, requirementsFile);
  const venvDir = join(pythonRoot, '.venv');
  const runner = options.runner ?? createDefaultProcessRunner();
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxOutputBytes = options.maxOutputBytes ?? 2_000_000;
  const env = minimalChildEnv(options.env ?? {});
  const uvBin = resolveUvBin(options.uvBin);

  mkdirSync(pythonRoot, { recursive: true });

  const reqPath = join(pythonRoot, requirementsFile);
  if (!existsSync(reqPath)) {
    return {
      pythonRoot,
      status: 'missing-manifest',
      manifestHash,
      uvBin,
      message: `Missing ${requirementsFile} under ${pythonRoot}`,
    };
  }

  const existingBin = resolvePythonBin(pythonRoot);
  const stamp = readStamp(stampPath);
  if (existingBin && existsSync(venvDir) && stamp.hash === manifestHash) {
    return {
      pythonRoot,
      status: 'up-to-date',
      manifestHash,
      pythonBin: existingBin,
      venvDir,
      uvBin,
    };
  }

  if (install === 'never') {
    return {
      pythonRoot,
      status: existingBin ? 'stale' : 'missing-manifest',
      manifestHash,
      pythonBin: existingBin,
      venvDir: existsSync(venvDir) ? venvDir : undefined,
      uvBin,
      message: existingBin
        ? 'Python env stamp stale or missing (install=never)'
        : 'No uv venv and install=never',
    };
  }

  // Probe uv availability.
  const uvProbe = await tryRun(runner, uvBin!, ['--version'], {
    cwd: pythonRoot,
    env,
    timeoutMs: Math.min(timeoutMs, 30_000),
    maxOutputBytes: 8_000,
  });
  if (uvProbe.exitCode !== 0) {
    return {
      pythonRoot,
      status: 'uv-missing',
      manifestHash,
      uvBin,
      stdout: uvProbe.stdout,
      stderr: uvProbe.stderr,
      message:
        'uv is required for agent Python envs (install: https://docs.astral.sh/uv/)',
    };
  }

  // Create venv with uv if needed.
  let venvPython = existsSync(platformVenvPython(venvDir))
    ? platformVenvPython(venvDir)
    : undefined;

  if (!venvPython) {
    const venvArgs = ['venv', venvDir];
    if (options.pythonVersion?.trim()) {
      venvArgs.push('--python', options.pythonVersion.trim());
    }
    const created = await tryRun(runner, uvBin!, venvArgs, {
      cwd: pythonRoot,
      env,
      timeoutMs,
      maxOutputBytes,
    });
    if (
      created.exitCode !== 0 ||
      !existsSync(platformVenvPython(venvDir))
    ) {
      return {
        pythonRoot,
        status: 'venv-failed',
        manifestHash,
        uvBin,
        stdout: created.stdout,
        stderr: created.stderr,
        message: `uv venv failed: ${created.stderr || created.stdout || `exit ${created.exitCode}`}`,
      };
    }
    venvPython = platformVenvPython(venvDir);
  }

  // Install deps with uv pip into the venv (empty requirements is fine).
  const pip = await tryRun(
    runner,
    uvBin!,
    [
      'pip',
      'install',
      '-r',
      requirementsFile,
      '--python',
      venvDir,
    ],
    { cwd: pythonRoot, env, timeoutMs, maxOutputBytes },
  );
  if (pip.exitCode !== 0) {
    return {
      pythonRoot,
      status: 'install-failed',
      manifestHash,
      pythonBin: venvPython,
      venvDir,
      uvBin,
      stdout: pip.stdout,
      stderr: pip.stderr,
      message: 'uv pip install failed',
    };
  }

  mkdirSync(join(pythonRoot, '.venv'), { recursive: true });
  writeFileSync(
    stampPath,
    JSON.stringify(
      {
        hash: manifestHash,
        requirementsFile,
        manager: 'uv',
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  return {
    pythonRoot,
    status: 'installed',
    manifestHash,
    pythonBin: venvPython,
    venvDir,
    uvBin,
    stdout: pip.stdout,
    stderr: pip.stderr,
  };
}

/**
 * Lazy guard: call before each Python spawn so deps stay installed via uv.
 */
export function createPythonEnvGuard(
  options: EnsurePythonEnvOptions,
): () => Promise<PythonEnvResult> {
  return async () => {
    const last = await ensurePythonEnv(options);
    if (
      last.status === 'install-failed' ||
      last.status === 'venv-failed' ||
      last.status === 'missing-manifest' ||
      last.status === 'uv-missing'
    ) {
      throw new Error(
        last.message ?? `ensurePythonEnv failed: ${last.status}`,
      );
    }
    return last;
  };
}
