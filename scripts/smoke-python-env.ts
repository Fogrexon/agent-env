/**
 * Smoke: agent-local Python env via **uv** + predeclared script runner.
 * Mock runner covers uv venv / uv pip when needed; live path uses real `uv`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseTool } from '@google/adk';
import {
  assertInsideRoot,
  createDefaultProcessRunner,
  createPythonScriptTool,
  ensurePythonEnv,
  resolveUvBin,
  runGeneratedPythonCode,
  runPythonScript,
  type ProcessRunner,
} from '@agent-env/harness';
import { z } from 'zod';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function callTool(
  tool: BaseTool,
  args: Record<string, unknown>,
): Promise<unknown> {
  const stubToolContext = {} as Parameters<
    BaseTool['runAsync']
  >[0]['toolContext'];
  return tool.runAsync({ args, toolContext: stubToolContext });
}

async function probeUv(): Promise<boolean> {
  const runner = createDefaultProcessRunner();
  const bin = resolveUvBin();
  try {
    const r = await runner({
      bin: bin!,
      args: ['--version'],
      timeoutMs: 15_000,
      maxOutputBytes: 4_000,
    });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

// Path jail always works without uv/Python.
const jailRoot = mkdtempSync(join(tmpdir(), 'agent-env-py-jail-'));
assert(assertInsideRoot('scripts/a.py', jailRoot).endsWith('a.py'), 'jail ok');
let escaped = false;
try {
  assertInsideRoot('../outside.py', jailRoot);
} catch {
  escaped = true;
}
assert(escaped, 'jail blocks escape');

const mockRunner: ProcessRunner = async (req) => {
  const cwd = req.cwd ?? '.';
  // uv --version
  if (req.args[0] === '--version') {
    return {
      exitCode: 0,
      stdout: 'uv 0.0.0-mock\n',
      stderr: '',
      timedOut: false,
      truncated: false,
    };
  }
  // uv venv <dir>
  if (req.args[0] === 'venv') {
    const venvDir = req.args[1] ?? join(cwd, '.venv');
    if (process.platform === 'win32') {
      mkdirSync(join(venvDir, 'Scripts'), { recursive: true });
      writeFileSync(join(venvDir, 'Scripts', 'python.exe'), '');
    } else {
      mkdirSync(join(venvDir, 'bin'), { recursive: true });
      writeFileSync(join(venvDir, 'bin', 'python'), '');
    }
    return {
      exitCode: 0,
      stdout: 'venv-ok',
      stderr: '',
      timedOut: false,
      truncated: false,
    };
  }
  // uv pip install ...
  if (req.args[0] === 'pip') {
    return {
      exitCode: 0,
      stdout: 'pip-ok',
      stderr: '',
      timedOut: false,
      truncated: false,
    };
  }
  return {
    exitCode: 0,
    stdout: JSON.stringify({ ok: true, echo: { hello: 'mock' } }) + '\n',
    stderr: '',
    timedOut: false,
    truncated: false,
  };
};

const mockRoot = mkdtempSync(join(tmpdir(), 'agent-env-py-mock-'));
writeFileSync(join(mockRoot, 'requirements.txt'), '# mock\n');
mkdirSync(join(mockRoot, 'scripts'), { recursive: true });
writeFileSync(join(mockRoot, 'scripts', 'echo_json.py'), 'print(1)\n');

const ensuredMock = await ensurePythonEnv({
  pythonRoot: mockRoot,
  runner: mockRunner,
  uvBin: 'uv',
});
assert(
  ensuredMock.status === 'installed' || ensuredMock.status === 'up-to-date',
  `mock ensure status=${ensuredMock.status} ${ensuredMock.message ?? ''}`,
);

const tool = createPythonScriptTool({
  pythonRoot: mockRoot,
  script: 'scripts/echo_json.py',
  name: 'run_echo',
  parameters: z.object({ hello: z.string() }),
  ensureEnv: false,
  runner: mockRunner,
});
const scriptMock = await runPythonScript({
  pythonRoot: mockRoot,
  script: 'scripts/echo_json.py',
  args: ['--json-stdin'],
  stdin: JSON.stringify({ hello: 'world' }),
  runner: mockRunner,
});
assert(scriptMock.status === 'ok', 'mock script ok');

const toolOut = await callTool(tool, { hello: 'tool' });
assert(
  toolOut &&
    typeof toolOut === 'object' &&
    (toolOut as { status?: string }).status === 'ok',
  'mock tool ok',
);

const hasUv = await probeUv();
if (!hasUv) {
  console.log(
    'smoke-python-env: ok (jail + mock uv; SKIP live — install uv: https://docs.astral.sh/uv/)',
  );
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'agent-env-python-'));
writeFileSync(join(root, 'requirements.txt'), '# smoke\n');
mkdirSync(join(root, 'scripts'), { recursive: true });
writeFileSync(
  join(root, 'scripts', 'echo_json.py'),
  [
    'import json,sys',
    'data=json.load(sys.stdin)',
    'print(json.dumps({"ok": True, "echo": data}))',
  ].join('\n'),
  'utf8',
);

const ensured = await ensurePythonEnv({ pythonRoot: root });
assert(
  ensured.status === 'installed' || ensured.status === 'up-to-date',
  `ensurePythonEnv status=${ensured.status} ${ensured.message ?? ''}`,
);
assert(ensured.pythonBin, 'pythonBin set');

const scriptOut = await runPythonScript({
  pythonRoot: root,
  script: 'scripts/echo_json.py',
  args: ['--json-stdin'],
  stdin: JSON.stringify({ hello: 'world' }),
});
assert(scriptOut.status === 'ok', `script status=${scriptOut.status}`);
assert(
  scriptOut.stdout.includes('"ok": true') ||
    scriptOut.stdout.includes('"ok":true'),
  'stdout json',
);

const liveTool = createPythonScriptTool({
  pythonRoot: root,
  script: 'scripts/echo_json.py',
  name: 'run_echo_live',
  parameters: z.object({ hello: z.string() }),
});
const liveOut = await callTool(liveTool, { hello: 'tool' });
assert(
  liveOut &&
    typeof liveOut === 'object' &&
    (liveOut as { status?: string }).status === 'ok',
  'live script tool ok',
);

const gen = await runGeneratedPythonCode({
  pythonRoot: root,
  code: 'print("generated-ok")\n',
});
assert(gen.status === 'ok', 'generated ok');
assert(gen.stdout.includes('generated-ok'), 'generated stdout');

console.log('smoke-python-env: ok (live uv)');
