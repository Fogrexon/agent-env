/**
 * Run an agent under a versioned RunSpec (Phase A harness + evaluation plane).
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
  createCommandTestSuite,
  createTextLlmGrader,
  getAgentManifest,
  getProvider,
  hasProvider,
  runFromSpec,
  type VerifyContext,
} from '@agent-env/harness';
import {
  bootstrapProvidersFromEnv,
  loadDotEnv,
} from '@agent-env/repo-env';

async function loadRootAgent(
  entry: string,
  artifacts: Record<string, unknown>,
): Promise<BaseAgent> {
  const absolute = resolve(process.cwd(), entry);
  const mod = (await import(pathToFileURL(absolute).href)) as {
    rootAgent?: BaseAgent;
    createRootAgent?: (opts?: {
      artifacts?: Record<string, unknown>;
    }) => BaseAgent;
    briefArtifactSchema?: unknown;
  };

  if (typeof mod.createRootAgent === 'function') {
    return mod.createRootAgent({ artifacts });
  }
  if (!mod.rootAgent) {
    throw new Error(`${entry} must export rootAgent or createRootAgent`);
  }
  return mod.rootAgent;
}

async function buildVerifyContext(
  agentId: string,
  artifacts: Record<string, unknown>,
  entry: string,
): Promise<VerifyContext> {
  const ctx: VerifyContext = {
    artifacts,
    testSuites: {
      // External process check (agent cannot spoof exit code of this child).
      'oracle-process': createCommandTestSuite({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        expectExitCode: 0,
      }),
    },
    custom: {
      brief_has_recommendation: (c) => {
        const brief = c.artifacts?.['brief'] as
          | { recommendation?: string }
          | undefined;
        return Boolean(brief?.recommendation?.trim());
      },
      collector_brief_structure: (c) => {
        const text = c.finalText ?? '';
        const need = ['Overview', 'Sources', 'Risks', 'Recommendation'];
        return need.every((h) => new RegExp(h, 'i').test(text));
      },
    },
  };

  if (agentId === 'runspec-demo') {
    const absolute = resolve(process.cwd(), entry);
    const mod = (await import(pathToFileURL(absolute).href)) as {
      briefArtifactSchema?: VerifyContext['jsonSchemas'] extends
        | Record<string, infer V>
        | undefined
        ? V
        : never;
    };
    if (mod.briefArtifactSchema) {
      ctx.jsonSchemas = { 'brief-v1': mod.briefArtifactSchema };
    }
  }

  // Optional auxiliary grader (never sole gate). Uses a registered provider if present.
  if (hasProvider('gemini') || hasProvider('openai') || hasProvider('anthropic')) {
    const providerId = hasProvider('gemini')
      ? 'gemini'
      : hasProvider('openai')
        ? 'openai'
        : 'anthropic';
    try {
      const provider = getProvider(providerId);
      ctx.llmGrade = createTextLlmGrader({
        generate: async (prompt) => {
          const result = await provider.generate({
            model:
              providerId === 'gemini'
                ? 'gemini-2.5-flash'
                : providerId === 'openai'
                  ? 'gpt-4o-mini'
                  : 'claude-sonnet-4-5',
            messages: [{ role: 'user', text: prompt }],
          });
          return result.text;
        },
      });
    } catch {
      // leave llmGrade unset — criteria without llm_grade still work
    }
  }

  return ctx;
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
  const artifacts: Record<string, unknown> = {};
  const agent = await loadRootAgent(manifest.entry, artifacts);
  const verifyContext = await buildVerifyContext(
    agentId,
    artifacts,
    manifest.entry,
  );

  console.log(`▶ RunSpec → ${manifest.id}`);
  console.log(`  spec: ${specPath}\n`);

  const result = await runFromSpec({
    spec: raw,
    agent,
    verifyContext,
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
        artifacts: Object.keys(artifacts),
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
    process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
