/**
 * Programmatic agent runner via @agent-env/repo-env discovery.
 *
 * Usage:
 *   npm run run -- <agent-id> [message...]
 *   npm run run -- <agent-id> --params ./values.json
 *   npm run run -- <agent-id> --input key=value --input key2=value2
 *   npm run run -- <agent-id> --auto-approve "..."
 *
 * Merge order (later wins): params defaults → --params file → --input → positional message.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  defaultValuesFromParams,
  getResolvedAgentPackage,
  runDiscoveredAgent,
} from '@agent-env/repo-env';
import { isSuccessfulRunState } from '@agent-env/shared';
import { discoveryOptions, listAgents } from './agent-catalog.js';

function printUsage(): never {
  const ids = listAgents()
    .map((a) => `  - ${a.id}: ${a.description}`)
    .join('\n');
  console.log(`Usage: npm run run -- <agent-id> [message...]
       npm run run -- <agent-id> --params ./values.json
       npm run run -- <agent-id> --input key=value
       npm run run -- <agent-id> --auto-approve [message...]

Merge (later wins): params defaults > --params > --input > message.
--auto-approve: auto-grant T2 tools for this run (T3 still requires agent approve).

Agents (discovered; prefer \`npm run admin\` for params forms):
${ids || '  (none found)'}
`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  agentId?: string;
  messageParts: string[];
  inputs: Record<string, string>;
  paramsPath?: string;
  autoApprove: boolean;
} {
  const inputs: Record<string, string> = {};
  const messageParts: string[] = [];
  let agentId: string | undefined;
  let paramsPath: string | undefined;
  let autoApprove = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--auto-approve') {
      autoApprove = true;
      continue;
    }
    if (!agentId) {
      agentId = arg;
      continue;
    }
    if (arg === '--params' || arg.startsWith('--params=')) {
      const raw =
        arg === '--params' ? argv[++i] : arg.slice('--params='.length);
      if (!raw) {
        throw new Error('Invalid --params (expected path to JSON file)');
      }
      paramsPath = raw;
      continue;
    }
    if (arg === '--input' || arg.startsWith('--input=')) {
      const raw =
        arg === '--input' ? argv[++i] : arg.slice('--input='.length);
      if (!raw || !raw.includes('=')) {
        throw new Error(`Invalid --input (expected key=value): ${raw ?? ''}`);
      }
      const eq = raw.indexOf('=');
      inputs[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }
    messageParts.push(arg);
  }
  return { agentId, messageParts, inputs, paramsPath, autoApprove };
}

function loadParamsJson(path: string): Record<string, unknown> {
  const absolute = resolve(process.cwd(), path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(
      `Failed to read --params ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      `--params must be a JSON object of field id → value (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`,
    );
  }
  return parsed as Record<string, unknown>;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (
    !parsed.agentId ||
    parsed.agentId === '-h' ||
    parsed.agentId === '--help'
  ) {
    printUsage();
  }

  const pkg = getResolvedAgentPackage(discoveryOptions(), parsed.agentId);
  if (!pkg) {
    console.error(`Unknown agent: ${parsed.agentId}`);
    printUsage();
  }

  // defaults → --params → --input → positional message
  const params = pkg.params;
  const values: Record<string, unknown> = {
    ...defaultValuesFromParams(params),
  };
  if (parsed.paramsPath) {
    Object.assign(values, loadParamsJson(parsed.paramsPath));
  }
  for (const [key, value] of Object.entries(parsed.inputs)) {
    values[key] = value;
  }
  const message = parsed.messageParts.join(' ').trim();
  if (message) {
    values[params.objectiveField] = message;
  }

  console.log(`▶ ${pkg.id}`);
  if (parsed.paramsPath) {
    console.log(`  params: ${parsed.paramsPath}`);
  }
  if (!pkg.paramsFile) {
    console.log('  params: (in-memory default)');
  }
  if (parsed.autoApprove) {
    console.log('  tool approval: auto (T2)');
  }
  console.log(`  objective field: ${params.objectiveField}`);
  console.log(`  value: ${String(values[params.objectiveField] ?? '')}\n`);

  const result = await runDiscoveredAgent({
    request: {
      agentId: pkg.id,
      objective: 'pending',
      inputs: {},
      attachments: [],
      metadata: {},
    },
    values,
    toolApproval: parsed.autoApprove
      ? { mode: 'auto' }
      : { mode: 'deny' },
  });

  console.log(`  history: ${result.historyDir ?? '(none)'}`);
  console.log('\n=== RunRecord ===');
  console.log(
    JSON.stringify(
      {
        runId: result.record.runId,
        state: result.record.state,
        phase: result.record.phase,
        budgetConsumed: result.record.budgetConsumed,
        error: result.record.error,
      },
      null,
      2,
    ),
  );

  if (result.agentFinalText) {
    console.log('\n=== finalText ===\n' + result.agentFinalText);
  }

  if (!isSuccessfulRunState(result.record.state)) {
    process.exit(2);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
