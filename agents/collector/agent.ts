import { execFileSync } from 'node:child_process';
import { LlmAgent, ParallelAgent, SequentialAgent, type BaseAgent } from '@google/adk';
import type { DataSourceConnector } from '@agent-env/harness';
import {
  bootstrapProvidersFromEnv,
  createGithubGhConnector,
  createGrokBuildXSearchConnector,
  createSimpleHttpJsonConnector,
  createWebSearchConnectorFromEnv,
  defaultGeminiModelRef,
  getConnector,
  hasConnector,
  loadDotEnv,
  registerConnector,
  registerDemoConnectors,
  resolveModel,
} from '@agent-env/harness';

loadDotEnv();
bootstrapProvidersFromEnv();
registerDemoConnectors();

function cliOk(bin: string, args: string[]): boolean {
  try {
    execFileSync(bin, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (cliOk('gh', ['auth', 'status'])) {
  registerConnector(
    createGithubGhConnector({
      id: 'github',
      repo: process.env['GH_REPO'] ?? undefined,
    }),
    { replace: true },
  );
}

if (process.env['AGENT_ENV_HTTP_DEMO'] !== '0') {
  registerConnector(
    createSimpleHttpJsonConnector({
      id: 'http_posts',
      title: 'HTTP posts demo',
      description: 'JSONPlaceholder posts (public HTTP JSON example).',
      tags: ['http', 'demo'],
      url: 'https://jsonplaceholder.typicode.com/posts',
      titleKey: 'title',
      snippetKey: 'body',
    }),
    { replace: true },
  );
}

// Web search: Tavily preferred (BRAVE optional fallback via env helper).
const web = createWebSearchConnectorFromEnv({ provider: 'tavily' })
  ?? createWebSearchConnectorFromEnv();
if (web) {
  registerConnector(web, { replace: true });
}

// X search via Grok Build headless (subscription auth via `grok login`).
if (
  process.env['AGENT_ENV_GROK_X'] !== '0' &&
  (cliOk('grok', ['--version']) || cliOk('grok', ['--help']))
) {
  registerConnector(
    createGrokBuildXSearchConnector({
      id: 'x',
      model: process.env['AGENT_ENV_GROK_MODEL'],
    }),
    { replace: true },
  );
}

const model = resolveModel(defaultGeminiModelRef());

function collectorAgent(
  connector: DataSourceConnector,
  outputKey: string,
): LlmAgent {
  return new LlmAgent({
    name: `${connector.meta.id}_collector`,
    model,
    description: connector.meta.description,
    instruction: `You gather evidence from "${connector.meta.title}" only.
Call ${connector.meta.contract.name} with a focused query derived from the user topic.
Then output up to 3 bullet findings grounded ONLY in the tool result. No preamble.`,
    tools: [connector.createTool()],
    outputKey,
  });
}

const sources: Array<{ id: string; outputKey: string; label: string }> = [
  { id: 'kb', outputKey: 'kb_findings', label: 'Knowledge base' },
  { id: 'crm', outputKey: 'crm_findings', label: 'CRM' },
  { id: 'status', outputKey: 'status_findings', label: 'Status board' },
];

if (hasConnector('github')) {
  sources.push({
    id: 'github',
    outputKey: 'github_findings',
    label: 'GitHub',
  });
}
if (hasConnector('http_posts')) {
  sources.push({
    id: 'http_posts',
    outputKey: 'http_findings',
    label: 'HTTP',
  });
}
if (hasConnector('web')) {
  sources.push({
    id: 'web',
    outputKey: 'web_findings',
    label: 'Web',
  });
}
if (hasConnector('x')) {
  sources.push({
    id: 'x',
    outputKey: 'x_findings',
    label: 'X',
  });
}

const workers: BaseAgent[] = sources.map(({ id, outputKey }) =>
  collectorAgent(getConnector(id), outputKey),
);

const fanOut = new ParallelAgent({
  name: 'collect_fan_out',
  description: 'Collect evidence from registered data sources in parallel.',
  subAgents: workers,
});

const findingsBlock = sources
  .map((s) => `${s.label} findings:\n{${s.outputKey}}`)
  .join('\n\n');

const sourceNames = sources.map((s) => s.label).join(' / ');

const synthesizer = new LlmAgent({
  name: 'brief_synthesizer',
  model,
  description: 'Merges multi-source evidence into one brief.',
  instruction: `Synthesize a short multi-source briefing.

${findingsBlock}

Rules:
- Ground every claim in the findings above (do not invent sources).
- Structure exactly:
  Overview
  Sources
  Risks
  Recommendation
- Under Sources, name which buckets contributed (${sourceNames}).
- Keep the whole response under 250 words.
- Include the word "verified" once near the end if evidence was present.`,
});

/**
 * Data-source collector orchestration sample.
 * Parallel read connectors → single synthesizer.
 */
export const rootAgent = new SequentialAgent({
  name: 'collector',
  description:
    'Gather from multiple data sources in parallel, then synthesize one brief.',
  subAgents: [fanOut, synthesizer],
});
