import { execFileSync } from 'node:child_process';
import { LlmAgent, ParallelAgent, SequentialAgent, type BaseAgent } from '@google/adk';
import {
  createArxivConnector,
  createEmitHandoffTool,
  createGithubGhConnector,
  createGrokBuildXSearchConnector,
  createSimpleHttpJsonConnector,
  createWebSearchConnector,
  defineAgent,
  EVIDENCE_BUNDLE_SCHEMA_ID,
  getConnector,
  hasConnector,
  isProviderConfigured,
  registerConnector,
  registerDemoConnectors,
  verify,
  type AgentBuildContext,
  type DataSourceConnector,
} from '@agent-env/harness';
import { evidenceBundleSchema } from '@agent-env/shared';

/**
 * Data-source collector orchestration sample.
 * Parallel read connectors → typed EvidenceBundle handoff → synthesizer.
 * Secrets/config come from AgentBuildContext (host-injected).
 */
export const agentDefinition = defineAgent({
  id: 'collector',
  name: 'Collector',
  description:
    'Gather from multiple data sources in parallel, then synthesize a result-focused brief with links.',
  limits: {
    maxSteps: 24,
    maxToolCalls: 40,
    maxWallSeconds: 600,
    maxRepairs: 0,
  },
  verification: {
    checks: [verify.nonEmpty({ severity: 'advisory' })],
  },
  createAgent(context: AgentBuildContext) {
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
          repo: context.config('GH_REPO') ?? undefined,
        }),
        { replace: true },
      );
    }

    if (context.config('AGENT_ENV_HTTP_DEMO') !== '0') {
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

    const tavilyKey = context.secret('TAVILY_API_KEY')?.trim();
    if (tavilyKey) {
      registerConnector(
        createWebSearchConnector({
          id: 'web',
          provider: 'tavily',
          apiKey: () => context.secret('TAVILY_API_KEY'),
        }),
        { replace: true },
      );
    }

    // Public Atom API — no key. Opt out with AGENT_ENV_ARXIV=0.
    if (context.config('AGENT_ENV_ARXIV') !== '0') {
      registerConnector(
        createArxivConnector({
          id: 'arxiv',
          categories: context
            .config('AGENT_ENV_ARXIV_CAT')
            ?.split(',')
            .map((c) => c.trim())
            .filter(Boolean),
        }),
        { replace: true },
      );
    }

    // X search via Grok Build headless (auth via caller's `grok login`).
    if (
      context.config('AGENT_ENV_GROK_X') !== '0' &&
      (cliOk('grok', ['--version']) || cliOk('grok', ['--help']))
    ) {
      registerConnector(
        createGrokBuildXSearchConnector({
          id: 'x',
          model: context.config('AGENT_ENV_GROK_MODEL'),
        }),
        { replace: true },
      );
    }

    /**
     * Cursor SDK by default (FunctionTools are bridged via customTools);
     * Gemini is the fallback when CURSOR_API_KEY is not set.
     */
    const model = isProviderConfigured('cursor')
      ? 'cursor:auto'
      : 'gemini:gemini-3.6-flash';
    const toolModel = model;
    const synthModel = model;

    function collectorAgent(
      connector: DataSourceConnector,
      outputKey: string,
    ): LlmAgent {
      const emitToolName = `emit_${connector.meta.id}_handoff`;
      const emitHandoff = createEmitHandoffTool({
        name: emitToolName,
        fromAgent: `${connector.meta.id}_collector`,
        toAgent: 'brief_synthesizer',
        outputSchema: EVIDENCE_BUNDLE_SCHEMA_ID,
        payloadSchema: evidenceBundleSchema,
        defaultObjective: `Evidence from ${connector.meta.title}`,
        doneCriteria: [
          'payload is a valid EvidenceBundle',
          'items are grounded in the connector tool result only',
        ],
        description: `Emit a typed EvidenceBundle handoff from ${connector.meta.title} to the synthesizer.`,
      });

      return new LlmAgent({
        name: `${connector.meta.id}_collector`,
        model: toolModel,
        description: connector.meta.description,
        instruction: `You gather evidence from "${connector.meta.title}" only.
Call ${connector.meta.contract.name} with a focused query derived from the user topic
(use a high limit when the topic is broad). You MUST call the tool; do not invent.

Then call ${emitToolName} with:
- objective: short restatement of what you collected for
- contextSummary: 1–3 lines (query used, item count, any empty/error note)
- payloadJson: a JSON EvidenceBundle:
  {
    "sourceId": "${connector.meta.id}",
    "query": "<the query you actually passed>",
    "items": [ { "sourceId", "title", "snippet", "uri"? } … ]
  }
Copy items from the tool result only — do not invent.

Your FINAL assistant message MUST be the envelope string returned by ${emitToolName}
(typed handoff Markdown). If the tool returned status=error, explain briefly and stop.
No preamble about the harness.`,
        tools: [connector.createTool(), emitHandoff],
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
    if (hasConnector('arxiv')) {
      sources.push({
        id: 'arxiv',
        outputKey: 'arxiv_findings',
        label: 'arXiv',
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
      .map((s) => `${s.label} handoff:\n{${s.outputKey}?}`)
      .join('\n\n');

    const sourceNames = sources.map((s) => s.label).join(' / ');

    const synthesizer = new LlmAgent({
      name: 'brief_synthesizer',
      model: synthModel,
      description:
        'Merges multi-source typed handoffs into a light brief: method, content, conclusion, links.',
      instruction: `Write the FINAL briefing. Keep it light but complete — conclusion, how we
collected, what we actually got, and links. Do NOT write per-source subsections that
introduce each connector's data one by one; merge the evidence by topic.

Each source below is a typed handoff envelope (## Handoff + JSON payload with
EvidenceBundle: sourceId, query, items[]). Prefer the JSON payload items over any
prose. Ignore envelopes that are missing or report empty items.

${findingsBlock}

Use exactly these Markdown ATX headings (level 2):

## Conclusion
Answer the user's ask. Ground claims in the findings (do not invent). Note conflicts
briefly. Mention in one clause which of (${sourceNames}) contributed vs were empty.

## Collection method
One short table or bullet list only:
| Source | Tool / query | Items |
drawn from each handoff payload (sourceId / query / items.length). No prose per source beyond the row.

## Collected content
The actual evidence, organized by TOPIC / claim — not by source. Merge overlapping
items across sources into single bullets; keep concrete titles, numbers, dates,
handles, and short quotes.
Every bullet that rests on a URI MUST end with its Markdown link(s) inline, e.g.
… (Web · [Filmarks 期待度](https://…)). Do not leave a topic without its grounding
links. Off-topic / empty sources get no space here.

## Links
Deduped catalog of every usable URI (most relevant first). Each line MUST include:
tool/source label, one short sentence of what the page/post is, then the link:
- **Web** — Filmarks の 2026 夏アニメ期待度ランキング概要。 [title](url)
- **X** — 一話感想の反応例。 [title](url)
Use the connector label (${sourceNames}) as the tool/source tag. Omit entries with no URI.

## Risks / gaps
Missing sources, weak coverage, confidence limits — short.

Rules:
- Ground everything in the handoff payloads above.
- Conclusion first; details follow. Topic bullets carry their own links; ## Links
  is the full catalog with tool + one-line gloss.
- No harness / re-run meta commentary.`,
    });

    return new SequentialAgent({
      name: 'collector',
      description:
        'Gather from multiple data sources in parallel (typed handoffs), then synthesize conclusion + method + collected content + links.',
      subAgents: [fanOut, synthesizer],
    });
  },
});
