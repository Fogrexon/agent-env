/**
 * Offline smoke for HTTP / GitHub(gh) / Web search connectors
 * (no live network required).
 */
import {
  clearConnectors,
  createGithubGhConnector,
  createGrokBuildXSearchConnector,
  createSimpleHttpJsonConnector,
  createWebSearchConnector,
  detectWebSearchProviderFromEnv,
  parseGrokXSearchEvidence,
  registerConnector,
} from '@agent-env/harness';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

clearConnectors();

const http = createSimpleHttpJsonConnector({
  id: 'http_demo',
  title: 'HTTP demo',
  description: 'fixture',
  url: 'https://example.test/items?q={query}',
  titleKey: 'name',
  snippetKey: 'text',
  uriKey: 'url',
  fetchImpl: async () =>
    new Response(
      JSON.stringify([
        { name: 'Alpha', text: 'first hit about widgets', url: 'https://ex/a' },
        { name: 'Beta', text: 'second', url: 'https://ex/b' },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
});
registerConnector(http, { replace: true });
const httpBundle = await http.search({ query: 'widgets', limit: 2 });
assert(httpBundle.items.length >= 1, 'http items');
assert(httpBundle.items[0]?.title === 'Alpha', 'http title');

const github = createGithubGhConnector({
  id: 'github',
  repo: 'Fogrexon/agent-env',
  runGh: async (args) => {
    if (args[0] === 'search' && args[1] === 'issues') {
      return JSON.stringify([
        {
          title: 'Add HTTP connectors',
          body: 'Support easy HTTP JSON sources',
          url: 'https://github.com/Fogrexon/agent-env/issues/1',
          number: 1,
          state: 'open',
        },
      ]);
    }
    if (args[0] === 'search' && args[1] === 'prs') {
      return JSON.stringify([]);
    }
    throw new Error(`unexpected gh args: ${args.join(' ')}`);
  },
});
const ghBundle = await github.search({ query: 'HTTP connectors', limit: 3 });
assert(ghBundle.items.length >= 1, 'gh items');
assert(
  ghBundle.items.some((i) => i.title.includes('HTTP connectors')),
  'gh title',
);

let braveAuthHeader = '';
const brave = createWebSearchConnector({
  id: 'web',
  provider: 'brave',
  apiKey: 'brave-test-key',
  fetchImpl: async (input, init) => {
    const url = String(input);
    assert(url.includes('api.search.brave.com'), 'brave url');
    assert(url.includes('q=agent-env'), 'brave query');
    braveAuthHeader = String(
      (init?.headers as Record<string, string>)?.['X-Subscription-Token'] ?? '',
    );
    return new Response(
      JSON.stringify({
        web: {
          results: [
            {
              title: 'Agent env docs',
              url: 'https://example.com/agent-env',
              description:
                'Harness for <strong>parallel</strong> collectors',
            },
          ],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  },
});
const braveBundle = await brave.search({ query: 'agent-env', limit: 3 });
assert(braveAuthHeader === 'brave-test-key', 'brave auth header');
assert(braveBundle.items[0]?.title === 'Agent env docs', 'brave title');
assert(
  braveBundle.items[0]?.snippet.includes('parallel'),
  'brave snippet stripped',
);
assert(!braveBundle.items[0]?.snippet.includes('<strong>'), 'no html');

const tavily = createWebSearchConnector({
  provider: 'tavily',
  apiKey: () => 'tvly-test',
  fetchImpl: async (_input, init) => {
    assert(init?.method === 'POST', 'tavily method');
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      api_key?: string;
      query?: string;
    };
    assert(body.api_key === 'tvly-test', 'tavily key in body');
    assert(body.query === 'typed connectors', 'tavily query');
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'Tavily hit',
            url: 'https://example.com/tavily',
            content: 'typed web search connector',
            score: 0.91,
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  },
});
const tavilyBundle = await tavily.search({
  query: 'typed connectors',
  limit: 2,
});
assert(tavilyBundle.items[0]?.title === 'Tavily hit', 'tavily title');
assert(tavilyBundle.items[0]?.score === 0.91, 'tavily score');

const detected = detectWebSearchProviderFromEnv({
  BRAVE_API_KEY: 'x',
  TAVILY_API_KEY: 'y',
});
assert(detected?.provider === 'tavily', 'prefer tavily when both set');

const parsed = parseGrokXSearchEvidence(
  JSON.stringify({
    result: JSON.stringify({
      items: [
        {
          title: '@xai — launch',
          snippet: 'Grok Build headless X search',
          uri: 'https://x.com/xai/status/1',
          score: 0.88,
        },
      ],
    }),
  }),
  3,
);
assert(parsed[0]?.title.includes('@xai'), 'grok parse title');
assert(parsed[0]?.uri?.includes('x.com'), 'grok parse uri');

let grokArgs: string[] = [];
const x = createGrokBuildXSearchConnector({
  id: 'x',
  runGrok: async (args) => {
    grokArgs = args;
    return JSON.stringify({
      result:
        '{"items":[{"title":"@dev — note","snippet":"typed X connector","uri":"https://x.com/dev/status/2","score":0.7}]}',
    });
  },
});
registerConnector(x, { replace: true });
const xBundle = await x.search({ query: 'agent harness', limit: 2 });
assert(grokArgs.includes('-p'), 'grok -p');
assert(grokArgs.includes('--always-approve'), 'grok always-approve');
assert(grokArgs.includes('--output-format'), 'grok json format');
assert(xBundle.items[0]?.title.includes('@dev'), 'x connector title');
assert(x.meta.kind === 'x', 'x kind');

console.log('✓ smoke-connectors-http-gh passed');
