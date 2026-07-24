/**
 * Programmatic agent runner via @agent-env/harness.
 *
 * Usage:
 *   npm run run -- hello "What time is it?"
 *   npm run run -- parallel-pipeline "Evaluate remote work"
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  agentRegistry,
  getAgentManifest,
  runAgent,
} from '@agent-env/harness';
import type { BaseAgent } from '@google/adk';
import { isFinalResponse, stringifyContent } from '@google/adk';

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
  const ids = agentRegistry.map((a) => `  - ${a.id}: ${a.description}`).join('\n');
  console.log(`Usage: npm run run -- <agent-id> [message]

Agents:
${ids}
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const agentId = process.argv[2];
  const message =
    process.argv.slice(3).join(' ').trim() ||
    'Hello — briefly introduce what you can do.';

  if (!agentId || agentId === '-h' || agentId === '--help') {
    printUsage();
  }

  const manifest = getAgentManifest(agentId);
  if (!manifest) {
    console.error(`Unknown agent: ${agentId}`);
    printUsage();
  }

  const agent = await loadRootAgent(manifest.entry);
  console.log(`▶ ${manifest.id} (${agent.name})`);
  console.log(`  message: ${message}\n`);

  const result = await runAgent({
    agent,
    message,
    onEvent: (event) => {
      if (!isFinalResponse(event)) return;
      const text = stringifyContent(event).trim();
      if (!text) return;
      const author = event.author ?? 'agent';
      console.log(`── ${author} ──\n${text}\n`);
    },
  });

  if (result.status === 'error') {
    console.error(`✗ run failed: ${result.error}`);
    process.exit(2);
  }

  console.log(`✓ finished  session=${result.sessionId}`);
  if (result.finalText) {
    console.log('\n=== final ===\n' + result.finalText);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
