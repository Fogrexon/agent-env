/**
 * Run an agent under a versioned RunSpec (Phase A harness).
 *
 * Usage:
 *   npm run run:spec -- agents/runspec-demo/runspec.demo.json
 *   npm run run:spec -- agents/runspec-demo/runspec.demo.json runspec-demo
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BaseAgent } from '@google/adk';
import {
  agentRegistry,
  getAgentManifest,
  loadDotEnv,
  bootstrapProvidersFromEnv,
  runFromSpec,
} from '@agent-env/harness';

async function loadRootAgent(entry: string): Promise<BaseAgent> {
  const absolute = resolve(process.cwd(), entry);
  const mod = (await import(pathToFileURL(absolute).href)) as {
    rootAgent?: BaseAgent;
  };
  if (!mod.rootAgent) {
    throw new Error(`${entry} must export rootAgent`);
  }
  return mod.rootAgent;
}

function printUsage(): never {
  const ids = agentRegistry.map((a) => `  - ${a.id}`).join('\n');
  console.log(`Usage: npm run run:spec -- <runspec.json> [agent-id]

Default agent-id: runspec-demo

Agents:
${ids}
`);
  process.exit(1);
}

async function main(): Promise<void> {
  loadDotEnv();
  bootstrapProvidersFromEnv();

  const specPath = process.argv[2];
  const agentId = process.argv[3] ?? 'runspec-demo';
  if (!specPath || specPath === '-h' || specPath === '--help') {
    printUsage();
  }

  const manifest = getAgentManifest(agentId);
  if (!manifest) {
    console.error(`Unknown agent: ${agentId}`);
    printUsage();
  }

  const raw = JSON.parse(readFileSync(resolve(process.cwd(), specPath), 'utf8'));
  const agent = await loadRootAgent(manifest.entry);

  console.log(`▶ RunSpec → ${manifest.id}`);
  console.log(`  spec: ${specPath}\n`);

  const result = await runFromSpec({
    spec: raw,
    agent,
    onEvent: (event) => {
      if (
        event.eventType === 'run.state_changed' ||
        event.eventType === 'verification.result' ||
        event.eventType === 'budget.exhausted' ||
        event.eventType === 'policy.denied'
      ) {
        console.log(`· ${event.eventType}`, JSON.stringify(event.payload));
      }
    },
  });

  console.log('\n=== RunRecord ===');
  console.log(
    JSON.stringify(
      {
        runId: result.record.runId,
        state: result.record.state,
        phase: result.record.phase,
        verification: result.record.verification,
        budgetConsumed: result.record.budgetConsumed,
        eventCount: result.record.eventCount,
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
