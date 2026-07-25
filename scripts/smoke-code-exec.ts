/**
 * Smoke for AI-generated TS runner + agent-local exec env install.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseTool } from '@google/adk';
import {
  assertInsideRoot,
  createExecEnvGuard,
  createTsCodeRunnerTool,
  ensureExecEnv,
  execEnvManifestHash,
  runGeneratedTsCode,
  truncateUtf8,
  type ProcessRunner,
} from '@agent-env/harness';

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

assert(truncateUtf8('abcdef', 3).truncated, 'truncate');

const root = mkdtempSync(join(tmpdir(), 'agent-env-code-exec-'));
assert(assertInsideRoot('x.ts', root).endsWith('x.ts'), 'jail ok');
let escaped = false;
try {
  assertInsideRoot('../outside.ts', root);
} catch {
  escaped = true;
}
assert(escaped, 'jail blocks escape');

const denied = await callTool(
  createTsCodeRunnerTool({ workRoot: root }),
  { code: 'console.log(1)' },
);
assert(
  denied &&
    typeof denied === 'object' &&
    (denied as { status?: string }).status === 'policy_denied',
  'T2 denied without approve',
);

const genFake: ProcessRunner = async () => ({
  exitCode: 0,
  stdout: 'generated-ok\n',
  stderr: '',
  timedOut: false,
  truncated: false,
});
const genOut = await callTool(
  createTsCodeRunnerTool({
    workRoot: root,
    runner: genFake,
    approve: () => true,
  }),
  { code: 'console.log("generated-ok")' },
);
assert(
  genOut &&
    typeof genOut === 'object' &&
    (genOut as { status?: string }).status === 'ok',
  'approved generated ok',
);

const live = await runGeneratedTsCode({
  workRoot: root,
  code: 'const n: number = 2 + 2;\nconsole.log(`live-${n}`);\n',
});
assert(live.status === 'ok', `live status: ${live.status} ${live.stderr}`);
assert(live.stdout.includes('live-4'), 'live stdout');

// --- exec env: stamp / install skip ---
const envRoot = mkdtempSync(join(tmpdir(), 'agent-env-exec-env-'));
writeFileSync(
  join(envRoot, 'package.json'),
  JSON.stringify({
    name: 'smoke-exec-env',
    private: true,
    type: 'module',
    dependencies: {},
  }),
  'utf8',
);
const hash = execEnvManifestHash(envRoot);
assert(hash.length === 64, 'manifest hash');

const missing = await ensureExecEnv({
  moduleRoot: join(envRoot, 'nope'),
  install: 'never',
});
assert(missing.status === 'missing-manifest', 'missing manifest');

const stale = await ensureExecEnv({ moduleRoot: envRoot, install: 'never' });
assert(stale.status === 'stale', 'stale before install');

let npmCalls = 0;
const npmFake: ProcessRunner = async (req) => {
  npmCalls += 1;
  assert(req.args[0] === 'install' || req.args[0] === 'ci', 'npm verb');
  mkdirSync(join(envRoot, 'node_modules'), { recursive: true });
  return {
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    timedOut: false,
    truncated: false,
  };
};

const installed = await ensureExecEnv({
  moduleRoot: envRoot,
  runner: npmFake,
});
assert(installed.status === 'installed', 'installed');
assert(npmCalls === 1, 'npm once');

const again = await ensureExecEnv({
  moduleRoot: envRoot,
  runner: npmFake,
});
assert(again.status === 'up-to-date', 'stamp skips reinstall');
assert(npmCalls === 1, 'npm still once');

let prepared = false;
const guard = createExecEnvGuard({
  moduleRoot: envRoot,
  runner: npmFake,
});
await guard();
prepared = true;
await guard();
assert(prepared && npmCalls === 1, 'guard memoizes');

// Live: install ms in a temp exec env and import it from generated TS.
const liveEnv = mkdtempSync(join(tmpdir(), 'agent-env-exec-ms-'));
writeFileSync(
  join(liveEnv, 'package.json'),
  JSON.stringify({
    name: 'smoke-exec-ms',
    private: true,
    type: 'module',
    dependencies: { ms: '^2.1.3' },
  }),
  'utf8',
);
const liveInstall = await ensureExecEnv({ moduleRoot: liveEnv });
assert(
  liveInstall.status === 'installed' || liveInstall.status === 'up-to-date',
  `live install: ${liveInstall.status} ${liveInstall.message ?? ''}`,
);
const withMs = await runGeneratedTsCode({
  workRoot: liveEnv,
  code: `
import ms from 'ms';
console.log(String(ms('1h')));
`.trim(),
});
assert(withMs.status === 'ok', `ms run: ${withMs.stderr}`);
assert(withMs.stdout.trim() === '3600000', 'ms result');

console.log('✓ smoke-code-exec passed');
