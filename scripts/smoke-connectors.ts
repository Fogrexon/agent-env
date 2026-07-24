/**
 * Offline smoke for data-source connectors (no network / no LLM).
 */
import {
  clearConnectors,
  createMemoryConnector,
  listConnectors,
  registerConnector,
  registerDemoConnectors,
  getConnector,
} from '@agent-env/harness';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

clearConnectors();
registerDemoConnectors();
assert(listConnectors().length === 3, 'demo connectors');

const kb = getConnector('kb');
const bundle = await kb.search({ query: 'VPN', limit: 2 });
assert(bundle.sourceId === 'kb', 'sourceId');
assert(bundle.items.length >= 1, 'kb hits');
assert(
  bundle.items.some((i) => i.title.toLowerCase().includes('vpn')),
  'vpn title',
);

const custom = createMemoryConnector({
  id: 'tickets',
  title: 'Tickets',
  description: 'Fixture tickets',
  records: [{ title: 'T-1', body: 'Cannot login to staging' }],
});
registerConnector(custom, { replace: true });
const tickets = await getConnector('tickets').search({ query: 'login' });
assert(tickets.items[0]?.title === 'T-1', 'custom connector');

console.log('✓ smoke-connectors passed');
