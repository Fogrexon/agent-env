import { execFileSync } from 'node:child_process';
import { LlmAgent, ParallelAgent, SequentialAgent, type BaseAgent } from '@google/adk';
import type { DataSourceConnector } from '@agent-env/harness';
import {
  createArxivConnector,
  createGithubGhConnector,
  createGrokBuildXSearchConnector,
  createSimpleHttpJsonConnector,
  createWebSearchConnector,
  defaultCursorModelRef,
  defaultGeminiModelRef,
  defineAgent,
  getConnector,
  hasConnector,
  registerConnector,
  registerDemoConnectors,
  resolveModel,
  selectModelRef,
  type AgentBuildContext,
} from '@agent-env/harness';

/**
 * Data-source collector orchestration sample.
 * Parallel read connectors → single synthesizer.
 * Secrets/config come from AgentBuildContext (host-injected).
 */
export const agentDefinition = defineAgent({
  id: 'collector',
  name: 'Collector',
  description:
    'Gather from multiple data sources in parallel, then synthesize a result-focused brief with links.',
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
    const cursorOrGemini = selectModelRef(
      defaultCursorModelRef(),
      defaultGeminiModelRef(),
    );
    const toolModel = resolveModel(cursorOrGemini);
    const synthModel = resolveModel(cursorOrGemini);

    function collectorAgent(
      connector: DataSourceConnector,
      outputKey: string,
    ): LlmAgent {
      return new LlmAgent({
        name: `${connector.meta.id}_collector`,
        model: toolModel,
        description: connector.meta.description,
        instruction: `You gather evidence from "${connector.meta.title}" only.
Call ${connector.meta.contract.name} with a focused query derived from the user topic
(use a high limit when the topic is broad). You MUST call the tool; do not invent.
Then output a handoff for the synthesizer (grounded ONLY in the tool result):

## Method
- tool: ${connector.meta.contract.name}
- query: <the query you actually passed>
- items: <count returned>

## Collected
For each returned item (or each relevant one): 1–3 lines with title, key snippet facts
(names / numbers / dates), and uri if any. Do not invent; do not write an essay.

## Links
- [title](url) — one short sentence of what this item is
  (include kb:// / status:// style ids when that is all you have)

If nothing relevant: say so under Collected and leave Links empty.
No preamble about the harness.`,
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
      .map((s) => `${s.label} findings:\n{${s.outputKey}?}`)
      .join('\n\n');

    const sourceNames = sources.map((s) => s.label).join(' / ');

    const synthesizer = new LlmAgent({
      name: 'brief_synthesizer',
      model: synthModel,
      description:
        'Merges multi-source collection into a light brief: method, content, conclusion, links.',
      instruction: `Write the FINAL briefing. Keep it light but complete — conclusion, how we
collected, what we actually got, and links. Do NOT write per-source subsections that
introduce each connector's data one by one; merge the evidence by topic.

${findingsBlock}

Use exactly these Markdown ATX headings (level 2):

## Conclusion
Answer the user's ask. Ground claims in the findings (do not invent). Note conflicts
briefly. Mention in one clause which of (${sourceNames}) contributed vs were empty.

## Collection method
One short table or bullet list only:
| Source | Tool / query | Items |
drawn from each finding's ## Method. No prose per source beyond the row.

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
- Ground everything in the findings above.
- Conclusion first; details follow. Topic bullets carry their own links; ## Links
  is the full catalog with tool + one-line gloss.
- No harness / re-run meta commentary.`,
    });

    return new SequentialAgent({
      name: 'collector',
      description:
        'Gather from multiple data sources in parallel, then synthesize conclusion + method + collected content + links.',
      subAgents: [fanOut, synthesizer],
    });
  },
});
