/**
 * Offline smoke for HTTP / GitHub(gh) connectors (no live network required).
 */
import {
  clearConnectors,
  createGithubGhConnector,
  createSimpleHttpJsonConnector,
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

console.log('✓ smoke-connectors-http-gh passed');
