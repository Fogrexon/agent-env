import {
  createWebSearchConnector,
  defineAgent,
  isProviderConfigured,
  verify,
  type AgentBuildContext,
} from '@agent-env/harness';
import { LlmAgent, type BaseTool } from '@google/adk';

/**
 * Thin showcase: search the web once (or a few times) and answer.
 */
export const agentDefinition = defineAgent({
  id: 'web-qa',
  name: 'Web Q&A',
  description:
    'Search the web and answer — single LlmAgent + search tool only.',
  mode: 'interactive',
  limits: {
    maxSteps: 12,
    maxToolCalls: 8,
    maxWallSeconds: 240,
    maxRepairs: 0,
  },
  verification: {
    checks: [verify.nonEmpty({ severity: 'advisory' })],
  },
  createAgent(context: AgentBuildContext) {
    const hasTavily = Boolean(context.secret('TAVILY_API_KEY')?.trim());
    const hasBrave = Boolean(context.secret('BRAVE_API_KEY')?.trim());

    if (!hasTavily && !hasBrave) {
      throw new Error(
        'web-qa requires TAVILY_API_KEY or BRAVE_API_KEY (host-injected secrets)',
      );
    }

    const tools: BaseTool[] = [];
    if (hasTavily) {
      tools.push(
        createWebSearchConnector({
          id: 'web',
          provider: 'tavily',
          apiKey: () => context.secret('TAVILY_API_KEY'),
          searchDepth: 'basic',
          timeoutMs: 30_000,
        }).createTool(),
      );
    } else {
      tools.push(
        createWebSearchConnector({
          id: 'web',
          provider: 'brave',
          apiKey: () => context.secret('BRAVE_API_KEY'),
          timeoutMs: 30_000,
        }).createTool(),
      );
    }

    const model = isProviderConfigured('cursor')
      ? 'cursor:auto'
      : 'gemini:gemini-3.6-flash';

    return new LlmAgent({
      name: 'web_qa',
      model,
      description: `Web Q&A demo (model=${model}).`,
      instruction: `Answer the user's question using the web search tool when needed.
Keep the answer concise.
Cite source URLs from search results when you rely on them.
Do not invent citations. Prefer 1–3 searches, then answer.`,
      tools,
    });
  },
});
