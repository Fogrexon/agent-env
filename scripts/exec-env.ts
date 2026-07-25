/**
 * Ensure an agent-local code-exec npm environment (path argv — no hardcoded ids).
 *
 * Usage:
 *   npm run exec:env -- agents/code-exec/exec
 *   npm run exec:env -- agents/code-exec/exec --check
 */
import { resolve } from 'node:path';
import { ensureExecEnv } from '@agent-env/harness';

function printUsage(): never {
  console.log(`Usage: npm run exec:env -- <moduleRoot> [--check]

  moduleRoot  Directory with package.json for the AI-generated-TS exec env
              (typically agents/<id>/exec — not a workspace member)
  --check     Report status only; do not run npm install
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const checkOnly = args.includes('--check');
  const pathArg = args.find((a) => !a.startsWith('-'));
  if (!pathArg) printUsage();

  const moduleRoot = resolve(process.cwd(), pathArg);
  const result = await ensureExecEnv({
    moduleRoot,
    install: checkOnly ? 'never' : 'auto',
  });

  console.log(`moduleRoot: ${result.moduleRoot}`);
  console.log(`status:     ${result.status}`);
  if (result.lockfile) console.log(`lockfile:   ${result.lockfile}`);
  if (result.manifestHash) {
    console.log(`hash:       ${result.manifestHash.slice(0, 12)}…`);
  }
  if (result.installCommand) console.log(`command:    ${result.installCommand}`);
  if (result.message) console.log(`message:    ${result.message}`);
  if (
    result.status === 'install-failed' ||
    result.status === 'missing-manifest'
  ) {
    if (result.stderr) console.error(result.stderr.slice(0, 2000));
    process.exit(2);
  }
  if (checkOnly && result.status === 'stale') {
    process.exit(3);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
