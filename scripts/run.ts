/**
 * Programmatic agent runner via @agent-env/repo-env discovery.
 *
 * Usage:
 *   npm run run -- <agent-id> [message...]
 *   npm run run -- <agent-id> --params ./values.json
 *   npm run run -- <agent-id> --input key=value --input key2=value2
 *
 * Merge order (later wins): params.yaml defaults → --params file → --input → positional message.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  defaultValuesFromParams,
  runDiscoveredAgent,
} from '@agent-env/repo-env';
import { findAgent, listAgents } from './agent-catalog.js';

function printUsage(): never {
  const ids = listAgents()
    .map((a) => `  - ${a.id}: ${a.description}`)
    .join('\n');
  console.log(`Usage: npm run run -- <agent-id> [message...]
       npm run run -- <agent-id> --params ./values.json
       npm run run -- <agent-id> --input key=value

Merge (later wins): params.yaml defaults > --params > --input > message.

Agents (discovered; prefer \`npm run admin\` for params.yaml forms):
${ids || '  (none found)'}
`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  agentId?: string;
  messageParts: string[];
  inputs: Record<string, string>;
  paramsPath?: string;
} {
  const inputs: Record<string, string> = {};
  const messageParts: string[] = [];
  let agentId: string | undefined;
  let paramsPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
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
  return { agentId, messageParts, inputs, paramsPath };
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

  const manifest = findAgent(parsed.agentId);
  if (!manifest) {
    console.error(`Unknown agent: ${parsed.agentId}`);
    printUsage();
  }

  // defaults → --params → --input → positional message
  const { loadAgentParamsFile } = await import('@agent-env/harness');
  const params = loadAgentParamsFile(manifest.paramsFile!);
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

  console.log(`▶ ${manifest.id}`);
  if (parsed.paramsPath) {
    console.log(`  params: ${parsed.paramsPath}`);
  }
  console.log(`  objective field: ${params.objectiveField}`);
  console.log(`  value: ${String(values[params.objectiveField] ?? '')}\n`);

  const result = await runDiscoveredAgent({
    request: {
      agentId: manifest.id,
      objective: 'pending',
      inputs: {},
      attachments: [],
      metadata: {},
    },
    values,
  });

  console.log(`  history: ${result.historyDir ?? '(none)'}`);
  console.log('\n=== RunRecord ===');
  console.log(
    JSON.stringify(
      {
        runId: result.record.runId,
        state: result.record.state,
        phase: result.record.phase,
        verification: result.record.verification,
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

  if (result.record.state !== 'SUCCEEDED') {
    process.exit(2);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
